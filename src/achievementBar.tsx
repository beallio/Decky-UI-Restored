// Steam's November 2026 client removed its native mini achievement bar. Draw
// the same stat row from Steam's achievement progress cache instead. The row
// follows the Play Time section so it inherits Steam's own Big Picture layout.

import { routerHook } from "@decky/api";
import type { RoutePatch } from "@decky/api";
import { afterPatch, findClassModule, findInReactTree, Navigation } from "@decky/ui";
import * as log from "./log";

const APP_ROUTE = "/library/app/:appid";
const ROW_CLASS = "decky-steamachievements-mini-achievements";
const LABEL = "Achievements";
const NON_STEAM_APP_TYPE = 1073741824;
// Steam fills the progress cache from an RPC that can outlast one poll.
const CACHE_RETRY_DELAYS_MS = [500, 1_500, 3_000, 6_000, 12_000] as const;
// A route render commits after the route tree resolves, so retry just past it.
const SYNC_RETRY_DELAYS_MS = [0, 50, 250, 1_000] as const;
const MAX_FIBER_DEPTH = 12;
const MAX_FIBER_ANCHORS = 2_000;
const TROPHY_PATH =
  "M7 2h10v4a5 5 0 0 1-4 4.9V14h3v2H6v-2h3v-3.1A5 5 0 0 1 5 6V2h2Zm2 2v2a3 3 0 0 0 6 0V4H9Z";

type AchievementTotals = { unlocked: number; total: number; percentage: number };

type AchievementProgressCache = {
  BGameHasAchievements?: unknown;
  QueueCacheUpdate?: unknown;
  m_achievementProgress?: unknown;
};

type RowParts = { row: HTMLDivElement; count: HTMLDivElement; fill: HTMLDivElement };

type SectionOwner = { appId: number; overview: object | null };

/** Read one private Steam field without letting a throwing getter escape. */
const field = (value: unknown, key: PropertyKey): unknown => {
  try {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
};

const positiveInteger = (value: unknown): number => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
};

// The play bar's CSS module, so the row inherits Steam's stat layout. It is
// looked up on use: the module may not be registered when the plugin loads.
let statsClassesCache: Record<string, string> | undefined;
const statsClasses = (): Record<string, string> => {
  if (!statsClassesCache?.GameStatsSection) {
    try {
      const found = findClassModule(
        (module: unknown) => Boolean(field(module, "GameStat") && field(module, "Playtime")),
      );
      if (found) statsClassesCache = found;
    } catch {
      // A failed lookup keeps the previous classes and retries on the next use.
    }
  }
  return statsClassesCache ?? {};
};

const progressCache = (): AchievementProgressCache | undefined => {
  try {
    const cache = field(globalThis, "appAchievementProgressCache");
    // Every cache member stays optional and is type-checked at each use.
    return cache && typeof cache === "object" ? (cache as AchievementProgressCache) : undefined;
  } catch {
    return undefined;
  }
};

/** Counts Steam shows: owned achievements only, unlike the raw RPC list. */
const totalsFor = (appId: number): AchievementTotals | null => {
  if (appId <= 0) return null;
  try {
    const cache = progressCache();
    if (!cache) return null;
    const hasAchievements = cache.BGameHasAchievements;
    if (typeof hasAchievements === "function" && hasAchievements.call(cache, appId) === false) return null;
    const entry = field(field(cache, "m_achievementProgress"), "mapCache");
    const read = field(entry, "get");
    const progress = typeof read === "function" ? read.call(entry, appId) : undefined;
    if (
      !progress ||
      typeof progress !== "object" ||
      !("unlocked" in progress) ||
      !("total" in progress)
    ) {
      return null;
    }
    const unlocked = Number(progress.unlocked);
    const total = Number(progress.total);
    // Steam can publish a partial RPC row; never draw a fabricated total.
    if (
      !Number.isSafeInteger(unlocked) ||
      !Number.isSafeInteger(total) ||
      unlocked < 0 ||
      total <= 0 ||
      unlocked > total
    ) {
      return null;
    }
    const reported = "percentage" in progress ? Number(progress.percentage) : NaN;
    const percentage = Number.isFinite(reported) ? reported : (unlocked / total) * 100;
    return { unlocked, total, percentage: Math.min(100, Math.max(0, percentage)) };
  } catch {
    return null;
  }
};

