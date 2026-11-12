// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

const mocks = vi.hoisted(() => ({
  addPatch: vi.fn(),
  removePatch: vi.fn(),
  afterPatch: vi.fn(),
  findClassModule: vi.fn(),
  findInReactTree: vi.fn(),
  navigate: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

const classes = {
  GameStat: "game-stat",
  GameStatsSection: "stats-section",
  Playtime: "playtime",
  GameStatIcon: "stat-icon",
  GameStatRight: "stat-right",
  PlayBar: "play-bar",
  MiniAchievements: "mini-achievements",
  AchievementProgressRow: "progress-row",
  AchievementCountLabel: "achievement-count",
  PlayBarLabel: "bar-label",
  PlayBarDetailLabel: "bar-detail",
};

vi.mock("@decky/ui", () => ({
  afterPatch: mocks.afterPatch,
  findClassModule: mocks.findClassModule,
  findInReactTree: mocks.findInReactTree,
  Navigation: { Navigate: mocks.navigate },
}));

vi.mock("@decky/api", () => ({
  routerHook: { addPatch: mocks.addPatch, removePatch: mocks.removePatch },
}));

vi.mock("./log", () => ({
  debug: mocks.debug,
  info: mocks.info,
  warn: mocks.warn,
}));

import { getBigPictureDocument, installAchievementBarPatch, steamGlobals } from "./achievementBar";

const APP_ID = 1942280;
const SECOND_APP_ID = 1145360;
const ROW_CLASS = "decky-steamachievements-mini-achievements";
const APP_ROUTE = "/library/app/:appid";

type PatchRecord = {
  target: { [key: string]: unknown };
  method: string;
  unpatch: Mock;
};

type RouteRecord = {
  route: string;
  callback: (tree: unknown) => unknown;
};

let patchRecords: PatchRecord[] = [];
let routeRecords: RouteRecord[] = [];
let onAchievementChange: ((appId?: unknown) => void) | undefined;
let registerAchievements: Mock;
let unregisterAchievements: Mock;
let dispose: (() => void) | undefined;

const popup = (document: unknown, title = "Steam Big Picture Mode") => ({
  m_strTitle: title,
  m_popup: { document },
});

const popupManager = (document: unknown) => ({
  m_rgPopups: new Map([["bpm", popup(document)]]),
});

const progress = (unlocked: number, total: number, percentage: number | undefined) => ({
  appid: APP_ID,
  unlocked,
  total,
  percentage,
});

const installCache = (entry?: unknown, appId = APP_ID) => {
  const mapCache = new Map<number, unknown>();
  if (entry !== undefined) mapCache.set(appId, entry);
  const hasAchievements = vi.fn((): boolean => true);
  const queueUpdate = vi.fn();
  Object.defineProperty(globalThis, "appAchievementProgressCache", {
    configurable: true,
    value: {
      BGameHasAchievements: hasAchievements,
      QueueCacheUpdate: queueUpdate,
      m_achievementProgress: { mapCache },
    },
  });
  return { mapCache, hasAchievements, queueUpdate };
};

const installSteamClient = () => {
  registerAchievements = vi.fn((listener: (appId?: unknown) => void) => {
    onAchievementChange = listener;
    return unregisterAchievements;
  });
  Object.defineProperty(globalThis, "SteamClient", {
    configurable: true,
    value: { Apps: { RegisterForAchievementChanges: registerAchievements } },
  });
};

const findNode = (node: unknown, filter: (candidate: unknown) => unknown): unknown => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, filter);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== "object") return undefined;
  if (filter(node)) return node;
  for (const key of ["props", "children", "child", "sibling"]) {
    const found = findNode(Reflect.get(node, key), filter);
    if (found) return found;
  }
  return undefined;
};

