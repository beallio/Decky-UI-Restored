import * as log from "./log";

// Steam's own chord handler runs asynchronously, roughly 100ms after the client
// message arrives. Re-dispatching sooner opens the keyboard first, and Steam's
// late handler then finds one open and takes its toggle-close branch. Wait long
// enough that Steam always goes first.
const DISPATCH_DELAY_MS = 300;

// `Pe.sc` in Steam's minified `OnModalKeyboardMessage`: the "no app running"
// sentinel the handler compares `nAppID` against.
const NO_RUNNING_APP_APPID = 0;

type KeyboardMessage = {
  bChordInvoked?: boolean;
  nAppID?: number;
  [key: string]: unknown;
};

type Registration = { unregister?: () => void } | undefined;

type TimerHandle = unknown;

type KeyboardChordFixDependencies = {
  registerForKeyboardMessages: (
    callback: (message: KeyboardMessage) => void,
  ) => Registration;
  /** `true`/`false` when readable, `undefined` when Steam state cannot be resolved. */
  isKeyboardShowing: () => boolean | undefined;
  dispatchModalKeyboardMessage: (message: KeyboardMessage) => void;
  schedule: (callback: () => void, delay: number) => TimerHandle;
  cancel: (handle: TimerHandle) => void;
  dispatchDelayMs: number;
};

function safeDebug(...args: unknown[]): void {
  try {
    log.debug("keyboard-chord", ...args);
  } catch {
    // Logging must never affect Steam UI.
  }
}

function safeWarn(...args: unknown[]): void {
  try {
    log.warn("keyboard-chord", ...args);
  } catch {
    // Logging must never affect Steam UI.
  }
}

function steamClientInput(): any | undefined {
  try {
    return (window as any)?.SteamClient?.Input;
  } catch {
    return undefined;
  }
}

function steamUIStore(): any | undefined {
  try {
    return (window as any)?.SteamUIStore;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the active window's keyboard manager per call.
 *
 * `ActiveWindowInstance` can change across the plugin's lifetime, so this is
 * never captured at install time.
 */
function virtualKeyboardManager(): any | undefined {
  try {
    return steamUIStore()?.ActiveWindowInstance?.m_VirtualKeyboardManager;
  } catch {
    return undefined;
  }
}

function defaultDependencies(): KeyboardChordFixDependencies {
  return {
    registerForKeyboardMessages: (callback) => {
      const input = steamClientInput();
      if (typeof input?.RegisterForUserKeyboardMessages !== "function") {
        throw new Error(
          "SteamClient.Input.RegisterForUserKeyboardMessages is unavailable",
        );
      }
      return input.RegisterForUserKeyboardMessages(callback);
    },
    isKeyboardShowing: () => {
      try {
        const observable = virtualKeyboardManager()?.IsShowingVirtualKeyboard;
        if (!observable || typeof observable !== "object") return undefined;
        if (!("Value" in observable)) return undefined;
        return Boolean((observable as { Value: unknown }).Value);
      } catch {
        return undefined;
      }
    },
    dispatchModalKeyboardMessage: (message) => {
      const store = steamUIStore();
      if (typeof store?.OnModalKeyboardMessage !== "function") {
        throw new Error("SteamUIStore.OnModalKeyboardMessage is unavailable");
      }
      // The property is non-writable and non-configurable, so the handler
      // cannot be patched; re-dispatching a corrected message is the only route.
      store.OnModalKeyboardMessage(message);
    },
    schedule: (callback, delay) => setTimeout(callback, delay),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    dispatchDelayMs: DISPATCH_DELAY_MS,
  };
}

/**
 * Restore the STEAM + X on-screen keyboard chord.
 *
 * Steam's `OnModalKeyboardMessage` discards the chord with
 * `if (e.nAppID != Pe.sc && t.MainRunningAppID != e.nAppID) return;`. On the
 * Home screen the client sends the Steam UI's own appid (769) while
 * `MainRunningAppID` is correctly `undefined`, so both clauses hold and the
 * keyboard never mounts. Registrations are multicast, so this observes the same
 * message and re-dispatches it with the sentinel appid.
 *
 * Only opening needs help. Steam's toggle-close branch sits *before* the broken
 * appid check and still closes the keyboard correctly, so a chord that arrives
 * while the keyboard is open is left entirely to Steam.
 */
export function installKeyboardChordFix(
  overrides: Partial<KeyboardChordFixDependencies> = {},
): () => void {
  const dependencies = { ...defaultDependencies(), ...overrides };
  const pending = new Set<TimerHandle>();
  let disposed = false;

  const handleMessage = (message: KeyboardMessage): void => {
    try {
      if (disposed || !message || message.bChordInvoked !== true) return;

      // Builds without the regression already send the sentinel and open the
      // keyboard themselves; leave those completely alone.
      if (message.nAppID === NO_RUNNING_APP_APPID) return;

      // Sampled before Steam's delayed handler runs. An open keyboard here means
      // this chord is a close, which Steam performs correctly on its own.
      // `undefined` means Steam state was unreadable, so take no action.
      if (dependencies.isKeyboardShowing() !== false) return;

      let handle: TimerHandle;
      const openIfStillClosed = () => {
        pending.delete(handle);
        if (disposed) return;
        try {
          // Steam has had its turn by now. If it opened the keyboard (a fixed
          // build, or another code path), there is nothing left to do.
          if (dependencies.isKeyboardShowing() !== false) return;
          safeDebug("re-dispatching chord with sentinel appid", message.nAppID);
          dependencies.dispatchModalKeyboardMessage({
            ...message,
            nAppID: NO_RUNNING_APP_APPID,
          });
        } catch (error) {
          safeWarn("keyboard chord re-dispatch failed", error);
        }
      };

      handle = dependencies.schedule(
        openIfStillClosed,
        dependencies.dispatchDelayMs,
      );
      pending.add(handle);
    } catch (error) {
      safeWarn("keyboard chord message handling failed", error);
    }
  };

  // A failure here propagates so FeatureController fails closed and the toggle
  // reverts, rather than leaving a dead fix silently switched on.
  const registration = dependencies.registerForKeyboardMessages(handleMessage);
  safeDebug("keyboard chord fix installed");

  return () => {
    if (disposed) return;
    disposed = true;

    for (const handle of pending) {
      try {
        dependencies.cancel(handle);
      } catch (error) {
        safeWarn("keyboard chord timer cleanup failed", error);
      }
    }
    pending.clear();

    try {
      registration?.unregister?.();
    } catch (error) {
      safeWarn("keyboard chord unregister failed", error);
    }
  };
}