const isNonSteamShortcut = (overview: object): boolean => {
  try {
    if (Number(field(overview, "app_type")) === NON_STEAM_APP_TYPE) return true;
    const isShortcut = field(overview, "BIsShortcut");
    if (typeof isShortcut === "function" && isShortcut.call(overview) === true) return true;
  } catch {
    // Unknown shortcut state must not produce a row for a non-Steam app.
    return true;
  }
  return false;
};

/** The game a mounted stats section belongs to, from the fiber that rendered it. */
const ownerFromSection = (section: Element): SectionOwner => {
  try {
    const key = Object.keys(section).find(
      (name) => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"),
    );
    let fiber: unknown = key ? Reflect.get(section, key) : undefined;
    for (let depth = 0; fiber && depth < MAX_FIBER_DEPTH; depth += 1) {
      const props = field(fiber, "memoizedProps");
      const overview = field(props, "overview");
      const details = field(props, "details");
      const overviewAppId = positiveInteger(field(overview, "appid"));
      const detailsAppId = positiveInteger(field(details, "unAppID"));
      // Route props can be remapped by other plugins; the details app id
      // belongs to the mounted section, so it wins when both are present.
      const appId = detailsAppId || overviewAppId;
      if (appId > 0) {
        const exactOverview =
          overview && typeof overview === "object" && (!overviewAppId || overviewAppId === appId)
            ? overview
            : null;
        return { appId, overview: exactOverview };
      }
      fiber = field(fiber, "return");
    }
  } catch {
    // Private fiber fields can disappear while Steam re-renders the page.
  }
  return { appId: 0, overview: null };
};

const buildRow = (document: Document): RowParts => {
  const classes = statsClasses();
  const row = document.createElement("div");
  row.className = [ROW_CLASS, classes.GameStat].filter(Boolean).join(" ");
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  const icon = document.createElement("div");
  icon.className = classes.GameStatIcon ?? "";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 20");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.style.cssText = "display:block;width:16px;height:16px";
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", TROPHY_PATH);
  svg.append(path);
  icon.append(svg);
  const right = document.createElement("div");
  right.className = classes.GameStatRight ?? "";
  const label = document.createElement("div");
  label.className = classes.PlayBarLabel ?? "";
  label.textContent = LABEL;
  const progressRow = document.createElement("div");
  progressRow.className = classes.AchievementProgressRow ?? "";
  const count = document.createElement("div");
  count.className = [classes.PlayBarDetailLabel, classes.AchievementCountLabel].filter(Boolean).join(" ");
  const bar = document.createElement("div");
  bar.style.cssText = "height:2px;margin-top:3px;border-radius:1px;overflow:hidden;background:rgba(255,255,255,.2)";
  const fill = document.createElement("div");
  fill.style.cssText = "height:100%;width:0;background:#67c1f5";
  bar.append(fill);
  progressRow.append(count, bar);
  right.append(label, progressRow);
  row.append(icon, right);
  return { row, count, fill };
};

function getFiberFromElement(element: unknown): unknown {
  if (!element || typeof element !== "object") return undefined;
  try {
    const key = Object.keys(element).find(
      (candidate) => candidate.startsWith("__reactFiber$") || candidate.startsWith("__reactContainer$"),
    );
    return key ? Reflect.get(element, key) : undefined;
  } catch {
    return undefined;
  }
}

function getFiberFromDocument(document: unknown): unknown {
  try {
    const bodyFiber = getFiberFromElement(field(document, "body"));
    if (bodyFiber) return bodyFiber;

    const queryAll = field(document, "querySelectorAll");
    if (typeof queryAll !== "function") return undefined;
    const elements = queryAll.call(document, "*");
    let inspected = 0;
    for (const element of Array.from(elements ?? [])) {
      if (inspected >= MAX_FIBER_ANCHORS) break;
      inspected += 1;
      const fiber = getFiberFromElement(element);
      if (fiber) return fiber;
    }
  } catch {
    // Popup documents can disappear during navigation.
  }
  return undefined;
}

