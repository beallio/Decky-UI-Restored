// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

const mocks = vi.hoisted(() => ({
  addPatch: vi.fn(),
  removePatch: vi.fn(),
  afterPatch: vi.fn(),
  findClassModule: vi.fn(),
  findInReactTree: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

const classes = {
  GameStat: "game-stat",
  GameStatsSection: "stats-section",
  Playtime: "playtime",
  PlayBar: "play-bar",
};

vi.mock("@decky/ui", () => ({
  afterPatch: mocks.afterPatch,
  findClassModule: mocks.findClassModule,
  findInReactTree: mocks.findInReactTree,
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
const ROUTES = ["/library/app/:appid", "/library/details/:appid", "/library/:collection/app/:appid"];

type PatchRecord = {
  target: { [key: string]: unknown };
  method: string;
  unpatch: Mock;
};

type RouteRecord = {
  route: string;
  callback: (tree: unknown) => unknown;
};

type StatsProps = Record<string, unknown>;
type Stats = { props: StatsProps; forceUpdate: Mock; BUserHasContentToClaim: () => boolean };

let patchRecords: PatchRecord[] = [];
let routeRecords: RouteRecord[] = [];
let dispose: (() => void) | undefined;

const popup = (document: unknown, title = "Steam Big Picture Mode") => ({
  m_strTitle: title,
  m_popup: { document },
});

const popupManager = (document: unknown) => ({
  m_rgPopups: new Map([["bpm", popup(document)]]),
});

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

const statsProps = (appId = APP_ID, overrides: Record<string, unknown> = {}): StatsProps => ({
  overview: { appid: appId, installed: true, app_type: 1, ...overrides },
  details: { unAppID: appId },
  onSeek: undefined,
  statusPanelType: 0,
});

/** A stats section rendered by Steam's class component, one fiber above the DOM node. */
const mountSection = (props: StatsProps = statsProps(), parent: HTMLElement = document.body) => {
  const section = document.createElement("div");
  section.className = classes.GameStatsSection;
  parent.append(section);
  const instance: Stats = {
    props,
    forceUpdate: vi.fn(),
    BUserHasContentToClaim: () => false,
  };
  Reflect.set(section, "__reactFiber$test", { stateNode: section, return: { stateNode: instance, return: null } });
  return { instance, section };
};

const install = () => {
  const nextDispose = installAchievementBarPatch();
  vi.advanceTimersByTime(0);
  return nextDispose;
};

const applyRoute = (owner: object, index = 0) => routeRecords[index]?.callback({ props: owner });

const nonSteamOverrides: Array<[string, Record<string, unknown>]> = [
  ["a non-Steam app type", { app_type: 1073741824 }],
  ["an explicit shortcut flag", { BIsShortcut: () => true }],
  [
    "a throwing shortcut probe",
    {
      BIsShortcut: () => {
        throw new Error("gone");
      },
    },
  ],
];

const routeRenderPatches = (owner: object) =>
  patchRecords.filter((record) => record.target === owner && record.method === "renderFunc");

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  document.body.innerHTML = "";
  patchRecords = [];
  routeRecords = [];
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
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
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

describe("achievement stat onSeek supply", () => {
  it("supplies a stable onSeek so Steam renders its own row, and re-renders once", () => {
    const raw = statsProps();
    const { instance } = mountSection(raw);

    dispose = install();

    expect(instance.props.onSeek).toBeTypeOf("function");
    expect(instance.props.overview).toBe(raw.overview);
    expect(instance.props).toBe(instance.props);
    expect(raw.onSeek).toBeUndefined();
    expect(instance.forceUpdate).toHaveBeenCalledOnce();

    applyRoute({ renderFunc: vi.fn(() => null) });
    vi.runAllTimers();
    expect(instance.forceUpdate).toHaveBeenCalledOnce();
  });

  it("keeps supplying onSeek when React assigns the next game's props", () => {
    const { instance } = mountSection();
    dispose = install();

    const next = statsProps(SECOND_APP_ID);
    instance.props = next;

    expect(instance.props.onSeek).toBeTypeOf("function");
    expect(instance.props.overview).toBe(next.overview);
    expect(next.onSeek).toBeUndefined();
  });

  it("leaves a client-supplied onSeek untouched", () => {
    const raw = { ...statsProps(), onSeek: vi.fn() };
    const { instance } = mountSection(raw);

    dispose = install();

    expect(instance.props).toBe(raw);
  });

  it.each(nonSteamOverrides)("does not show the row for %s", (_name, overrides) => {
    const { instance } = mountSection(statsProps(APP_ID, overrides));

    dispose = install();

    expect(instance.props.onSeek).toBeUndefined();
  });

  it("skips a stats component whose props React does not let it redefine", () => {
    const { instance } = mountSection();
    const raw = instance.props;
    Object.defineProperty(instance, "props", { value: raw, writable: true, configurable: false });

    expect(() => {
      dispose = install();
      vi.runAllTimers();
    }).not.toThrow();
    expect(instance.props.onSeek).toBeUndefined();
    expect(instance.forceUpdate).not.toHaveBeenCalled();
  });

  it("retries after a route render when the page's stats section commits late", () => {
    dispose = install();
    vi.runAllTimers();

    const { instance } = mountSection();
    applyRoute({ renderFunc: vi.fn(() => null) });
    vi.advanceTimersByTime(0);

    expect(instance.props.onSeek).toBeTypeOf("function");
  });

  it("restores a detached section's real props, re-patches it when reinserted, and restores it on teardown", () => {
    const raw = statsProps();
    const { instance, section } = mountSection(raw);
    dispose = install();
    const route = { renderFunc: vi.fn(() => null) };

    section.remove();
    applyRoute(route);
    vi.advanceTimersByTime(0);
    expect(Object.getOwnPropertyDescriptor(instance, "props")).toMatchObject({ value: raw });

    document.body.append(section);
    route.renderFunc();
    vi.advanceTimersByTime(0);
    expect(instance.props.onSeek).toBeTypeOf("function");

    dispose();
    dispose = undefined;
    expect(Object.getOwnPropertyDescriptor(instance, "props")).toMatchObject({ value: raw, writable: true });
  });

  it("watches every game-details route and patches each route owner once", () => {
    mountSection();
    dispose = install();
    expect(routeRecords.map((record) => record.route)).toEqual(ROUTES);

    const owner = { renderFunc: vi.fn(() => null) };
    applyRoute(owner, 2);
    applyRoute(owner, 2);
    expect(routeRenderPatches(owner)).toHaveLength(1);

    const first = { renderFunc: vi.fn(() => null) };
    const second = { renderFunc: vi.fn(() => null) };
    applyRoute(first);
    applyRoute(second);
    expect(routeRenderPatches(first)[0]?.unpatch).toHaveBeenCalledOnce();
    expect(routeRenderPatches(second)).toHaveLength(1);

    dispose();
    dispose = undefined;
    expect(routeRenderPatches(owner)[0]?.unpatch).toHaveBeenCalledOnce();
    expect(routeRenderPatches(second)[0]?.unpatch).toHaveBeenCalledOnce();
    expect(mocks.removePatch).toHaveBeenCalledTimes(ROUTES.length);
    expect(owner.renderFunc()).toBeNull();
  });

  it("does not install twice and restores Steam's latest real props on teardown", () => {
    const { instance } = mountSection();

    const first = installAchievementBarPatch();
    dispose = first;
    expect(installAchievementBarPatch()).toBe(first);
    expect(mocks.addPatch).toHaveBeenCalledTimes(ROUTES.length);
    vi.advanceTimersByTime(0);
    const latest = statsProps(SECOND_APP_ID);
    instance.props = latest;
    const staleCallback = routeRecords[0].callback;

    dispose();
    dispose = undefined;
    expect(Object.getOwnPropertyDescriptor(instance, "props")).toMatchObject({ value: latest, writable: true });
    expect(instance.forceUpdate).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    const staleOwner = { renderFunc: vi.fn(() => null) };
    expect(() => staleCallback({ props: staleOwner })).not.toThrow();
    expect(routeRenderPatches(staleOwner)).toHaveLength(0);

    dispose = install();
    expect(instance.props.onSeek).toBeTypeOf("function");
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
