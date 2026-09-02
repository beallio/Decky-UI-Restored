import { describe, expect, it, vi } from "vitest";
import { installKeyboardScrollRestore } from "./keyboardScrollRestore";

// The default document boundary comes from achievementBar, whose real module
// imports Decky's virtual manifest, which is not present in the unit runner.
vi.mock("./achievementBar", () => ({
  getBigPictureDocument: vi.fn(() => undefined),
  steamGlobals: { getPopupManager: vi.fn(() => undefined) },
}));

type FakeElement = {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  isConnected: boolean;
};

function element(overrides: Partial<FakeElement> = {}): FakeElement {
  return {
    scrollTop: 0,
    clientHeight: 534,
    scrollHeight: 1023,
    isConnected: true,
    ...overrides,
  };
}

function harness(elements: FakeElement[]) {
  let handler: ((showing: unknown) => void) | undefined;
  const Unsubscribe = vi.fn();
  const observable = {
    Subscribe: vi.fn((cb: (showing: unknown) => void) => {
      handler = cb;
      return { Unsubscribe };
    }),
  };
  let manager: any = { IsShowingVirtualKeyboard: observable };
  const timers: Array<{ handle: number; callback: () => void }> = [];
  let nextHandle = 1;
  let lifecycle: (() => void) | undefined;

  const dependencies = {
    getVirtualKeyboardManager: vi.fn(() => manager),
    getDocument: vi.fn(() => ({ querySelectorAll: () => elements }) as any),
    setLifecycleInterval: vi.fn((callback: () => void) => {
      lifecycle = callback;
      return 999;
    }),
    clearLifecycleInterval: vi.fn(),
    schedule: vi.fn((callback: () => void) => {
      const handle = nextHandle++;
      timers.push({ handle, callback });
      return handle;
    }),
    cancel: vi.fn((handle: unknown) => {
      const index = timers.findIndex((t) => t.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    }),
    lifecycleIntervalMs: 1000,
    restorePollMs: 50,
    restoreTimeoutMs: 200,
  };

  return {
    dependencies,
    Unsubscribe,
    observable,
    timers,
    show: () => handler?.(true),
    hide: () => handler?.(false),
    tick: () => {
      const queued = timers.splice(0, timers.length);
      queued.forEach((t) => t.callback());
    },
    drain: (max = 20) => {
      for (let i = 0; i < max && timers.length; i++) {
        const queued = timers.splice(0, timers.length);
        queued.forEach((t) => t.callback());
      }
    },
    runLifecycle: () => lifecycle?.(),
    setManager: (next: any) => {
      manager = next;
    },
  };
}

function install(h: ReturnType<typeof harness>) {
  return installKeyboardScrollRestore(h.dependencies as any);
}

describe("installKeyboardScrollRestore", () => {
  it("restores the pre-keyboard scroll position once the container is back", () => {
    const scroller = element({ scrollTop: 0, clientHeight: 534 });
    const h = harness([scroller]);
    install(h);

    h.show();
    // Steam shrinks the container and the scroll anchors downward.
    scroller.clientHeight = 295;
    scroller.scrollTop = 239;

    h.hide();
    // Still animating: the height has not returned, so nothing is touched yet.
    h.tick();
    expect(scroller.scrollTop).toBe(239);

    scroller.clientHeight = 534;
    h.drain();
    expect(scroller.scrollTop).toBe(0);
  });

  it("preserves a scroll offset the user had before the keyboard opened", () => {
    const scroller = element({ scrollTop: 120, clientHeight: 534 });
    const h = harness([scroller]);
    install(h);

    h.show();
    scroller.clientHeight = 295;
    scroller.scrollTop = 359;
    h.hide();
    scroller.clientHeight = 534;
    h.drain();

    expect(scroller.scrollTop).toBe(120);
  });

  it("ignores containers that are not scrollable", () => {
    const fixed = element({ clientHeight: 534, scrollHeight: 534, scrollTop: 0 });
    const h = harness([fixed]);
    install(h);

    h.show();
    fixed.scrollTop = 42;
    h.hide();
    h.drain();

    expect(fixed.scrollTop).toBe(42);
  });

  it("leaves containers whose height never returned", () => {
    const scroller = element();
    const h = harness([scroller]);
    install(h);

    h.show();
    scroller.clientHeight = 295;
    scroller.scrollTop = 239;
    h.hide();
    h.drain(); // height never comes back; timeout elapses

    expect(scroller.scrollTop).toBe(239);
  });

  it("gives up after the restore timeout instead of polling forever", () => {
    const scroller = element();
    const h = harness([scroller]);
    install(h);

    h.show();
    scroller.clientHeight = 295;
    h.hide();
    h.drain(50);

    expect(h.timers).toHaveLength(0);
  });

  it("skips detached elements", () => {
    const scroller = element();
    const h = harness([scroller]);
    install(h);

    h.show();
    scroller.clientHeight = 295;
    scroller.scrollTop = 239;
    h.hide();
    scroller.clientHeight = 534;
    scroller.isConnected = false;
    h.drain();

    expect(scroller.scrollTop).toBe(239);
  });

  it("re-subscribes when the keyboard manager instance is replaced", () => {
    const h = harness([element()]);
    install(h);
    expect(h.observable.Subscribe).toHaveBeenCalledOnce();

    h.runLifecycle();
    expect(h.observable.Subscribe).toHaveBeenCalledOnce();

    const replacement = { IsShowingVirtualKeyboard: { Subscribe: vi.fn(() => ({ Unsubscribe: vi.fn() })) } };
    h.setManager(replacement);
    h.runLifecycle();

    expect(h.Unsubscribe).toHaveBeenCalledOnce();
    expect(replacement.IsShowingVirtualKeyboard.Subscribe).toHaveBeenCalledOnce();
  });

  it("waits for the manager to appear when it is missing at install", () => {
    const h = harness([element()]);
    h.setManager(undefined);
    install(h);
    expect(h.observable.Subscribe).not.toHaveBeenCalled();

    h.setManager({ IsShowingVirtualKeyboard: h.observable });
    h.runLifecycle();
    expect(h.observable.Subscribe).toHaveBeenCalledOnce();
  });

  it("cancels a pending restore when the keyboard reopens", () => {
    const scroller = element();
    const h = harness([scroller]);
    install(h);

    h.show();
    scroller.clientHeight = 295;
    scroller.scrollTop = 239;
    h.hide();
    h.show(); // reopened before the restore ran
    h.drain();

    expect(scroller.scrollTop).toBe(239);
  });

  it("unsubscribes and clears timers on dispose", () => {
    const scroller = element();
    const h = harness([scroller]);
    const dispose = install(h);

    h.show();
    scroller.clientHeight = 295;
    scroller.scrollTop = 239;
    h.hide();
    dispose();

    expect(h.Unsubscribe).toHaveBeenCalledOnce();
    expect(h.dependencies.clearLifecycleInterval).toHaveBeenCalledOnce();

    scroller.clientHeight = 534;
    h.drain();
    expect(scroller.scrollTop).toBe(239);
  });

  it("is terminal and safe to dispose twice", () => {
    const h = harness([element()]);
    const dispose = install(h);

    dispose();
    dispose();

    expect(h.Unsubscribe).toHaveBeenCalledOnce();
    expect(() => h.runLifecycle()).not.toThrow();
  });

  it("never lets a document failure escape into the Steam UI", () => {
    const h = harness([element()]);
    h.dependencies.getDocument.mockImplementation(() => {
      throw new Error("document exploded");
    });
    install(h);

    expect(() => h.show()).not.toThrow();
    expect(() => h.hide()).not.toThrow();
  });

  it("tolerates a subscription failure at install", () => {
    const h = harness([element()]);
    h.observable.Subscribe.mockImplementation(() => {
      throw new Error("subscribe exploded");
    });

    expect(() => install(h)).not.toThrow();
  });
});
