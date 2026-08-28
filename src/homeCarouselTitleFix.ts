import { getBigPictureDocument, steamGlobals } from "./achievementBar";
import * as log from "./log";

const CAPTURE_SYMBOL = Symbol.for(
  "Decky-SteamAchievements.homeCarouselTitleFix.webpackRequire",
);
const CAPTURE_CHUNK_ID = "decky-steamachievements-home-carousel-title-fix";
const LIFECYCLE_INTERVAL_MS = 1_000;
const DEFAULT_BREAKER_WINDOW_MS = 1_000;
const DEFAULT_BREAKER_PASS_LIMIT = 20;
const MAX_FACTORY_SURVIVORS = 10;

const BASIC_GAME_CAROUSEL_KEYS = [
  "BasicGameCarousel",
  "BasicGameCarouselItemMediaContainer",
  "CarouselCapsuleBackgroundGlow",
  "CarouselGameLabelWrapper",
  "ShowAsHovered",
] as const;

const APP_PORTRAIT_KEYS = ["LibraryItemBox", "ShowAsHovered"] as const;

type BasicGameCarouselModule = Record<
  (typeof BASIC_GAME_CAROUSEL_KEYS)[number],
  string
>;
type AppPortraitModule = Record<(typeof APP_PORTRAIT_KEYS)[number], string>;

export type ResolvedHomeCarouselModules = {
  basicGameCarousel: BasicGameCarouselModule;
  appPortrait: AppPortraitModule;
};

type WebpackRequire = ((id: string) => unknown) & {
  m?: Record<string, unknown>;
};

type CapturePair = {
  chunkArray: any[];
  require: WebpackRequire;
};

type TimerHandle = unknown;

type HomeCarouselTitleFixDependencies = {
  getSharedWindow: () => any;
  getPopupManager: () => any;
  getBigPictureDocument: (popupManager: any) => Document | undefined;
  setLifecycleInterval: (callback: () => void, delay: number) => TimerHandle;
  clearLifecycleInterval: (handle: TimerHandle) => void;
  scheduleCleanup: (callback: () => void) => TimerHandle;
  cancelCleanup: (handle: TimerHandle) => void;
  isPointerHovered: (element: Element) => boolean;
  now: () => number;
  breakerWindowMs: number;
  breakerPassLimit: number;
};

type Binding = {
  root: Element | undefined;
  observer: MutationObserver | undefined;
  pointerLeave: EventListener | undefined;
  removed: Map<Element, Set<string>>;
  scheduled: boolean;
  scheduledHandle: TimerHandle | undefined;
  active: boolean;
  breakerOpen: boolean;
  breakerWindowStartedAt: number;
  breakerPassCount: number;
  everEligible: boolean;
};

let moduleCapture: CapturePair | undefined;
let resolvedModuleCache:
  | { require: WebpackRequire; modules: ResolvedHomeCarouselModules }
  | undefined;

function safeDebug(...args: unknown[]): void {
  try {
    log.debug("home-carousel", ...args);
  } catch {
    // Logging must never affect Steam UI.
  }
}

function safeWarn(...args: unknown[]): void {
  try {
    log.warn("home-carousel", ...args);
  } catch {
    // Logging must never affect Steam UI.
  }
}

function isClassModule<T extends readonly string[]>(
  value: unknown,
  keys: T,
): value is Record<T[number], string> {
  if (value === null || typeof value !== "object") return false;

  try {
    return keys.every((key) => {
      const token = (value as Record<string, unknown>)[key];
      return (
        typeof token === "string" &&
        token.length > 0 &&
        token.trim() === token &&
        !/\s/.test(token)
      );
    });
  } catch {
    return false;
  }
}

