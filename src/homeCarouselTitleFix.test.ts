// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import * as log from "./log";
import {
  installHomeCarouselTitleFix,
  resolveHomeCarouselModules,
} from "./homeCarouselTitleFix";

// The runtime must reuse achievementBar's Steam boundary. Its real module
// imports Decky's virtual manifest, which is not present in the unit runner.
vi.mock("./achievementBar", () => ({
  getBigPictureDocument: vi.fn(() => undefined),
  steamGlobals: { getPopupManager: vi.fn(() => undefined) },
}));

const BASIC = Object.freeze({
  BasicGameCarousel: "basic-carousel",
  BasicGameCarouselItemMediaContainer: "media-card",
  CarouselCapsuleBackgroundGlow: "capsule-glow",
  CarouselGameLabelWrapper: "game-label",
  ShowAsHovered: "basic-show-as-hovered",
});

const PORTRAIT = Object.freeze({
  LibraryItemBox: "library-item-box",
  ShowAsHovered: "portrait-show-as-hovered",
});

const BASIC_KEYS = Object.keys(BASIC);
const PORTRAIT_KEYS = Object.keys(PORTRAIT);

type WebpackEntry = {
  sourceKeys: string[];
  value?: unknown;
  error?: Error;
};

type Card = {
  media: HTMLElement;
  label: HTMLElement;
  glow: HTMLElement;
  libraryBox: HTMLElement;
};

function factoryWithSource(keys: string[]): () => void {
  const factory = () => undefined;
  Object.defineProperty(factory, "toString", {
    value: () => keys.map((key) => `exports.${key} = 1`).join(";"),
  });
  return factory;
}

function factoryWithThrowingSource(): () => void {
  const factory = () => undefined;
  Object.defineProperty(factory, "toString", {
    value: () => {
      throw new Error("factory source unavailable");
    },
  });
  return factory;
}

function webpackRequire(entries: Record<string, WebpackEntry>): any {
  const require = vi.fn((id: string) => {
    const entry = entries[id];
    if (entry?.error) throw entry.error;
    return entry?.value;
  }) as any;

  require.m = Object.fromEntries(
    Object.entries(entries).map(([id, entry]) => [
      id,
      factoryWithSource(entry.sourceKeys),
    ]),
  );
  return require;
}

function validRequire(extra: Record<string, WebpackEntry> = {}): any {
  return webpackRequire({
    basic: { sourceKeys: BASIC_KEYS, value: BASIC },
    portrait: { sourceKeys: PORTRAIT_KEYS, value: PORTRAIT },
    ...extra,
  });
}

function observeFactoryScans(require: any): {
  scans: () => number;
  factories: Record<string, unknown>;
} {
  const factories = require.m;
  let scanCount = 0;
  Object.defineProperty(require, "m", {
    configurable: true,
    get: () => {
      scanCount += 1;
      return factories;
    },
  });
  return { scans: () => scanCount, factories };
}

function steamChunkArray(
  require: any,
  options: {
    captureMode?: "immediate" | "delayed";
    pendingCaptures?: Array<() => void>;
    pushError?: () => Error | undefined;
  } = {},
): any[] {
  const chunks: any[] = [];
  const append = chunks.push.bind(chunks);
  vi.spyOn(chunks, "push").mockImplementation((entry: any) => {
    const error = options.pushError?.();
    if (error) throw error;
    const result = append(entry);
    const capture = () => entry?.[2]?.(require);
    if (options.captureMode === "delayed") {
      options.pendingCaptures?.push(capture);
    } else {
      capture();
    }
    return result;
  });
  return chunks;
}

function setReactClassName(element: HTMLElement, className = element.className): void {
  Object.defineProperty(element, "__reactProps$carouselTest", {
    configurable: true,
    value: { className },
  });
}

function makeCard(options: {
  focused?: boolean;
  stale?: boolean;
  reactExpected?: boolean;
} = {}): Card {
  const { focused = false, stale = true, reactExpected = true } = options;
  const media = document.createElement("article");
  media.classList.add(BASIC.BasicGameCarouselItemMediaContainer);
  if (focused) media.classList.add("gpfocuswithin");

  const label = document.createElement("div");
  label.classList.add(BASIC.CarouselGameLabelWrapper, "third-party-label");
  const glow = document.createElement("div");
  glow.classList.add(BASIC.CarouselCapsuleBackgroundGlow, "third-party-glow");
  const libraryBox = document.createElement("div");
  libraryBox.classList.add(PORTRAIT.LibraryItemBox, "third-party-box");

  if (stale) {
    label.classList.add(BASIC.ShowAsHovered);
    glow.classList.add(BASIC.ShowAsHovered);
    libraryBox.classList.add(PORTRAIT.ShowAsHovered);
  }

  libraryBox.style.filter = "brightness(0.5) saturate(0.5)";
  libraryBox.style.transform = "translateY(-7px)";
  libraryBox.style.boxShadow = "rgb(1, 2, 3) 0px 4px 8px";
  libraryBox.style.opacity = "0.64";

  media.append(label, glow, libraryBox);
  if (reactExpected) {
    setReactClassName(label);
    setReactClassName(glow);
    setReactClassName(libraryBox);
  }
  return { media, label, glow, libraryBox };
}