const installPatcher = () => {
  mocks.afterPatch.mockImplementation(
    (
      target: { [key: string]: unknown },
      method: string,
      handler: (this: unknown, args: unknown[], result: unknown) => unknown,
    ) => {
      const original = target[method];
      if (typeof original === "function") {
        target[method] = function (this: unknown, ...args: unknown[]) {
          const result = original.apply(this, args);
          return handler.call(this, args, result);
        };
      }
      const unpatch = vi.fn(() => {
        if (typeof original === "function") target[method] = original;
      });
      patchRecords.push({ target, method, unpatch });
      return { unpatch };
    },
  );
};

const mountSection = (
  appId = APP_ID,
  overrides: Record<string, unknown> = {},
  detailsAppId?: number,
  parent: HTMLElement = document.body,
) => {
  const section = document.createElement("div");
  section.className = classes.GameStatsSection;
  const lastPlayed = document.createElement("div");
  lastPlayed.className = classes.GameStat;
  lastPlayed.textContent = "Last Played";
  const playtime = document.createElement("div");
  playtime.className = `${classes.GameStat} ${classes.Playtime}`;
  section.append(lastPlayed, playtime);
  parent.append(section);
  const props: Record<string, unknown> = {
    overview: { appid: appId, installed: true, app_type: 1, ...overrides },
  };
  if (detailsAppId) props.details = { unAppID: detailsAppId };
  Reflect.set(section, "__reactFiber$test", { memoizedProps: props, return: null });
  return { lastPlayed, playtime, section };
};

const install = () => {
  const nextDispose = installAchievementBarPatch();
  vi.advanceTimersByTime(0);
  return nextDispose;
};

const row = (root: ParentNode = document): HTMLElement | null =>
  root.querySelector(`.${ROW_CLASS}`);

const countText = (element: Element) =>
  element.querySelector(`.${classes.AchievementCountLabel}`)?.textContent ?? "";

const fillWidth = (element: Element) =>
  Array.from(element.querySelectorAll<HTMLDivElement>("div")).find(
    (child) => child.style.height === "100%",
  )?.style.width;

const applyRoute = (owner: object) => {
  const callback = routeRecords[0]?.callback;
  return callback?.({ props: owner });
};

const invalidProgressEntries: Array<[string, unknown]> = [
  ["a zero total", progress(0, 0, 0)],
  ["a fractional total", progress(0, 1.5, 0)],
  ["a non-numeric total", { appid: APP_ID, unlocked: 1, total: "many", percentage: 0 }],
  ["a missing total", { appid: APP_ID, unlocked: 1, percentage: 0 }],
  ["more unlocked than total", progress(5, 4, 100)],
];

const nonSteamOverrides: Array<[string, Record<string, unknown>]> = [
  ["a non-Steam app type", { app_type: 1073741824 }],
  ["an explicit shortcut flag", { BIsShortcut: () => true }],
];

const routeRenderPatches = (owner: object) =>
  patchRecords.filter((record) => record.target === owner && record.method === "renderFunc");

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  document.body.innerHTML = "";
  Reflect.deleteProperty(globalThis, "SteamClient");
  Reflect.deleteProperty(globalThis, "appAchievementProgressCache");
  patchRecords = [];
  routeRecords = [];
  onAchievementChange = undefined;
  unregisterAchievements = vi.fn();
  Reflect.set(document.body, "__reactFiber$test", { memoizedProps: {}, return: null });

  mocks.findClassModule.mockImplementation((filter: (module: unknown) => boolean) =>
    filter(classes) ? classes : undefined,
  );
  mocks.findInReactTree.mockImplementation(findNode);
  installPatcher();
  mocks.addPatch.mockImplementation((route: string, callback: RouteRecord["callback"]) => {
    const record = { route, callback };
    routeRecords.push(record);
    return record;
  });
  mocks.removePatch.mockImplementation((_route: string, record: RouteRecord) => {
    routeRecords = routeRecords.filter((candidate) => candidate !== record);
  });
  vi.spyOn(steamGlobals, "getPopupManager").mockReturnValue(popupManager(document));
  installSteamClient();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "SteamClient");
  Reflect.deleteProperty(globalThis, "appAchievementProgressCache");
});