/** Resolve only CSS modules whose factories carry every stable export key. */
export function resolveHomeCarouselModules(
  candidateRequire: unknown,
): ResolvedHomeCarouselModules | undefined {
  if (typeof candidateRequire !== "function") return undefined;
  const webpackRequire = candidateRequire as WebpackRequire;

  try {
    const factories = webpackRequire.m;
    if (factories === null || typeof factories !== "object") return undefined;

    const survivors: Array<{
      id: string;
      basic: boolean;
      portrait: boolean;
    }> = [];

    for (const id of Object.keys(factories)) {
      let source: string;
      try {
        const factory = factories[id];
        if (typeof factory !== "function") continue;
        source = factory.toString();
      } catch {
        continue;
      }

      const basic = BASIC_GAME_CAROUSEL_KEYS.every((key) =>
        source.includes(key),
      );
      const portrait = APP_PORTRAIT_KEYS.every((key) => source.includes(key));
      if (!basic && !portrait) continue;

      survivors.push({ id, basic, portrait });
      if (survivors.length > MAX_FACTORY_SURVIVORS) {
        safeWarn("CSS-module candidate overflow; runtime remains inactive");
        return undefined;
      }
    }

    const basicMatches: BasicGameCarouselModule[] = [];
    const portraitMatches: AppPortraitModule[] = [];

    for (const survivor of survivors) {
      let exports: unknown;
      try {
        exports = webpackRequire(survivor.id);
      } catch {
        continue;
      }

      if (
        survivor.basic &&
        isClassModule(exports, BASIC_GAME_CAROUSEL_KEYS)
      ) {
        basicMatches.push(exports);
      }
      if (survivor.portrait && isClassModule(exports, APP_PORTRAIT_KEYS)) {
        portraitMatches.push(exports);
      }
    }

    if (basicMatches.length !== 1 || portraitMatches.length !== 1) {
      safeWarn(
        "CSS modules are unresolved or ambiguous; runtime remains inactive",
        `BasicGameCarousel=${basicMatches.length}`,
        `AppPortrait=${portraitMatches.length}`,
      );
      return undefined;
    }

    return {
      basicGameCarousel: basicMatches[0],
      appPortrait: portraitMatches[0],
    };
  } catch (error) {
    safeWarn("CSS-module resolution failed", error);
    return undefined;
  }
}

function persistedCapture(sharedWindow: any): unknown {
  try {
    return sharedWindow?.[CAPTURE_SYMBOL];
  } catch {
    return undefined;
  }
}

function persistCapture(sharedWindow: any, pair: unknown): void {
  try {
    Object.defineProperty(sharedWindow, CAPTURE_SYMBOL, {
      configurable: true,
      value: pair,
    });
  } catch (error) {
    safeWarn("webpack require capture persistence failed", error);
  }
}

function captureWebpackRequire(
  getSharedWindow: () => any,
): WebpackRequire | undefined {
  try {
    const sharedWindow = getSharedWindow();
    const chunkArray = sharedWindow?.webpackChunksteamui;
    if (!Array.isArray(chunkArray)) {
      safeDebug("webpack require capture unavailable: chunk array missing");
      return undefined;
    }

    if (moduleCapture?.chunkArray === chunkArray) {
      if (persistedCapture(sharedWindow) !== moduleCapture) {
        persistCapture(sharedWindow, moduleCapture);
      }
      return moduleCapture.require;
    }

    const persisted = persistedCapture(sharedWindow) as
      | Partial<CapturePair>
      | undefined;
    if (persisted?.chunkArray === chunkArray) {
      if (typeof persisted.require === "function") {
        moduleCapture = persisted as CapturePair;
        return moduleCapture.require;
      }

      safeDebug("webpack require capture already failed for this chunk array");
      return undefined;
    }

    let captured: WebpackRequire | undefined;
    try {
      chunkArray.push([
        [CAPTURE_CHUNK_ID],
        {},
        (webpackRequire: WebpackRequire) => {
          if (typeof webpackRequire === "function") captured = webpackRequire;
        },
      ]);
    } catch (error) {
      persistCapture(sharedWindow, { chunkArray, require: undefined });
      safeWarn("webpack require capture failed", error);
      return undefined;
    }

    if (!captured) {
      persistCapture(sharedWindow, { chunkArray, require: undefined });
      safeWarn("webpack require capture failed: callback was not invoked");
      return undefined;
    }

    const pair: CapturePair = { chunkArray, require: captured };
    moduleCapture = pair;
    persistCapture(sharedWindow, pair);
    return captured;
  } catch (error) {
    safeWarn("webpack require capture failed", error);
    return undefined;
  }
}

function resolveRuntimeModules(
  getSharedWindow: () => any,
): ResolvedHomeCarouselModules | undefined {
  const webpackRequire = captureWebpackRequire(getSharedWindow);
  if (!webpackRequire) return undefined;
  if (resolvedModuleCache?.require === webpackRequire) {
    return resolvedModuleCache.modules;
  }

  const modules = resolveHomeCarouselModules(webpackRequire);
  if (modules) resolvedModuleCache = { require: webpackRequire, modules };
  return modules;
}

