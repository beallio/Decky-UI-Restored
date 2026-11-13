// Steam's November 2026 Gaming Mode game page passes no onSeek to its stats
// section, and Valve's MiniAchievements row renders nothing without one
// (ValveSoftware/steam-for-linux#13540). Supply a no-op so Steam draws, styles,
// fills, and gates its own row. Approach shared with Decky Metadata.

import { routerHook } from "@decky/api";
import type { RoutePatch } from "@decky/api";
import { afterPatch, findClassModule, findInReactTree } from "@decky/ui";
import * as log from "./log";

const GAME_DETAIL_ROUTES = [
  "/library/app/:appid",
  "/library/details/:appid",
  "/library/:collection/app/:appid",
] as const;
const NON_STEAM_APP_TYPE = 1073741824;
// A route render commits after the route tree resolves, so retry just past it.
const SYNC_RETRY_DELAYS_MS = [0, 50, 250, 1_000] as const;
const MAX_FIBER_DEPTH = 12;
const MAX_FIBER_ANCHORS = 2_000;

type StatsInstance = { props?: unknown; forceUpdate?: () => void };

// Valve's row only checks this for truthiness and opens My Achievements itself.
const NOOP_SEEK = (): void => {};

/** Read one private Steam field without letting a throwing getter escape. */
const field = (value: unknown, key: PropertyKey): unknown => {
  try {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
};

// The play bar's CSS module. It is looked up on use: the module may not be
// registered when the plugin loads.
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

const isNonSteamShortcut = (overview: unknown): boolean => {
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

// Repeated reads must return the same object so React prop comparisons stay stable.
const seekProps = new WeakMap<object, object>();

const withSeek = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object") return raw;
  // Older clients pass their own onSeek; leave that row untouched.
  if (field(raw, "onSeek")) return raw;
  if (isNonSteamShortcut(field(raw, "overview"))) return raw;
  const cached = seekProps.get(raw);
  if (cached) return cached;
  const injected = { ...(raw as Record<string, unknown>), onSeek: NOOP_SEEK };
  seekProps.set(raw, injected);
  return injected;
};

/** The mounted stats component that owns a rendered section, from its fiber. */
const ownerInstance = (section: Element): StatsInstance | undefined => {
  try {
    const key = Object.keys(section).find(
      (name) => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"),
    );
    let fiber: unknown = key ? Reflect.get(section, key) : undefined;
    for (let depth = 0; fiber && depth < MAX_FIBER_DEPTH; depth += 1) {
      const stateNode = field(fiber, "stateNode");
      if (
        stateNode &&
        typeof stateNode === "object" &&
        typeof field(stateNode, "BUserHasContentToClaim") === "function" &&
        typeof field(stateNode, "forceUpdate") === "function"
      ) {
        return stateNode as StatsInstance;
      }
      fiber = field(fiber, "return");
    }
  } catch {
    // Private fiber fields can disappear while Steam re-renders the page.
  }
  return undefined;
};

const rerender = (instance: StatsInstance): void => {
  try {
    instance.forceUpdate?.();
  } catch (error) {
    safeDebug("achievement stat rerender failed", error);
  }
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

/** Install the onSeek supply and return a fail-closed disposer. */
export function installAchievementBarPatch(): () => void {
  if (activeDispose) return activeDispose;

  safeInfo("installing achievement stat onSeek supply");
  let disposed = false;
  let observer: MutationObserver | undefined;
  let observedSection: Element | undefined;
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  let syncAttempt = 0;
  // Patched instance → its latest real props, for restore on teardown.
  const patched = new Map<StatsInstance, () => unknown>();
  const routes: Array<{ route: string; patch?: RoutePatch; owner?: unknown; render?: { unpatch: () => void } }> = [];

  const patchInstance = (instance: StatsInstance): void => {
    if (patched.has(instance)) return;
    // React owns this property; if it is not reassignable the accessor cannot survive.
    const descriptor = Object.getOwnPropertyDescriptor(instance, "props");
    if (!descriptor || !("value" in descriptor) || !descriptor.configurable) {
      safeDebug("achievement stat props are not patchable");
      return;
    }
    let raw: unknown = descriptor.value;
    try {
      Object.defineProperty(instance, "props", {
        configurable: true,
        enumerable: true,
        get: () => withSeek(raw),
        set: (value: unknown) => {
          raw = value;
        },
      });
    } catch (error) {
      safeDebug("achievement stat props patch failed", error);
      return;
    }
    patched.set(instance, () => raw);
    rerender(instance);
  };

  const restoreInstance = (instance: StatsInstance, raw: unknown): void => {
    try {
      // Hand the latest real props back so Valve's row hides without a reload.
      Object.defineProperty(instance, "props", {
        value: raw,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    } catch (error) {
      safeDebug("achievement stat props restore failed", error);
    }
    rerender(instance);
  };

  const disconnectObserver = (): void => {
    const current = observer;
    observer = undefined;
    observedSection = undefined;
    try {
      current?.disconnect();
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
      const playBarClass = statsClasses().PlayBar;
      const playBar = playBarClass ? section.closest(`.${playBarClass}`) : null;
      observer = new Constructor(() => requestSync());
      // A subtree watch survives Steam replacing the stats section itself.
      observer.observe(playBar ?? section.parentElement ?? section, { childList: true, subtree: true });
      observedSection = section;
    } catch {
      disconnectObserver();
    }
  };

  /** Patch every mounted stats section; true once one was found. */
  const sync = (): boolean => {
    if (disposed) return true;
    try {
      const sectionClass = statsClasses().GameStatsSection;
      const document = getBigPictureDocument(steamGlobals.getPopupManager());
      if (!sectionClass || !document) return false;
      const sections = Array.from(document.querySelectorAll(`.${sectionClass}`));
      const mounted = new Set<StatsInstance>();
      for (const section of sections) {
        const instance = ownerInstance(section);
        if (!instance) continue;
        mounted.add(instance);
        patchInstance(instance);
      }
      // Unmounted instances need no restore; drop them so they can be collected.
      for (const instance of patched.keys()) if (!mounted.has(instance)) patched.delete(instance);
      observeSection(sections[0]);
      return mounted.size > 0;
    } catch (error) {
      safeWarn("achievement stat sync failed", error);
      return true;
    }
  };

  const scheduleSync = (): void => {
    if (disposed || syncTimer !== undefined) return;
    const delay = SYNC_RETRY_DELAYS_MS[syncAttempt];
    if (delay === undefined) return;
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      if (sync() || disposed) return;
      syncAttempt += 1;
      scheduleSync();
    }, delay);
  };

  /** A route render replaces the page, so its retry burst starts over at once. */
  const requestSync = (): void => {
    if (disposed) return;
    if (syncTimer !== undefined) {
      clearTimeout(syncTimer);
      syncTimer = undefined;
    }
    syncAttempt = 0;
    scheduleSync();
  };

  requestSync();

  const unpatchRender = (entry: (typeof routes)[number]): void => {
    const render = entry.render;
    entry.render = undefined;
    entry.owner = undefined;
    try {
      render?.unpatch();
    } catch (error) {
      safeWarn("route render trigger unpatch failed", error);
    }
  };

  for (const route of GAME_DETAIL_ROUTES) {
    try {
      const entry: (typeof routes)[number] = { route };
      entry.patch = routerHook.addPatch(route, (tree) => {
        if (disposed) return tree;
        try {
          const owner = findInReactTree(tree, (node: unknown) => typeof field(node, "renderFunc") === "function");
          if (owner && owner !== entry.owner) {
            unpatchRender(entry);
            const render = afterPatch(owner, "renderFunc", (_args: unknown[], rendered: unknown): unknown => {
              requestSync();
              return rendered;
            });
            if (render) {
              entry.render = render;
              entry.owner = owner;
            }
          }
          // Covers installation while an app-details page is already committed.
          if (owner) requestSync();
        } catch (error) {
          safeWarn("route render trigger installation failed", error);
        }
        return tree;
      });
      routes.push(entry);
    } catch (error) {
      safeWarn("route patch registration failed", route, error);
    }
  }

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (activeDispose === dispose) activeDispose = undefined;
    disconnectObserver();
    if (syncTimer !== undefined) {
      clearTimeout(syncTimer);
      syncTimer = undefined;
    }
    for (const [instance, raw] of patched) restoreInstance(instance, raw());
    patched.clear();
    for (const entry of routes.splice(0)) {
      unpatchRender(entry);
      try {
        if (entry.patch) routerHook.removePatch(entry.route, entry.patch);
      } catch (error) {
        safeWarn("route patch removal failed", error);
      }
    }
    safeInfo("achievement stat onSeek supply removed");
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