describe("getBigPictureDocument", () => {
  const documentWithFiber = (title: string) => {
    const created = document.implementation.createHTMLDocument(title);
    Reflect.set(created.body, "__reactFiber$test", { memoizedProps: {}, return: null });
    return created;
  };

  it("prefers the Big Picture popup over other popups", () => {
    const fallback = documentWithFiber("Overlay");
    const bpm = documentWithFiber("Big Picture");
    const manager = {
      m_rgPopups: new Map([
        ["fallback", popup(fallback, "Overlay")],
        ["bpm", popup(bpm, "Steam Big Picture Mode")],
      ]),
    };

    expect(getBigPictureDocument(manager)).toBe(bpm);
  });

  it("recognizes a Big Picture popup titled on the popup object", () => {
    const fallback = documentWithFiber("Overlay");
    const bpm = documentWithFiber("Big Picture");
    const manager = {
      m_rgPopups: [
        { title: "Overlay", m_popup: { document: fallback } },
        { title: "Steam Big Picture Mode", m_popup: { document: bpm } },
      ],
    };

    expect(getBigPictureDocument(manager)).toBe(bpm);
  });

  it("supports GetPopups and falls back to any popup with a fiber", () => {
    const noFiber = document.implementation.createHTMLDocument("No fiber anchor");
    const fallback = documentWithFiber("Other");
    const manager = {
      GetPopups: () => [popup(noFiber, "Steam Big Picture Mode"), popup(fallback)],
    };

    expect(getBigPictureDocument(manager)).toBe(fallback);
  });

  it("iterates the popup generator current Steam returns", () => {
    const bpm = documentWithFiber("Big Picture");
    const manager = {
      GetPopups: function* () {
        yield popup(bpm, "Steam Big Picture Mode");
      },
    };

    expect(getBigPictureDocument(manager)).toBe(bpm);
  });

  it("finds a queryable fiber anchor when the body has none", () => {
    const created = document.implementation.createHTMLDocument("Anchored");
    const anchor = created.createElement("div");
    created.body.append(anchor);
    Reflect.set(anchor, "__reactFiber$test", { memoizedProps: {}, return: null });

    expect(getBigPictureDocument({ m_rgPopups: [popup(created)] })).toBe(created);
  });

  it.each([
    undefined,
    {},
    { m_rgPopups: [] },
    { m_rgPopups: [null, {}, { m_popup: { document: {} } }] },
  ])("returns undefined for malformed manager %s", (manager) => {
    expect(() => getBigPictureDocument(manager)).not.toThrow();
    expect(getBigPictureDocument(manager)).toBeUndefined();
  });
});