function popupValues(collection: unknown): unknown[] {
  try {
    if (!collection) return [];
    if (Array.isArray(collection)) return collection;
    const values = field(collection, "values");
    if (typeof values === "function") return Array.from(values.call(collection) as Iterable<unknown>);
    const iterator = field(collection, Symbol.iterator);
    if (typeof iterator === "function") return Array.from(collection as Iterable<unknown>);
  } catch {
    // Treat malformed popup collections as empty.
  }
  return [];
}

function isBigPicturePopup(popup: unknown, document: unknown): boolean {
  try {
    return [field(popup, "m_strTitle"), field(popup, "title"), field(field(popup, "m_popup"), "name"), field(document, "title")].some(
      (title) => title === "Steam Big Picture Mode",
    );
  } catch {
    return false;
  }
}

const isDocumentLike = (value: unknown): value is Document =>
  !!value &&
  typeof value === "object" &&
  typeof field(value, "querySelector") === "function" &&
  typeof field(value, "querySelectorAll") === "function" &&
  !!field(value, "body") &&
  typeof field(value, "body") === "object";

/** Locate the app-details document from SharedJSContext's popup manager. */
export function getBigPictureDocument(popupManager: unknown): Document | undefined {
  try {
    const getPopups = field(popupManager, "GetPopups");
    const collection =
      field(popupManager, "m_rgPopups") ??
      (typeof getPopups === "function" ? getPopups.call(popupManager) : undefined);
    const candidates: Array<{ document: Document; isBigPicture: boolean }> = [];

    for (const popup of popupValues(collection)) {
      try {
        const document = field(field(popup, "m_popup"), "document");
        if (!isDocumentLike(document) || !getFiberFromDocument(document)) continue;
        candidates.push({ document, isBigPicture: isBigPicturePopup(popup, document) });
      } catch {
        // Skip individual popups that are closing or malformed.
      }
    }

    return candidates.find((candidate) => candidate.isBigPicture)?.document ?? candidates[0]?.document;
  } catch {
    return undefined;
  }
}

/** Injectable Steam-global boundary used by the route callback. */
export const steamGlobals = {
  getPopupManager(): unknown {
    try {
      return field(window, "g_PopupManager");
    } catch {
      return undefined;
    }
  },
};

let activeDispose: (() => void) | undefined;