function cssEscape(value: string): string {
  try {
    const nativeEscape = (globalThis as any)?.CSS?.escape;
    if (typeof nativeEscape === "function") return nativeEscape(value);
  } catch {
    // Use the local standards-compatible fallback below.
  }

  let escaped = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const character = value[index];
    if (code === 0) {
      escaped += "�";
    } else if (
      (code >= 1 && code <= 31) ||
      code === 127 ||
      (index === 0 && code >= 48 && code <= 57) ||
      (index === 1 && code >= 48 && code <= 57 && value[0] === "-")
    ) {
      escaped += `\\${code.toString(16)} `;
    } else if (
      code >= 128 ||
      character === "-" ||
      character === "_" ||
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122)
    ) {
      escaped += character;
    } else {
      escaped += `\\${character}`;
    }
  }
  return escaped;
}

function selector(token: string): string {
  return `.${cssEscape(token)}`;
}

function queryElements(root: ParentNode, token: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector(token)));
  } catch {
    return [];
  }
}

function findOwnedTarget(
  mediaCard: Element,
  roleToken: string,
  mediaToken: string,
): Element | undefined {
  const mediaSelector = selector(mediaToken);
  for (const candidate of queryElements(mediaCard, roleToken)) {
    try {
      if (candidate.closest(mediaSelector) === mediaCard) return candidate;
    } catch {
      // Ignore a live node that detached while it was inspected.
    }
  }
  return undefined;
}

function reactExpectsToken(element: Element, token: string): boolean {
  let expectation: boolean | undefined;
  try {
    for (const key of Object.getOwnPropertyNames(element)) {
      if (!key.startsWith("__reactProps$")) continue;

      try {
        const className = (element as any)[key]?.className;
        if (typeof className !== "string") continue;
        const nextExpectation = className.split(/\s+/).includes(token);
        if (expectation !== undefined && expectation !== nextExpectation) {
          return false;
        }
        expectation = nextExpectation;
      } catch {
        // A stale React property is not restoration authority.
      }
    }
  } catch {
    // Treat unreadable React internals as absent.
  }
  return expectation === true;
}

function defaultDependencies(): HomeCarouselTitleFixDependencies {
  return {
    getSharedWindow: () => {
      try {
        return window;
      } catch {
        return undefined;
      }
    },
    getPopupManager: () => steamGlobals.getPopupManager(),
    getBigPictureDocument,
    setLifecycleInterval: (callback, delay) => setInterval(callback, delay),
    clearLifecycleInterval: (handle) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
    scheduleCleanup: (callback) => setTimeout(callback, 0),
    cancelCleanup: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    isPointerHovered: (element) => {
      try {
        return element.matches(":hover");
      } catch {
        return true;
      }
    },
    now: () => {
      try {
        return performance.now();
      } catch {
        return Date.now();
      }
    },
    breakerWindowMs: DEFAULT_BREAKER_WINDOW_MS,
    breakerPassLimit: DEFAULT_BREAKER_PASS_LIMIT,
  };
}