describe("achievement stat row", () => {
  it("draws Steam's counts right after Play Time when the native bar is gone", () => {
    const cache = installCache(progress(80, 179, 44.7));
    const { playtime, section } = mountSection();

    dispose = install();
    const inserted = row(section);

    expect(inserted).not.toBeNull();
    expect(inserted?.previousElementSibling).toBe(playtime);
    expect(inserted?.classList.contains(classes.GameStat)).toBe(true);
    expect(inserted?.getAttribute("role")).toBe("button");
    expect(inserted?.tabIndex).toBe(0);
    expect(countText(inserted as Element)).toBe("80 / 179");
    expect(fillWidth(inserted as Element)).toBe("45%");
    expect(cache.queueUpdate).not.toHaveBeenCalled();
  });

  it("opens the native achievements page by click and keyboard", () => {
    installCache(progress(80, 179, 44.7));
    const { section } = mountSection();
    dispose = install();
    const inserted = row(section) as HTMLElement;

    inserted.click();
    expect(mocks.navigate).toHaveBeenLastCalledWith(
      `/library/app/${APP_ID}/achievements/my/individual`,
    );

    inserted.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    inserted.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(mocks.navigate).toHaveBeenCalledTimes(3);
  });

  it("asks Steam to fill a cold progress cache and shows the counts afterwards", () => {
    const cache = installCache();
    const { section } = mountSection();

    dispose = install();
    expect(row(section)).toBeNull();
    expect(cache.queueUpdate).toHaveBeenCalledWith(APP_ID);

    cache.mapCache.set(APP_ID, progress(80, 179, 44.7));
    vi.advanceTimersByTime(500);

    expect(row(section)).not.toBeNull();
    expect(countText(row(section) as Element)).toBe("80 / 179");
    expect(cache.queueUpdate).toHaveBeenCalledTimes(1);
  });

  it("polls past the first retry when Steam answers the cache request late", () => {
    const cache = installCache();
    const { section } = mountSection();

    dispose = install();
    vi.advanceTimersByTime(500);
    expect(row(section)).toBeNull();

    // No DOM mutation: only the bounded poll can reveal the late cache entry.
    cache.mapCache.set(APP_ID, progress(80, 179, 44.7));
    vi.advanceTimersByTime(1_000);

    expect(row(section)).not.toBeNull();
    expect(countText(row(section) as Element)).toBe("80 / 179");
    expect(cache.queueUpdate).toHaveBeenCalledTimes(1);
  });

  it("refreshes the shown counts when Steam reports an achievement change", () => {
    const cache = installCache(progress(80, 179, 44.7));
    const { section } = mountSection();
    dispose = install();
    expect(row(section)).not.toBeNull();

    cache.mapCache.set(APP_ID, progress(81, 179, undefined));
    onAchievementChange?.(APP_ID);
    vi.advanceTimersByTime(0);

    expect(countText(row(section) as Element)).toBe("81 / 179");
    expect(fillWidth(row(section) as Element)).toBe("45%");
  });

  it.each(invalidProgressEntries)("hides instead of fabricating data for %s", (_name, entry) => {
    installCache(entry);
    const { section } = mountSection();

    dispose = install();

    expect(row(section)).toBeNull();
  });

  it("stays hidden when Steam marks the game as having no achievements", () => {
    const cache = installCache(progress(0, 2, 0));
    cache.hasAchievements.mockReturnValue(false);
    const { section } = mountSection();

    dispose = install();

    expect(row(section)).toBeNull();
  });

  it("stays hidden when Steam's achievement probe throws", () => {
    const cache = installCache(progress(80, 179, 44.7));
    cache.hasAchievements.mockImplementation(() => {
      throw new Error("cache unavailable");
    });
    const { section } = mountSection();

    dispose = install();

    expect(row(section)).toBeNull();
  });

  it("preserves the uninstalled zero-progress guard but shows earned progress", () => {
    const cache = installCache(progress(0, 49, 0));
    const { section } = mountSection(APP_ID, { installed: undefined });

    dispose = install();
    expect(row(section)).toBeNull();

    cache.mapCache.set(APP_ID, progress(12, 49, 24.5));
    onAchievementChange?.(APP_ID);
    vi.advanceTimersByTime(0);

    expect(row(section)).not.toBeNull();
    expect(countText(row(section) as Element)).toBe("12 / 49");
  });

  it.each(nonSteamOverrides)("fails closed for %s", (_name, overrides) => {
    const cache = installCache(progress(80, 179, 44.7));
    const { section } = mountSection(APP_ID, overrides);

    dispose = install();

    expect(row(section)).toBeNull();
    expect(cache.queueUpdate).not.toHaveBeenCalled();
  });

  it("fails closed when the fiber overview belongs to a different app", () => {
    installCache(progress(80, 179, 44.7));
    const { section } = mountSection(APP_ID, { appid: SECOND_APP_ID }, APP_ID);

    dispose = install();

    expect(row(section)).toBeNull();
  });

  it("leaves Steam's own bar alone and restores the row if that bar disappears", () => {
    installCache(progress(80, 179, 44.7));
    const { section } = mountSection();
    const nativeBar = document.createElement("div");
    nativeBar.className = classes.MiniAchievements;
    section.append(nativeBar);

    dispose = install();
    expect(row(section)).toBeNull();

    nativeBar.remove();
    onAchievementChange?.();
    vi.advanceTimersByTime(0);
    expect(row(section)).not.toBeNull();
  });

  it("follows the stats section across games without leaving a duplicate row", () => {
    const cache = installCache(progress(80, 179, 44.7));
    const first = mountSection();
    dispose = install();
    expect(row(first.section)).not.toBeNull();

    first.section.remove();
    const second = mountSection(SECOND_APP_ID, { appid: SECOND_APP_ID });
    cache.mapCache.set(SECOND_APP_ID, progress(1, 2, 50));
    onAchievementChange?.(SECOND_APP_ID);
    vi.advanceTimersByTime(0);

    expect(document.querySelectorAll(`.${ROW_CLASS}`)).toHaveLength(1);
    expect(first.section.querySelector(`.${ROW_CLASS}`)).toBeNull();
    const inserted = row(second.section) as HTMLElement;
    expect(inserted.previousElementSibling).toBe(second.playtime);
    expect(countText(inserted)).toBe("1 / 2");
    inserted.click();
    expect(mocks.navigate).toHaveBeenLastCalledWith(
      `/library/app/${SECOND_APP_ID}/achievements/my/individual`,
    );
  });

  it("rebuilds the row when the same stats section switches games", () => {
    const cache = installCache(progress(80, 179, 44.7));
    const mounted = mountSection();
    dispose = install();
    expect(countText(row(mounted.section) as Element)).toBe("80 / 179");

    cache.mapCache.set(SECOND_APP_ID, progress(1, 2, 50));
    Reflect.set(mounted.section, "__reactFiber$test", {
      memoizedProps: {
        overview: { appid: SECOND_APP_ID, installed: true, app_type: 1 },
      },
      return: null,
    });
    onAchievementChange?.(SECOND_APP_ID);
    vi.advanceTimersByTime(0);

    expect(mounted.section.querySelectorAll(`.${ROW_CLASS}`)).toHaveLength(1);
    const inserted = row(mounted.section) as HTMLElement;
    expect(countText(inserted)).toBe("1 / 2");
    inserted.click();
    expect(mocks.navigate).toHaveBeenLastCalledWith(
      `/library/app/${SECOND_APP_ID}/achievements/my/individual`,
    );
  });

  it("removes its row when the stats section or Big Picture document disappears", () => {
    installCache(progress(80, 179, 44.7));
    const { section } = mountSection();
    dispose = install();
    expect(row(section)).not.toBeNull();

    section.remove();
    onAchievementChange?.();
    vi.advanceTimersByTime(0);
    expect(section.querySelector(`.${ROW_CLASS}`)).toBeNull();

    mountSection();
    onAchievementChange?.();
    vi.advanceTimersByTime(0);
    expect(document.querySelector(`.${ROW_CLASS}`)).not.toBeNull();

    vi.mocked(steamGlobals.getPopupManager).mockReturnValue(undefined);
    onAchievementChange?.();
    vi.advanceTimersByTime(0);
    expect(document.querySelector(`.${ROW_CLASS}`)).toBeNull();
  });

  it("removes the row when the whole PlayBar is detached without an event", () => {
    installCache(progress(80, 179, 44.7));
    const playBar = document.createElement("div");
    playBar.className = classes.PlayBar;
    document.body.append(playBar);
    const { section } = mountSection(APP_ID, {}, undefined, playBar);

    dispose = install();
    // Retries chain cumulatively: 0 + 50 + 250 + 1000 = 1300 ms.
    vi.advanceTimersByTime(2_000);
    const inserted = row(section);
    expect(inserted).not.toBeNull();

    playBar.remove();
    expect(inserted?.isConnected).toBe(false);
    vi.advanceTimersByTime(1_000);

    expect(section.querySelector(`.${ROW_CLASS}`)).toBeNull();
  });

  it("retries after a route render when the page's stats section commits late", () => {
    installCache(progress(80, 179, 44.7));
    dispose = install();
    vi.runAllTimers();
    expect(document.querySelector(`.${ROW_CLASS}`)).toBeNull();

    const { section } = mountSection();
    const owner = { renderFunc: vi.fn(() => null) };
    applyRoute(owner);
    vi.advanceTimersByTime(0);

    expect(row(section)).not.toBeNull();
  });

  it("patches each route owner once and unpatches it on teardown", () => {
    installCache(progress(80, 179, 44.7));
    mountSection();
    const owner = { renderFunc: vi.fn(() => null) };

    dispose = install();
    applyRoute(owner);
    applyRoute(owner);
    applyRoute(owner);

    expect(routeRenderPatches(owner)).toHaveLength(1);
    expect(mocks.addPatch).toHaveBeenCalledWith(APP_ROUTE, expect.any(Function));

    dispose();
    dispose = undefined;
    expect(routeRenderPatches(owner)[0]?.unpatch).toHaveBeenCalledOnce();
    expect(mocks.removePatch).toHaveBeenCalledTimes(1);
    expect(owner.renderFunc()).toBeNull();
  });

  it("unpatches the previous route owner when the route tree changes", () => {
    installCache(progress(80, 179, 44.7));
    mountSection();
    dispose = install();
    const first = { renderFunc: vi.fn(() => null) };
    const second = { renderFunc: vi.fn(() => null) };

    applyRoute(first);
    applyRoute(second);

    expect(routeRenderPatches(first)).toHaveLength(1);
    expect(routeRenderPatches(first)[0]?.unpatch).toHaveBeenCalledOnce();
    expect(routeRenderPatches(second)).toHaveLength(1);
    expect(first.renderFunc()).toBeNull();

    dispose();
    dispose = undefined;
    expect(routeRenderPatches(second)[0]?.unpatch).toHaveBeenCalledOnce();
  });

  it("does not install twice and releases every hook on teardown", () => {
    installCache(progress(80, 179, 44.7));
    const { section } = mountSection();
    const owner = { renderFunc: vi.fn(() => null) };

    const first = installAchievementBarPatch();
    dispose = first;
    const second = installAchievementBarPatch();
    expect(second).toBe(first);
    expect(mocks.addPatch).toHaveBeenCalledTimes(1);
    expect(registerAchievements).toHaveBeenCalledTimes(1);

    applyRoute(owner);
    vi.advanceTimersByTime(0);
    expect(row(section)).not.toBeNull();
    const staleCallback = routeRecords[0].callback;

    dispose();
    dispose = undefined;
    expect(row(section)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(unregisterAchievements).toHaveBeenCalledOnce();
    expect(routeRenderPatches(owner)[0]?.unpatch).toHaveBeenCalledOnce();
    expect(mocks.removePatch).toHaveBeenCalledTimes(1);

    const staleOwner = { renderFunc: vi.fn(() => null) };
    expect(() => staleCallback({ props: staleOwner })).not.toThrow();
    expect(routeRenderPatches(staleOwner)).toHaveLength(0);

    dispose = install();
    expect(row(section)).not.toBeNull();
    expect(mocks.addPatch).toHaveBeenCalledTimes(2);
    expect(registerAchievements).toHaveBeenCalledTimes(2);
  });

  it("returns a safe disposer when route registration and Steam globals fail", () => {
    mocks.addPatch.mockImplementation(() => {
      throw new Error("router unavailable");
    });
    vi.mocked(steamGlobals.getPopupManager).mockImplementation(() => {
      throw new Error("Steam globals unavailable");
    });

    dispose = installAchievementBarPatch();

    expect(() => vi.runAllTimers()).not.toThrow();
    expect(mocks.warn).toHaveBeenCalled();
    expect(() => dispose?.()).not.toThrow();
    expect(mocks.removePatch).not.toHaveBeenCalled();
  });
});