/** Install the achievement stat row and return a fail-closed disposer. */
export function installAchievementBarPatch(): () => void {
  if (activeDispose) return activeDispose;

  safeInfo("installing achievement stat row");
  let disposed = false;
  let parts: RowParts | undefined;
  let rowAppId = 0;
  let observer: MutationObserver | undefined;
  let observedSection: Element | undefined;
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  let syncAttempt = 0;
  let unsubscribe: (() => void) | undefined;
  let routePatch: RoutePatch | undefined;
  let routeRenderOwner: unknown;
  let routeRenderPatch: { unpatch: () => void } | undefined;
  const cacheTimers = new Set<ReturnType<typeof setTimeout>>();
  const attemptedAppIds = new Set<number>();

  const removeRow = (): void => {
    try {
      parts?.row.remove();
    } catch {
      // The row's document may already be gone.
    }
    parts = undefined;
    rowAppId = 0;
  };

  const disconnectObserver = (): void => {
    const current = observer;
    observer = undefined;
    observedSection = undefined;
    if (!current) return;
    try {
      current.disconnect();
    } catch {
      // A detached or already-closed observer is harmless.
    }
  };

  const observeSection = (section: Element | undefined): void => {
    if (section === observedSection) return;
    disconnectObserver();
    if (!section) return;
    try {
      const Constructor = section.ownerDocument?.defaultView?.MutationObserver;
      if (typeof Constructor !== "function") return;
      const classes = statsClasses();
      const playBar = classes.PlayBar ? section.closest(`.${classes.PlayBar}`) : null;
      const scope = playBar ?? section.parentElement ?? section;
      observer = new Constructor(() => requestSync());
      // A subtree watch survives Steam replacing the stats section itself.
      observer.observe(scope, { childList: true, subtree: true });
      observedSection = section;
    } catch {
      try {
        observer?.disconnect();
      } catch {
        // A partially armed observer is harmless once released.
      }
      observer = undefined;
      observedSection = undefined;
    }
  };

  const setTimer = (callback: () => void, delay: number): void => {
    if (disposed) return;
    const timer = setTimeout(() => {
      cacheTimers.delete(timer);
      if (!disposed) callback();
    }, delay);
    cacheTimers.add(timer);
  };

  /** Ask Steam to fill a cold cache entry; the row re-reads while it stays empty. */
  const queueCacheUpdate = (appId: number): void => {
    if (attemptedAppIds.has(appId)) return;
    const cache = progressCache();
    const queueUpdate = field(cache, "QueueCacheUpdate");
    if (!cache || typeof queueUpdate !== "function") return;
    attemptedAppIds.add(appId);
    try {
      queueUpdate.call(cache, appId);
      for (const delay of CACHE_RETRY_DELAYS_MS) setTimer(sync, delay);
    } catch (error) {
      attemptedAppIds.delete(appId);
      safeDebug("achievement progress queue failed", appId, error);
    }
  };

  const sync = (): void => {
    if (disposed) return;
    try {
      const section = statsSection();
      observeSection(section);
      if (!section) {
        removeRow();
        return;
      }
      const classes = statsClasses();
      const playtime = classes.Playtime ? section.querySelector(`.${classes.Playtime}`) : null;
      if (!playtime) {
        removeRow();
        return;
      }
      const owner = ownerFromSection(section);
      if (!owner.appId || !owner.overview || isNonSteamShortcut(owner.overview)) {
        removeRow();
        return;
      }
      const totals = totalsFor(owner.appId);
      // Match Steam's guard: no total, or uninstalled with nothing earned.
      if (!totals || (!field(owner.overview, "installed") && totals.unlocked === 0)) {
        removeRow();
        if (!totals) queueCacheUpdate(owner.appId);
        return;
      }
      // Steam's own bar is still present on clients that have not updated yet.
      const nativeBar = classes.MiniAchievements
        ? section.querySelector(`.${classes.MiniAchievements}`)
        : null;
      if (nativeBar) {
        removeRow();
        return;
      }

      const document = playtime.ownerDocument;
      if (!document) {
        removeRow();
        return;
      }
      const current = section.querySelector(`.${ROW_CLASS}`);
      if (!parts || current !== parts.row || rowAppId !== owner.appId) {
        if (current && current !== parts?.row) {
          try {
            current.remove();
          } catch {
            // The previous row may already belong to a detached document.
          }
        }
        removeRow();
        parts = buildRow(document);
        rowAppId = owner.appId;
        const appId = owner.appId;
        const activate = (): void => {
          try {
            Navigation.Navigate(`/library/app/${appId}/achievements/my/individual`);
          } catch (error) {
            safeDebug("achievement navigation failed", error);
          }
        };
        parts.row.addEventListener("click", activate);
        parts.row.addEventListener("keydown", (event: KeyboardEvent) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          activate();
        });
        playtime.after(parts.row);
        if (!parts.row.parentNode) section.append(parts.row);
      }

      const rowParts = parts;
      if (!rowParts) return;
      if (rowParts.row.previousElementSibling !== playtime) playtime.after(rowParts.row);
      const countText = `${totals.unlocked} / ${totals.total}`;
      const width = `${Math.round(totals.percentage)}%`;
      if (rowParts.count.textContent !== countText) rowParts.count.textContent = countText;
      if (rowParts.fill.style.width !== width) rowParts.fill.style.width = width;
    } catch (error) {
      removeRow();
      disconnectObserver();
      safeWarn("achievement stat sync failed", error);
    }
  };

  const scheduleSync = (): void => {
    if (disposed) return;
    const delay = SYNC_RETRY_DELAYS_MS[syncAttempt];
    if (delay === undefined) return;
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      if (disposed) return;
      sync();
      syncAttempt += 1;
      scheduleSync();
    }, delay);
  };

  /** A route render replaces the page, so retry past the new commit. */
  const requestSync = (): void => {
    if (disposed) return;
    if (syncTimer !== undefined) {
      clearTimeout(syncTimer);
      syncTimer = undefined;
    }
    syncAttempt = 0;
    scheduleSync();
  };

  const statsSection = (): Element | undefined => {
    const document = getBigPictureDocument(steamGlobals.getPopupManager());
    const sectionClass = statsClasses().GameStatsSection;
    if (!document || !sectionClass) return undefined;
    try {
      return document.querySelector(`.${sectionClass}`) ?? undefined;
    } catch {
      return undefined;
    }
  };

  const onAchievementsChanged = (appId?: unknown): void => {
    const changed = positiveInteger(appId);
    if (changed) attemptedAppIds.delete(changed);
    else attemptedAppIds.clear();
    requestSync();
  };

  try {
    const apps = field(field(globalThis, "SteamClient"), "Apps");
    const register = field(apps, "RegisterForAchievementChanges");
    if (typeof register === "function") {
      const cleanup = register.call(apps, onAchievementsChanged);
      if (typeof cleanup === "function") unsubscribe = cleanup as () => void;
    }
  } catch (error) {
    safeWarn("achievement change subscription failed", error);
  }

  requestSync();

  const unpatchRouteRender = (): void => {
    const patch = routeRenderPatch;
    routeRenderPatch = undefined;
    routeRenderOwner = undefined;
    if (!patch) return;
    try {
      patch.unpatch();
    } catch (error) {
      safeWarn("route render trigger unpatch failed", error);
    }
  };

  try {
    routePatch = routerHook.addPatch(APP_ROUTE, (tree) => {
      if (disposed) return tree;
      try {
        const owner = findInReactTree(tree, (node: unknown) => typeof field(node, "renderFunc") === "function");
        if (owner) {
          if (owner !== routeRenderOwner) {
            unpatchRouteRender();
            const patch = afterPatch(owner, "renderFunc", (_args: unknown[], rendered: unknown): unknown => {
              requestSync();
              return rendered;
            });
            if (patch) {
              routeRenderPatch = patch;
              routeRenderOwner = owner;
            }
          }
          // Covers installation while an app-details page is already committed.
          requestSync();
        }
      } catch (error) {
        safeWarn("route render trigger installation failed", error);
      }
      return tree;
    });
  } catch (error) {
    safeWarn("route patch registration failed", error);
  }

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (activeDispose === dispose) activeDispose = undefined;
    removeRow();
    disconnectObserver();
    if (syncTimer !== undefined) {
      clearTimeout(syncTimer);
      syncTimer = undefined;
    }
    for (const timer of cacheTimers) clearTimeout(timer);
    cacheTimers.clear();
    attemptedAppIds.clear();
    unpatchRouteRender();
    if (routePatch) {
      try {
        routerHook.removePatch(APP_ROUTE, routePatch);
      } catch (error) {
        safeWarn("route patch removal failed", error);
      }
      routePatch = undefined;
    }
    if (unsubscribe) {
      const release = unsubscribe;
      unsubscribe = undefined;
      try {
        release();
      } catch (error) {
        safeWarn("achievement change unsubscription failed", error);
      }
    }
    safeInfo("achievement stat row removed");
  };

  activeDispose = dispose;
  return dispose;
}

function safeDebug(...args: unknown[]): void {
  try {
    log.debug("patch", ...args);
  } catch {
    // Logging must never escape into Steam's render path.
  }
}

function safeInfo(...args: unknown[]): void {
  try {
    log.info("patch", ...args);
  } catch {
    // Logging must never make installation or cleanup fail.
  }
}

function safeWarn(...args: unknown[]): void {
  try {
    log.warn("patch", ...args);
  } catch {
    // Logging must never escape into Steam's render path.
  }
}