/** Install the bounded Home-carousel stale-hover repair. */
export function installHomeCarouselTitleFix(
  overrides: Partial<HomeCarouselTitleFixDependencies> = {},
): () => void {
  const dependencies = { ...defaultDependencies(), ...overrides };
  const bindings = new Map<Element, Binding>();
  let currentDocument: Document | undefined;
  let currentModules: ResolvedHomeCarouselModules | undefined;
  let lifecycleHandle: TimerHandle | undefined;
  let disposed = false;
  let missingDocumentLogged = false;

  const cancelScheduled = (binding: Binding): void => {
    if (!binding.scheduled) return;
    binding.scheduled = false;
    const handle = binding.scheduledHandle;
    binding.scheduledHandle = undefined;
    if (handle === undefined) return;
    try {
      dependencies.cancelCleanup(handle);
    } catch (error) {
      safeWarn("queued cleanup cancellation failed", error);
    }
  };

  const detachBindingActivity = (binding: Binding): void => {
    cancelScheduled(binding);
    try {
      binding.observer?.disconnect();
    } catch (error) {
      safeWarn("carousel observer disconnect failed", error);
    }
    binding.observer = undefined;

    const root = binding.root;
    const pointerLeave = binding.pointerLeave;
    if (root && pointerLeave) {
      try {
        root.removeEventListener("pointerleave", pointerLeave, true);
      } catch (error) {
        safeWarn("carousel pointer listener removal failed", error);
      }
    }
    binding.pointerLeave = undefined;
  };

  const teardownBinding = (binding: Binding): void => {
    if (!binding.active && !binding.root) return;
    binding.active = false;
    detachBindingActivity(binding);

    if (!binding.everEligible) {
      safeDebug("focus guard never became eligible during carousel binding");
    }

    for (const [element, tokens] of binding.removed) {
      try {
        if (!element.isConnected) continue;
        for (const token of tokens) {
          if (
            !element.classList.contains(token) &&
            reactExpectsToken(element, token)
          ) {
            element.classList.add(token);
          }
        }
      } catch {
        // Teardown is best-effort for live React-owned elements.
      }
    }

    binding.removed.clear();
    binding.root = undefined;
    binding.breakerPassCount = 0;
    binding.breakerWindowStartedAt = 0;
  };

  const openCircuitBreaker = (binding: Binding): void => {
    if (binding.breakerOpen) return;
    binding.breakerOpen = true;
    detachBindingActivity(binding);
    safeWarn("carousel cleanup circuit breaker opened");
  };

  const cleanupBinding = (binding: Binding): void => {
    if (disposed || !binding.active || binding.breakerOpen) return;
    const root = binding.root;
    if (!root) return;

    let now: number;
    try {
      now = dependencies.now();
    } catch (error) {
      safeWarn("carousel cleanup clock failed", error);
      openCircuitBreaker(binding);
      return;
    }

    if (
      !Number.isFinite(now) ||
      now - binding.breakerWindowStartedAt >= dependencies.breakerWindowMs ||
      now < binding.breakerWindowStartedAt
    ) {
      binding.breakerWindowStartedAt = Number.isFinite(now) ? now : 0;
      binding.breakerPassCount = 0;
    }
    binding.breakerPassCount += 1;
    if (binding.breakerPassCount > dependencies.breakerPassLimit) {
      openCircuitBreaker(binding);
      return;
    }

    for (const element of binding.removed.keys()) {
      try {
        if (!element.isConnected) binding.removed.delete(element);
      } catch {
        binding.removed.delete(element);
      }
    }

    const basic = currentModules?.basicGameCarousel;
    const portrait = currentModules?.appPortrait;
    if (!basic || !portrait) return;

    const mediaCards = queryElements(
      root,
      basic.BasicGameCarouselItemMediaContainer,
    );
    const eligible = mediaCards.some((mediaCard) => {
      try {
        return mediaCard.classList.contains("gpfocuswithin");
      } catch {
        return false;
      }
    });
    if (!eligible) return;
    binding.everEligible = true;

    const removeToken = (element: Element | undefined, token: string): void => {
      if (!element) return;
      try {
        if (!element.classList.contains(token)) return;
        element.classList.remove(token);
        let tokens = binding.removed.get(element);
        if (!tokens) {
          tokens = new Set<string>();
          binding.removed.set(element, tokens);
        }
        tokens.add(token);
      } catch {
        // Skip one malformed or detached target and continue other roles.
      }
    };

    for (const mediaCard of mediaCards) {
      try {
        if (mediaCard.classList.contains("gpfocuswithin")) continue;
      } catch {
        continue;
      }

      let pointerHovered = true;
      try {
        pointerHovered = dependencies.isPointerHovered(mediaCard);
      } catch (error) {
        safeWarn("pointer hover lookup failed", error);
      }
      if (pointerHovered) continue;

      removeToken(
        findOwnedTarget(
          mediaCard,
          basic.CarouselGameLabelWrapper,
          basic.BasicGameCarouselItemMediaContainer,
        ),
        basic.ShowAsHovered,
      );
      removeToken(
        findOwnedTarget(
          mediaCard,
          basic.CarouselCapsuleBackgroundGlow,
          basic.BasicGameCarouselItemMediaContainer,
        ),
        basic.ShowAsHovered,
      );
      removeToken(
        findOwnedTarget(
          mediaCard,
          portrait.LibraryItemBox,
          basic.BasicGameCarouselItemMediaContainer,
        ),
        portrait.ShowAsHovered,
      );
    }
  };

  const scheduleBindingCleanup = (binding: Binding): void => {
    if (
      disposed ||
      !binding.active ||
      binding.breakerOpen ||
      binding.scheduled
    ) {
      return;
    }

    binding.scheduled = true;
    let invokedSynchronously = false;
    try {
      const handle = dependencies.scheduleCleanup(() => {
        invokedSynchronously = true;
        binding.scheduled = false;
        binding.scheduledHandle = undefined;
        cleanupBinding(binding);
      });
      if (!invokedSynchronously) binding.scheduledHandle = handle;
    } catch (error) {
      binding.scheduled = false;
      binding.scheduledHandle = undefined;
      safeWarn("carousel cleanup scheduling failed", error);
    }
  };

  const createBinding = (
    root: Element,
    modules: ResolvedHomeCarouselModules,
  ): Binding | undefined => {
    const binding: Binding = {
      root,
      observer: undefined,
      pointerLeave: undefined,
      removed: new Map(),
      scheduled: false,
      scheduledHandle: undefined,
      active: true,
      breakerOpen: false,
      breakerWindowStartedAt: dependencies.now(),
      breakerPassCount: 0,
      everEligible: false,
    };

    try {
      const ownerWindow = root.ownerDocument?.defaultView;
      const MutationObserverClass =
        ownerWindow?.MutationObserver ?? globalThis.MutationObserver;
      if (typeof MutationObserverClass !== "function") {
        safeWarn("carousel MutationObserver is unavailable");
        return undefined;
      }

      binding.observer = new MutationObserverClass(() => {
        scheduleBindingCleanup(binding);
      });
      binding.observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["class"],
      });

      binding.pointerLeave = ((event: Event) => {
        try {
          const target = event.target as Element | null;
          if (
            !target?.classList?.contains(
              modules.basicGameCarousel.BasicGameCarouselItemMediaContainer,
            )
          ) {
            return;
          }
        } catch {
          return;
        }
        scheduleBindingCleanup(binding);
      }) as EventListener;
      root.addEventListener("pointerleave", binding.pointerLeave, true);

      cleanupBinding(binding);
      return binding;
    } catch (error) {
      safeWarn("carousel binding failed", error);
      teardownBinding(binding);
      return undefined;
    }
  };

  const clearBindings = (): void => {
    for (const binding of bindings.values()) teardownBinding(binding);
    bindings.clear();
  };

  const lifecycleTick = (): void => {
    if (disposed) return;

    try {
      const modules = resolveRuntimeModules(dependencies.getSharedWindow);
      if (!modules) {
        if (bindings.size > 0) clearBindings();
        currentDocument = undefined;
        currentModules = undefined;
        return;
      }

      const popupManager = dependencies.getPopupManager();
      const nextDocument = dependencies.getBigPictureDocument(popupManager);
      if (!nextDocument) {
        if (bindings.size > 0) clearBindings();
        currentDocument = undefined;
        if (!missingDocumentLogged) {
          missingDocumentLogged = true;
          safeWarn("Big Picture popup or document is unavailable");
        }
        return;
      }
      missingDocumentLogged = false;

      const nextRoots = new Set(
        queryElements(nextDocument, modules.basicGameCarousel.BasicGameCarousel),
      );
      if (nextDocument !== currentDocument || modules !== currentModules) {
        clearBindings();
        currentDocument = nextDocument;
        currentModules = modules;
      }

      for (const [root, binding] of bindings) {
        if (nextRoots.has(root)) continue;
        bindings.delete(root);
        teardownBinding(binding);
      }

      for (const root of nextRoots) {
        if (bindings.has(root)) continue;
        const binding = createBinding(root, modules);
        if (binding) bindings.set(root, binding);
      }
    } catch (error) {
      safeWarn("Home-carousel lifecycle tick failed", error);
    }
  };

  lifecycleTick();
  try {
    lifecycleHandle = dependencies.setLifecycleInterval(
      lifecycleTick,
      LIFECYCLE_INTERVAL_MS,
    );
  } catch (error) {
    safeWarn("Home-carousel lifecycle scheduling failed", error);
  }

  return () => {
    if (disposed) return;
    disposed = true;

    if (lifecycleHandle !== undefined) {
      try {
        dependencies.clearLifecycleInterval(lifecycleHandle);
      } catch (error) {
        safeWarn("Home-carousel lifecycle timer cleanup failed", error);
      }
      lifecycleHandle = undefined;
    }

    clearBindings();
    currentDocument = undefined;
    currentModules = undefined;
  };
}