function makeCarousel(...cards: Card[]): HTMLElement {
  const root = document.createElement("section");
  root.classList.add(BASIC.BasicGameCarousel);
  for (const card of cards) root.append(card.media);
  return root;
}

function expectStale(card: Card, expected: boolean): void {
  expect(card.label.classList.contains(BASIC.ShowAsHovered)).toBe(expected);
  expect(card.glow.classList.contains(BASIC.ShowAsHovered)).toBe(expected);
  expect(card.libraryBox.classList.contains(PORTRAIT.ShowAsHovered)).toBe(expected);
}

function reintroduceStaleClasses(card: Card): void {
  card.label.classList.add(BASIC.ShowAsHovered);
  card.glow.classList.add(BASIC.ShowAsHovered);
  card.libraryBox.classList.add(PORTRAIT.ShowAsHovered);
}

function makeDocument(...roots: HTMLElement[]): Document {
  const next = document.implementation.createHTMLDocument("Steam Big Picture Mode");
  next.body.append(...roots);
  return next;
}

function runtimeHarness(options: {
  require?: any;
  currentDocument?: Document;
  hovered?: Set<Element>;
  breakerPassLimit?: number;
  breakerWindowMs?: number;
  captureMode?: "immediate" | "delayed";
  pushError?: Error;
} = {}) {
  let currentDocument: Document | undefined =
    options.currentDocument ?? makeDocument();
  let now = 0;
  let nextHandle = 1;
  const lifecycleCallbacks = new Map<number, () => void>();
  const cleanupCallbacks = new Map<number, () => void>();
  const hovered = options.hovered ?? new Set<Element>();
  const require = options.require ?? validRequire();
  const popupManager = { kind: "test-popup-manager" };
  const pendingCaptures: Array<() => void> = [];
  let pushError = options.pushError;
  const sharedWindow = {
    webpackChunksteamui: steamChunkArray(require, {
      captureMode: options.captureMode,
      pendingCaptures,
      pushError: () => pushError,
    }),
  };

  const dependencies = {
    getSharedWindow: () => sharedWindow,
    getPopupManager: vi.fn(() => popupManager),
    getBigPictureDocument: vi.fn((candidate: unknown) => {
      expect(candidate).toBe(popupManager);
      return currentDocument;
    }),
    setLifecycleInterval: vi.fn((callback: () => void, delay: number) => {
      expect(delay).toBeGreaterThanOrEqual(1_000);
      const handle = nextHandle++;
      lifecycleCallbacks.set(handle, callback);
      return handle;
    }),
    clearLifecycleInterval: vi.fn((handle: number) => {
      lifecycleCallbacks.delete(handle);
    }),
    scheduleCleanup: vi.fn((callback: () => void) => {
      const handle = nextHandle++;
      cleanupCallbacks.set(handle, callback);
      return handle;
    }),
    cancelCleanup: vi.fn((handle: number) => {
      cleanupCallbacks.delete(handle);
    }),
    isPointerHovered: vi.fn((element: Element) => hovered.has(element)),
    now: () => now,
    breakerWindowMs: options.breakerWindowMs ?? 1_000,
    breakerPassLimit: options.breakerPassLimit ?? 20,
  };

  const flushScheduled = (): number => {
    const callbacks = [...cleanupCallbacks.values()];
    cleanupCallbacks.clear();
    for (const callback of callbacks) callback();
    return callbacks.length;
  };

  const settleObservers = async (rounds = 4): Promise<void> => {
    for (let round = 0; round < rounds; round += 1) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      flushScheduled();
    }
  };

  return {
    dependencies,
    hovered,
    popupManager,
    require,
    sharedWindow,
    setChunkArray(nextRequire: any) {
      const next = steamChunkArray(nextRequire, {
        captureMode: options.captureMode,
        pendingCaptures,
        pushError: () => pushError,
      });
      sharedWindow.webpackChunksteamui = next;
      return next;
    },
    setPushError(nextError: Error | undefined) {
      pushError = nextError;
    },
    flushWebpackCaptures(): number {
      const captures = pendingCaptures.splice(0);
      for (const capture of captures) capture();
      return captures.length;
    },
    setDocument(nextDocument: Document | undefined) {
      currentDocument = nextDocument;
    },
    setNow(value: number) {
      now = value;
    },
    runLifecycle() {
      for (const callback of [...lifecycleCallbacks.values()]) callback();
    },
    flushScheduled,
    settleObservers,
    pendingLifecycleCount: () => lifecycleCallbacks.size,
    pendingCleanupCount: () => cleanupCallbacks.size,
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("resolveHomeCarouselModules", () => {
  it("resolves only complete BasicGameCarousel and AppPortrait export objects", () => {
    const require = validRequire({
      unrelated: {
        sourceKeys: ["BasicGameCarousel", "LibraryItemBox"],
        value: { BasicGameCarousel: "partial", LibraryItemBox: "partial" },
      },
    });

    expect(resolveHomeCarouselModules(require)).toEqual({
      basicGameCarousel: BASIC,
      appPortrait: PORTRAIT,
    });
    expect(require).toHaveBeenCalledWith("basic");
    expect(require).toHaveBeenCalledWith("portrait");
    expect(require).not.toHaveBeenCalledWith("unrelated");
  });

  it.each([
    [
      "partial candidates",
      webpackRequire({
        basic: {
          sourceKeys: BASIC_KEYS,
          value: { ...BASIC, ShowAsHovered: undefined },
        },
        portrait: { sourceKeys: PORTRAIT_KEYS, value: PORTRAIT },
      }),
    ],
    [
      "malformed candidates",
      webpackRequire({
        basic: { sourceKeys: BASIC_KEYS, value: null },
        portrait: { sourceKeys: PORTRAIT_KEYS, value: PORTRAIT },
      }),
    ],
    [
      "throwing candidates",
      webpackRequire({
        basic: { sourceKeys: BASIC_KEYS, error: new Error("module failed") },
        portrait: { sourceKeys: PORTRAIT_KEYS, value: PORTRAIT },
      }),
    ],
    [
      "ambiguous candidates",
      webpackRequire({
        basicOne: { sourceKeys: BASIC_KEYS, value: BASIC },
        basicTwo: {
          sourceKeys: BASIC_KEYS,
          value: { ...BASIC, BasicGameCarousel: "other-carousel" },
        },
        portrait: { sourceKeys: PORTRAIT_KEYS, value: PORTRAIT },
      }),
    ],
  ])("rejects %s", (_label, require) => {
    expect(() => resolveHomeCarouselModules(require)).not.toThrow();
    expect(resolveHomeCarouselModules(require)).toBeUndefined();
  });

  it("rejects missing or throwing factory tables", () => {
    const missing = vi.fn() as any;
    const throwing = vi.fn() as any;
    Object.defineProperty(throwing, "m", {
      get: () => {
        throw new Error("factories unavailable");
      },
    });

    expect(resolveHomeCarouselModules(missing)).toBeUndefined();
    expect(() => resolveHomeCarouselModules(throwing)).not.toThrow();
    expect(resolveHomeCarouselModules(throwing)).toBeUndefined();
  });

  it("skips a factory whose toString throws without executing it", () => {
    const require = validRequire();
    require.m.throwingSource = factoryWithThrowingSource();

    expect(() => resolveHomeCarouselModules(require)).not.toThrow();
    expect(resolveHomeCarouselModules(require)).toEqual({
      basicGameCarousel: BASIC,
      appPortrait: PORTRAIT,
    });
    expect(require).not.toHaveBeenCalledWith("throwingSource");
  });

  it("fails closed before execution when more than ten factories survive a scan", () => {
    const entries: Record<string, WebpackEntry> = {
      portrait: { sourceKeys: PORTRAIT_KEYS, value: PORTRAIT },
    };
    for (let index = 0; index < 11; index += 1) {
      entries[`basic-${index}`] = {
        sourceKeys: BASIC_KEYS,
        value: { ...BASIC, BasicGameCarousel: `carousel-${index}` },
      };
    }
    const require = webpackRequire(entries);

    expect(resolveHomeCarouselModules(require)).toBeUndefined();
    expect(require).not.toHaveBeenCalled();
  });

  it("rejects ambiguous AppPortrait candidates", () => {
    const require = webpackRequire({
      basic: { sourceKeys: BASIC_KEYS, value: BASIC },
      portraitOne: { sourceKeys: PORTRAIT_KEYS, value: PORTRAIT },
      portraitTwo: {
        sourceKeys: PORTRAIT_KEYS,
        value: { ...PORTRAIT, LibraryItemBox: "other-library-item-box" },
      },
    });

    expect(resolveHomeCarouselModules(require)).toBeUndefined();
  });
});

describe("installHomeCarouselTitleFix", () => {
  it("passes the current popup manager into the shared document lookup", () => {
    const harness = runtimeHarness();

    const dispose = installHomeCarouselTitleFix(harness.dependencies);

    expect(harness.dependencies.getPopupManager).toHaveBeenCalled();
    expect(harness.dependencies.getBigPictureDocument).toHaveBeenCalledWith(
      harness.popupManager,
    );
    dispose();
  });

  it("captures webpack once across disable and re-enable for one chunk array", () => {
    const harness = runtimeHarness();
    const push = harness.sharedWindow.webpackChunksteamui.push;

    installHomeCarouselTitleFix(harness.dependencies)();
    installHomeCarouselTitleFix(harness.dependencies)();

    expect(push).toHaveBeenCalledTimes(1);
  });

  it("reuses the persisted Symbol.for capture after a module reload", async () => {
    const harness = runtimeHarness();
    const push = harness.sharedWindow.webpackChunksteamui.push;
    installHomeCarouselTitleFix(harness.dependencies)();

    const persistedSymbols = Object.getOwnPropertySymbols(harness.sharedWindow);
    const captureSymbol = persistedSymbols.find((symbol) =>
      /decky|achievement|carousel/i.test(Symbol.keyFor(symbol) ?? ""),
    );
    expect(captureSymbol).toBeDefined();
    expect(Symbol.keyFor(captureSymbol!)).toBeDefined();
    expect((harness.sharedWindow as any)[captureSymbol!]).toMatchObject({
      chunkArray: harness.sharedWindow.webpackChunksteamui,
      require: harness.require,
      pending: false,
    });

    vi.resetModules();
    const reloaded = await import("./homeCarouselTitleFix");
    reloaded.installHomeCarouselTitleFix(harness.dependencies)();

    expect(push).toHaveBeenCalledTimes(1);
  });

  it("captures exactly once again after the chunk-array identity changes", () => {
    const harness = runtimeHarness();
    const firstChunks = harness.sharedWindow.webpackChunksteamui;
    installHomeCarouselTitleFix(harness.dependencies)();

    const secondChunks = harness.setChunkArray(validRequire());
    installHomeCarouselTitleFix(harness.dependencies)();
    installHomeCarouselTitleFix(harness.dependencies)();

    expect(firstChunks.push).toHaveBeenCalledTimes(1);
    expect(secondChunks.push).toHaveBeenCalledTimes(1);
  });

  it("publishes a delayed capture once and reuses its resolved persisted handle", async () => {
    const harness = runtimeHarness({ captureMode: "delayed" });
    const push = harness.sharedWindow.webpackChunksteamui.push;
    const dispose = installHomeCarouselTitleFix(harness.dependencies);

    expect(push).toHaveBeenCalledTimes(1);
    harness.runLifecycle();
    expect(push).toHaveBeenCalledTimes(1);
    expect(harness.flushWebpackCaptures()).toBe(1);

    const captureSymbol = Object.getOwnPropertySymbols(harness.sharedWindow).find(
      (symbol) => /decky|achievement|carousel/i.test(Symbol.keyFor(symbol) ?? ""),
    );
    expect((harness.sharedWindow as any)[captureSymbol!]).toMatchObject({
      chunkArray: harness.sharedWindow.webpackChunksteamui,
      require: harness.require,
      pending: false,
    });

    dispose();
    installHomeCarouselTitleFix(harness.dependencies)();
    expect(push).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const reloaded = await import("./homeCarouselTitleFix");
    reloaded.installHomeCarouselTitleFix(harness.dependencies)();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("backs off after a thrown capture push and retries after the window", () => {
    const harness = runtimeHarness({
      pushError: new Error("chunk array is not ready"),
    });
    const push = harness.sharedWindow.webpackChunksteamui.push;

    installHomeCarouselTitleFix(harness.dependencies);
    expect(push).toHaveBeenCalledTimes(1);

    harness.runLifecycle();
    harness.setNow(999);
    harness.runLifecycle();
    expect(push).toHaveBeenCalledTimes(1);

    harness.setPushError(undefined);
    harness.setNow(1_000);
    harness.runLifecycle();
    expect(push).toHaveBeenCalledTimes(2);
  });

  it("backs off module scans, resolves when modules appear, and stops after success", () => {
    const require = webpackRequire({
      basic: { sourceKeys: BASIC_KEYS, value: BASIC },
    });
    const observed = observeFactoryScans(require);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const harness = runtimeHarness({ require });

    installHomeCarouselTitleFix(harness.dependencies);
    expect(observed.scans()).toBe(1);
    expect(require).toHaveBeenCalledTimes(1);
    expect(
      warn.mock.calls.filter((args) =>
        args.some((arg) => /unresolved/i.test(String(arg))),
      ),
    ).toHaveLength(1);

    harness.runLifecycle();
    harness.setNow(999);
    harness.runLifecycle();
    expect(observed.scans()).toBe(1);
    expect(require).toHaveBeenCalledTimes(1);
    expect(
      warn.mock.calls.filter((args) =>
        args.some((arg) => /unresolved/i.test(String(arg))),
      ),
    ).toHaveLength(1);

    harness.setNow(1_000);
    harness.runLifecycle();
    expect(observed.scans()).toBe(2);
    expect(require).toHaveBeenCalledTimes(2);
    expect(
      warn.mock.calls.filter((args) =>
        args.some((arg) => /unresolved/i.test(String(arg))),
      ),
    ).toHaveLength(1);

    observed.factories.portrait = factoryWithSource(PORTRAIT_KEYS);
    require.mockImplementation((id: string) =>
      id === "basic" ? BASIC : id === "portrait" ? PORTRAIT : undefined,
    );
    harness.setNow(3_000);
    harness.runLifecycle();
    expect(observed.scans()).toBe(3);
    expect(require).toHaveBeenCalledTimes(4);

    harness.setNow(10_000);
    harness.runLifecycle();
    expect(observed.scans()).toBe(3);
  });

  it.each([
    [
      "unresolved",
      () => webpackRequire({ basic: { sourceKeys: BASIC_KEYS, value: BASIC } }),
    ],
    [
      "ambiguous",
      () =>
        webpackRequire({
          basicOne: { sourceKeys: BASIC_KEYS, value: BASIC },
          basicTwo: {
            sourceKeys: BASIC_KEYS,
            value: { ...BASIC, BasicGameCarousel: "another-carousel" },
          },
          portrait: { sourceKeys: PORTRAIT_KEYS, value: PORTRAIT },
        }),
    ],
    [
      "candidate overflow",
      () => {
        const entries: Record<string, WebpackEntry> = {};
        for (let index = 0; index < 11; index += 1) {
          entries[`basic-${index}`] = {
            sourceKeys: BASIC_KEYS,
            value: BASIC,
          };
        }
        return webpackRequire(entries);
      },
    ],
  ])("logs one distinct %s module-resolution diagnostic per unchanged failure", (label, makeRequire) => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const harness = runtimeHarness({ require: makeRequire() });

    installHomeCarouselTitleFix(harness.dependencies);
    harness.setNow(1_000);
    harness.runLifecycle();

    expect(
      warn.mock.calls.filter((args) =>
        args.some((arg) =>
          String(arg).toLowerCase().includes(label.replace("candidate ", "")),
        ),
      ),
    ).toHaveLength(1);
  });

  it.each([
    [
      "partial",
      () =>
        webpackRequire({
          basic: {
            sourceKeys: BASIC_KEYS,
            value: { ...BASIC, CarouselGameLabelWrapper: undefined },
          },
          portrait: { sourceKeys: PORTRAIT_KEYS, value: PORTRAIT },
        }),
    ],
    [
      "malformed",
      () =>
        webpackRequire({
          basic: { sourceKeys: BASIC_KEYS, value: "not an export object" },
          portrait: { sourceKeys: PORTRAIT_KEYS, value: PORTRAIT },
        }),
    ],
    [
      "throwing",
      () =>
        webpackRequire({
          basic: { sourceKeys: BASIC_KEYS, error: new Error("module failed") },
          portrait: { sourceKeys: PORTRAIT_KEYS, value: PORTRAIT },
        }),
    ],
    [
      "ambiguous",
      () =>
        webpackRequire({
          basicOne: { sourceKeys: BASIC_KEYS, value: BASIC },
          basicTwo: {
            sourceKeys: BASIC_KEYS,
            value: { ...BASIC, BasicGameCarousel: "duplicate" },
          },
          portrait: { sourceKeys: PORTRAIT_KEYS, value: PORTRAIT },
        }),
    ],
    [
      "ambiguous for AppPortrait",
      () =>
        webpackRequire({
          basic: { sourceKeys: BASIC_KEYS, value: BASIC },
          portraitOne: { sourceKeys: PORTRAIT_KEYS, value: PORTRAIT },
          portraitTwo: {
            sourceKeys: PORTRAIT_KEYS,
            value: { ...PORTRAIT, LibraryItemBox: "duplicate" },
          },
        }),
    ],
  ])("does not mutate the DOM when module resolution is %s", (_label, makeRequire) => {
    const focused = makeCard({ focused: true });
    const stale = makeCard();
    const root = makeCarousel(focused, stale);
    const currentDocument = makeDocument(root);
    const require = makeRequire();
    const harness = runtimeHarness({ currentDocument, require });

    expect(() => installHomeCarouselTitleFix(harness.dependencies)).not.toThrow();
    expectStale(stale, true);
    expect(harness.pendingLifecycleCount()).toBe(1);
  });

  it("removes exactly the three stale tokens during the initial pass", () => {
    const focused = makeCard({ focused: true });
    const stale = makeCard();
    const root = makeCarousel(focused, stale);
    root.classList.add("root-theme-class");
    const outside = makeCard();
    const currentDocument = makeDocument(root);
    currentDocument.body.append(outside.media);
    const harness = runtimeHarness({ currentDocument });

    installHomeCarouselTitleFix(harness.dependencies);

    expectStale(stale, false);
    expectStale(focused, true);
    expectStale(outside, true);
    expect(root.classList.contains("root-theme-class")).toBe(true);
    expect(stale.label.classList.contains("third-party-label")).toBe(true);
    expect(stale.glow.classList.contains("third-party-glow")).toBe(true);
    expect(stale.libraryBox.classList.contains("third-party-box")).toBe(true);
    expect(stale.libraryBox.style.filter).toBe("brightness(0.5) saturate(0.5)");
    expect(stale.libraryBox.style.transform).toBe("translateY(-7px)");
    expect(stale.libraryBox.style.boxShadow).toBe("rgb(1, 2, 3) 0px 4px 8px");
    expect(stale.libraryBox.style.opacity).toBe("0.64");
  });

  it("requires gpfocuswithin on the media card itself", () => {
    const first = makeCard();
    const second = makeCard();
    const root = makeCarousel(first, second);
    root.classList.add("gpfocuswithin");
    const ancestor = document.createElement("main");
    ancestor.classList.add("gpfocuswithin");
    ancestor.append(root);
    const currentDocument = makeDocument();
    currentDocument.body.append(ancestor);
    const harness = runtimeHarness({ currentDocument });

    installHomeCarouselTitleFix(harness.dependencies);

    expectStale(first, true);
    expectStale(second, true);
  });

  it("services each carousel independently", () => {
    const firstFocused = makeCard({ focused: true });
    const firstStale = makeCard();
    const secondFirst = makeCard();
    const secondStale = makeCard();
    const firstRoot = makeCarousel(firstFocused, firstStale);
    const secondRoot = makeCarousel(secondFirst, secondStale);
    const harness = runtimeHarness({
      currentDocument: makeDocument(firstRoot, secondRoot),
    });

    installHomeCarouselTitleFix(harness.dependencies);

    expectStale(firstStale, false);
    expectStale(secondFirst, true);
    expectStale(secondStale, true);
  });

  it("resolves targets only inside their owning media card", () => {
    const focused = makeCard({ focused: true });
    const incomplete = makeCard();
    incomplete.label.remove();
    const pointerHovered = makeCard();
    // Put the incomplete card first. A carousel-wide fallback would take the
    // matching label from the focused card that follows it.
    const root = makeCarousel(incomplete, focused, pointerHovered);
    const hovered = new Set<Element>([pointerHovered.media]);
    const harness = runtimeHarness({
      currentDocument: makeDocument(root),
      hovered,
    });

    installHomeCarouselTitleFix(harness.dependencies);

    expect(incomplete.glow.classList.contains(BASIC.ShowAsHovered)).toBe(false);
    expect(incomplete.libraryBox.classList.contains(PORTRAIT.ShowAsHovered)).toBe(false);
    expectStale(focused, true);
    expectStale(pointerHovered, true);
  });

  it("preserves real pointer hover, then cleans after scoped pointerleave", async () => {
    const focused = makeCard({ focused: true });
    const stale = makeCard();
    const root = makeCarousel(focused, stale);
    const hovered = new Set<Element>([stale.media]);
    const harness = runtimeHarness({
      currentDocument: makeDocument(root),
      hovered,
    });

    installHomeCarouselTitleFix(harness.dependencies);
    expectStale(stale, true);

    hovered.delete(stale.media);
    stale.media.dispatchEvent(new Event("pointerleave"));
    await harness.settleObservers();

    expectStale(stale, false);
  });

  it("cleans class reintroduction, inserted cards, and focus reversal", async () => {
    const first = makeCard({ focused: true });
    const second = makeCard();
    const root = makeCarousel(first, second);
    const harness = runtimeHarness({ currentDocument: makeDocument(root) });
    installHomeCarouselTitleFix(harness.dependencies);
    await harness.settleObservers();

    reintroduceStaleClasses(second);
    await harness.settleObservers();
    expectStale(second, false);

    const inserted = makeCard();
    root.append(inserted.media);
    await harness.settleObservers();
    expectStale(inserted, false);

    first.media.classList.remove("gpfocuswithin");
    second.media.classList.add("gpfocuswithin");
    reintroduceStaleClasses(first);
    reintroduceStaleClasses(second);
    await harness.settleObservers();
    expectStale(first, false);
    expectStale(second, true);
  });

  it("coalesces idempotent self-mutations into at most one empty pass", async () => {
    const focused = makeCard({ focused: true });
    const stale = makeCard();
    const root = makeCarousel(focused, stale);
    const harness = runtimeHarness({ currentDocument: makeDocument(root) });

    installHomeCarouselTitleFix(harness.dependencies);
    const callsAfterInitialPass =
      harness.dependencies.isPointerHovered.mock.calls.length;
    await harness.settleObservers(6);

    expectStale(stale, false);
    const callsAfterSelfMutation =
      harness.dependencies.isPointerHovered.mock.calls.length;
    expect(callsAfterInitialPass).toBeGreaterThan(0);
    expect(callsAfterSelfMutation - callsAfterInitialPass).toBeLessThanOrEqual(1);
    expect(harness.pendingCleanupCount()).toBe(0);

    await harness.settleObservers(3);
    expect(harness.dependencies.isPointerHovered).toHaveBeenCalledTimes(
      callsAfterSelfMutation,
    );
  });

  it("opens and warns exactly when cleanup passes exceed the breaker limit", async () => {
    const focused = makeCard({ focused: true });
    const stale = makeCard();
    const root = makeCarousel(focused, stale);
    const harness = runtimeHarness({
      currentDocument: makeDocument(root),
      breakerPassLimit: 3,
      breakerWindowMs: 1_000,
    });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    installHomeCarouselTitleFix(harness.dependencies);
    await harness.settleObservers();
    harness.setNow(2_000);
    const callsBeforeWindow =
      harness.dependencies.isPointerHovered.mock.calls.length;

    for (let pass = 0; pass < 3; pass += 1) {
      stale.media.dispatchEvent(new Event("pointerleave"));
      expect(harness.flushScheduled()).toBe(1);
    }
    expect(harness.dependencies.isPointerHovered).toHaveBeenCalledTimes(
      callsBeforeWindow + 3,
    );
    expect(
      warn.mock.calls.filter((args) => args.some((arg) => /circuit breaker/i.test(String(arg)))),
    ).toHaveLength(0);

    stale.media.dispatchEvent(new Event("pointerleave"));
    expect(harness.flushScheduled()).toBe(1);
    expect(harness.dependencies.isPointerHovered).toHaveBeenCalledTimes(
      callsBeforeWindow + 3,
    );
    expect(
      warn.mock.calls.filter((args) => args.some((arg) => /circuit breaker/i.test(String(arg)))),
    ).toHaveLength(1);

    reintroduceStaleClasses(stale);
    await harness.settleObservers();
    expectStale(stale, true);
  });

  it("rebinds when the Big Picture document or mounted carousel set changes", async () => {
    const oldFocused = makeCard({ focused: true });
    const oldStale = makeCard();
    const oldRoot = makeCarousel(oldFocused, oldStale);
    const oldDocument = makeDocument(oldRoot);
    const harness = runtimeHarness({ currentDocument: oldDocument });
    installHomeCarouselTitleFix(harness.dependencies);
    expectStale(oldStale, false);

    const addedFocused = makeCard({ focused: true });
    const addedStale = makeCard();
    oldDocument.body.append(makeCarousel(addedFocused, addedStale));
    harness.runLifecycle();
    expectStale(addedStale, false);

    const newFocused = makeCard({ focused: true });
    const newStale = makeCard();
    const newDocument = makeDocument(makeCarousel(newFocused, newStale));
    harness.setDocument(newDocument);
    harness.runLifecycle();
    await harness.settleObservers();

    expectStale(oldStale, true);
    expectStale(addedStale, true);
    expectStale(newStale, false);
  });

  it("restores a removed root on a same-document carousel-set rebind", async () => {
    const removedFocused = makeCard({ focused: true });
    const removedStale = makeCard();
    const removedRoot = makeCarousel(removedFocused, removedStale);
    const retainedFocused = makeCard({ focused: true });
    const retainedStale = makeCard();
    const retainedRoot = makeCarousel(retainedFocused, retainedStale);
    const currentDocument = makeDocument(removedRoot, retainedRoot);
    const harness = runtimeHarness({ currentDocument });
    installHomeCarouselTitleFix(harness.dependencies);
    await harness.settleObservers();

    expectStale(removedStale, false);
    expectStale(retainedStale, false);
    removedRoot.remove();
    // Keep the removed root connected in a non-Big-Picture document. This
    // permits React-aware restoration while it leaves the serviced root set.
    document.body.append(removedRoot);
    harness.runLifecycle();

    expectStale(removedStale, true);
    expectStale(retainedStale, false);
  });

  it("tears down the old binding when the Big Picture document disappears", async () => {
    const focused = makeCard({ focused: true });
    const stale = makeCard();
    const root = makeCarousel(focused, stale);
    const harness = runtimeHarness({ currentDocument: makeDocument(root) });
    const dispose = installHomeCarouselTitleFix(harness.dependencies);
    await harness.settleObservers();
    expectStale(stale, false);

    harness.setDocument(undefined);
    harness.runLifecycle();
    expectStale(stale, true);

    stale.label.classList.remove(BASIC.ShowAsHovered);
    stale.label.classList.add(BASIC.ShowAsHovered);
    stale.media.dispatchEvent(new Event("pointerleave"));
    await harness.settleObservers();
    expectStale(stale, true);
    expect(harness.pendingCleanupCount()).toBe(0);
    dispose();
  });

  it.each(["dispose", "document rebind"] as const)(
    "restores tracked tokens from a breaker-open binding on %s",
    async (action) => {
      const focused = makeCard({ focused: true });
      const stale = makeCard();
      const root = makeCarousel(focused, stale);
      const harness = runtimeHarness({
        currentDocument: makeDocument(root),
        breakerPassLimit: 1,
      });
      vi.spyOn(log, "warn").mockImplementation(() => undefined);
      const dispose = installHomeCarouselTitleFix(harness.dependencies);
      await harness.settleObservers();
      expectStale(stale, false);

      if (action === "dispose") {
        dispose();
      } else {
        harness.setDocument(makeDocument());
        harness.runLifecycle();
      }

      expectStale(stale, true);
      dispose();
    },
  );

  it("cancels queued cleanup and stops all activity after disposal", async () => {
    const focused = makeCard({ focused: true });
    const stale = makeCard();
    const root = makeCarousel(focused, stale);
    const hovered = new Set<Element>([stale.media]);
    const harness = runtimeHarness({
      currentDocument: makeDocument(root),
      hovered,
    });
    const dispose = installHomeCarouselTitleFix(harness.dependencies);
    expectStale(stale, true);

    hovered.delete(stale.media);
    stale.media.dispatchEvent(new Event("pointerleave"));
    expect(harness.pendingCleanupCount()).toBe(1);

    dispose();
    dispose();
    expect(harness.pendingLifecycleCount()).toBe(0);
    expect(harness.pendingCleanupCount()).toBe(0);

    expect(harness.flushScheduled()).toBe(0);
    stale.media.dispatchEvent(new Event("pointerleave"));
    harness.runLifecycle();
    await harness.settleObservers();
    expectStale(stale, true);
  });

  it("restores only exact tokens from a usable current React props entry", () => {
    const focused = makeCard({ focused: true });
    const expected = makeCard();
    const missingProps = makeCard({ reactExpected: false });
    const changedProps = makeCard();
    setReactClassName(
      changedProps.label,
      `${BASIC.CarouselGameLabelWrapper} third-party-label`,
    );
    setReactClassName(
      changedProps.glow,
      `${BASIC.CarouselCapsuleBackgroundGlow} third-party-glow`,
    );
    setReactClassName(
      changedProps.libraryBox,
      `${PORTRAIT.LibraryItemBox} third-party-box`,
    );
    const tokenSubstring = makeCard();
    setReactClassName(
      tokenSubstring.label,
      `${BASIC.CarouselGameLabelWrapper} prefix-${BASIC.ShowAsHovered}-suffix`,
    );
    setReactClassName(
      tokenSubstring.glow,
      `${BASIC.CarouselCapsuleBackgroundGlow} prefix-${BASIC.ShowAsHovered}-suffix`,
    );
    setReactClassName(
      tokenSubstring.libraryBox,
      `${PORTRAIT.LibraryItemBox} prefix-${PORTRAIT.ShowAsHovered}-suffix`,
    );
    const multipleProps = makeCard({ reactExpected: false });
    for (const element of [
      multipleProps.label,
      multipleProps.glow,
      multipleProps.libraryBox,
    ]) {
      Object.defineProperty(element, "__reactProps$malformed", {
        configurable: true,
        value: { className: 42 },
      });
      Object.defineProperty(element, "__reactProps$current", {
        configurable: true,
        value: { className: element.className },
      });
    }
    const disagreeingProps = makeCard({ reactExpected: false });
    for (const [element, roleToken, hoverToken] of [
      [
        disagreeingProps.label,
        BASIC.CarouselGameLabelWrapper,
        BASIC.ShowAsHovered,
      ],
      [
        disagreeingProps.glow,
        BASIC.CarouselCapsuleBackgroundGlow,
        BASIC.ShowAsHovered,
      ],
      [
        disagreeingProps.libraryBox,
        PORTRAIT.LibraryItemBox,
        PORTRAIT.ShowAsHovered,
      ],
    ] as const) {
      Object.defineProperty(element, "__reactProps$expectsToken", {
        configurable: true,
        value: { className: `${roleToken} ${hoverToken}` },
      });
      Object.defineProperty(element, "__reactProps$rejectsToken", {
        configurable: true,
        value: { className: roleToken },
      });
    }
    const detached = makeCard();
    const root = makeCarousel(
      focused,
      expected,
      missingProps,
      changedProps,
      tokenSubstring,
      multipleProps,
      disagreeingProps,
      detached,
    );
    const harness = runtimeHarness({ currentDocument: makeDocument(root) });
    const dispose = installHomeCarouselTitleFix(harness.dependencies);
    detached.media.remove();

    expectStale(expected, false);
    expectStale(missingProps, false);
    expectStale(changedProps, false);
    expectStale(tokenSubstring, false);
    expectStale(multipleProps, false);
    expectStale(disagreeingProps, false);
    dispose();

    expectStale(expected, true);
    expectStale(missingProps, false);
    expectStale(changedProps, false);
    expectStale(tokenSubstring, false);
    expectStale(multipleProps, true);
    expectStale(disagreeingProps, false);
    expectStale(detached, false);
  });
});
