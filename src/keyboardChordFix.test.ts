import { describe, expect, it, vi } from "vitest";
import { installKeyboardChordFix } from "./keyboardChordFix";

const STEAM_UI_APPID = 769;

type Harness = ReturnType<typeof harness>;

function harness(options: { showing?: boolean | undefined } = {}) {
  // `{ showing: undefined }` must mean "Steam state unreadable", not "absent".
  let showing: boolean | undefined = "showing" in options ? options.showing : false;
  const unregister = vi.fn();
  let handler: ((message: any) => void) | undefined;
  const scheduled: Array<{ handle: number; callback: () => void; delay: number }> =
    [];
  let nextHandle = 1;

  const dependencies = {
    registerForKeyboardMessages: vi.fn((callback: (message: any) => void) => {
      handler = callback;
      return { unregister };
    }),
    isKeyboardShowing: vi.fn(() => showing),
    dispatchModalKeyboardMessage: vi.fn((message: any) => {
      // Mirror Steam: a dispatched sentinel message opens the keyboard.
      if (message.nAppID === 0) showing = true;
    }),
    schedule: vi.fn((callback: () => void, delay: number) => {
      const handle = nextHandle++;
      scheduled.push({ handle, callback, delay });
      return handle;
    }),
    cancel: vi.fn(),
    dispatchDelayMs: 300,
  };

  return {
    dependencies,
    unregister,
    scheduled,
    send: (message: any) => handler?.(message),
    runScheduled: () => {
      const queued = scheduled.splice(0, scheduled.length);
      queued.forEach((entry) => entry.callback());
    },
    setShowing: (next: boolean | undefined) => {
      showing = next;
    },
    get showing() {
      return showing;
    },
  };
}

function chord(overrides: Record<string, unknown> = {}) {
  return {
    nControllerIndex: 15,
    bEnterDismissesKeyboard: true,
    bChordInvoked: true,
    nXPosition: 0,
    nYPosition: 0,
    nAppID: STEAM_UI_APPID,
    ...overrides,
  };
}

function install(h: Harness) {
  return installKeyboardChordFix(h.dependencies as any);
}

describe("installKeyboardChordFix", () => {
  it("re-dispatches a blocked chord with the sentinel appid, preserving the message", () => {
    const h = harness();
    install(h);

    h.send(chord());
    expect(h.dependencies.dispatchModalKeyboardMessage).not.toHaveBeenCalled();

    h.runScheduled();

    expect(h.dependencies.dispatchModalKeyboardMessage).toHaveBeenCalledOnce();
    const sent = h.dependencies.dispatchModalKeyboardMessage.mock.calls[0][0];
    expect(sent.nAppID).toBe(0);
    expect(sent.bChordInvoked).toBe(true);
    expect(sent.nControllerIndex).toBe(15);
    expect(sent.bEnterDismissesKeyboard).toBe(true);
  });

  it("waits for Steam's delayed handler before re-dispatching", () => {
    const h = harness();
    install(h);

    h.send(chord());

    expect(h.dependencies.schedule).toHaveBeenCalledOnce();
    expect(h.scheduled[0].delay).toBe(300);
  });

  it("leaves closing to Steam when the keyboard is already open", () => {
    const h = harness({ showing: true });
    install(h);

    h.send(chord());
    h.runScheduled();

    expect(h.dependencies.schedule).not.toHaveBeenCalled();
    expect(h.dependencies.dispatchModalKeyboardMessage).not.toHaveBeenCalled();
  });

  it("does nothing once Steam opened the keyboard itself during the delay", () => {
    const h = harness();
    install(h);

    h.send(chord());
    h.setShowing(true);
    h.runScheduled();

    expect(h.dependencies.dispatchModalKeyboardMessage).not.toHaveBeenCalled();
  });

  it("ignores builds that already send the sentinel appid", () => {
    const h = harness();
    install(h);

    h.send(chord({ nAppID: 0 }));
    h.runScheduled();

    expect(h.dependencies.schedule).not.toHaveBeenCalled();
    expect(h.dependencies.dispatchModalKeyboardMessage).not.toHaveBeenCalled();
  });

  it("ignores non-chord keyboard messages", () => {
    const h = harness();
    install(h);

    h.send(chord({ bChordInvoked: false }));
    h.send(chord({ bChordInvoked: undefined }));
    h.runScheduled();

    expect(h.dependencies.dispatchModalKeyboardMessage).not.toHaveBeenCalled();
  });

  it("takes no action when Steam keyboard state is unreadable", () => {
    const h = harness({ showing: undefined });
    install(h);

    h.send(chord());
    h.runScheduled();

    expect(h.dependencies.dispatchModalKeyboardMessage).not.toHaveBeenCalled();
  });

  it("alternates open and close across successive presses", () => {
    const h = harness();
    install(h);

    h.send(chord());
    h.runScheduled();
    expect(h.showing).toBe(true);
    expect(h.dependencies.dispatchModalKeyboardMessage).toHaveBeenCalledTimes(1);

    // Second press: Steam's toggle-close branch runs and closes it; the fix
    // must not reopen.
    h.send(chord());
    h.setShowing(false);
    h.runScheduled();
    expect(h.dependencies.dispatchModalKeyboardMessage).toHaveBeenCalledTimes(1);

    h.send(chord());
    h.runScheduled();
    expect(h.dependencies.dispatchModalKeyboardMessage).toHaveBeenCalledTimes(2);
  });

  it("unregisters and cancels pending work on dispose", () => {
    const h = harness();
    const dispose = install(h);

    h.send(chord());
    dispose();

    expect(h.unregister).toHaveBeenCalledOnce();
    expect(h.dependencies.cancel).toHaveBeenCalledOnce();

    h.runScheduled();
    expect(h.dependencies.dispatchModalKeyboardMessage).not.toHaveBeenCalled();
  });

  it("is inert after disposal and disposes only once", () => {
    const h = harness();
    const dispose = install(h);

    dispose();
    dispose();
    expect(h.unregister).toHaveBeenCalledOnce();

    h.send(chord());
    h.runScheduled();
    expect(h.dependencies.dispatchModalKeyboardMessage).not.toHaveBeenCalled();
  });

  it("propagates registration failure so the toggle fails closed", () => {
    const h = harness();
    h.dependencies.registerForKeyboardMessages.mockImplementation(() => {
      throw new Error("unavailable");
    });

    expect(() => install(h)).toThrow("unavailable");
  });

  it("never lets a dispatch failure escape into the Steam UI", () => {
    const h = harness();
    h.dependencies.dispatchModalKeyboardMessage.mockImplementation(() => {
      throw new Error("dispatch exploded");
    });
    install(h);

    h.send(chord());
    expect(() => h.runScheduled()).not.toThrow();
  });

  it("never lets a state-read failure escape into the Steam UI", () => {
    const h = harness();
    h.dependencies.isKeyboardShowing.mockImplementation(() => {
      throw new Error("state exploded");
    });
    install(h);

    expect(() => h.send(chord())).not.toThrow();
    expect(h.dependencies.dispatchModalKeyboardMessage).not.toHaveBeenCalled();
  });

  it("tolerates a registration object without unregister", () => {
    const h = harness();
    h.dependencies.registerForKeyboardMessages.mockImplementation(() => undefined);
    const dispose = install(h);

    expect(() => dispose()).not.toThrow();
  });
});
