import { getBigPictureDocument, steamGlobals } from "./achievementBar";
import * as log from "./log";

// The manager instance can be replaced, so a slow watchdog re-subscribes.
const LIFECYCLE_INTERVAL_MS = 1_000;
// Steam animates the resize over roughly half a second; poll until the
// container is back to its pre-keyboard height rather than guessing a delay.
const RESTORE_POLL_MS = 50;
const RESTORE_TIMEOUT_MS = 2_000;
// Ignore sub-pixel and rounding noise when deciding what is scrollable.
const MIN_SCROLLABLE_PX = 4;
// A resize only ever affects a handful of containers; cap the bookkeeping.
const MAX_TRACKED_ELEMENTS = 200;

type TimerHandle = unknown;

type ScrollRecord = {
  element: Element;
  scrollTop: number;
  clientHeight: number;
};

type KeyboardScrollRestoreDependencies = {
  getVirtualKeyboardManager: () => any | undefined;
  getDocument: () => Document | undefined;
  setLifecycleInterval: (callback: () => void, delay: number) => TimerHandle;
  clearLifecycleInterval: (handle: TimerHandle) => void;
  schedule: (callback: () => void, delay: number) => TimerHandle;
  cancel: (handle: TimerHandle) => void;
  lifecycleIntervalMs: number;
  restorePollMs: number;
  restoreTimeoutMs: number;
};

function safeDebug(...args: unknown[]): void {
  try {
    log.debug("keyboard-scroll", ...args);
  } catch {
    // Logging must never affect Steam UI.
  }
}

function safeWarn(...args: unknown[]): void {
  try {
    log.warn("keyboard-scroll", ...args);
  } catch {
    // Logging must never affect Steam UI.
  }
}

function defaultDependencies(): KeyboardScrollRestoreDependencies {
  return {
    getVirtualKeyboardManager: () => {
      try {
        return (window as any)?.SteamUIStore?.ActiveWindowInstance
          ?.m_VirtualKeyboardManager;
      } catch {
        return undefined;
      }
    },
    getDocument: () => {
      try {
        return getBigPictureDocument(steamGlobals.getPopupManager());
      } catch {
        return undefined;
      }
    },
    setLifecycleInterval: (callback, delay) => setInterval(callback, delay),
    clearLifecycleInterval: (handle) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
    schedule: (callback, delay) => setTimeout(callback, delay),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    lifecycleIntervalMs: LIFECYCLE_INTERVAL_MS,
    restorePollMs: RESTORE_POLL_MS,
    restoreTimeoutMs: RESTORE_TIMEOUT_MS,
  };
}

/**
 * Restore scroll position after the on-screen keyboard closes.
 *
 * Steam reserves space for the keyboard by shrinking the content container
 * (854x534 viewport: 534px -> 295px for a 239px keyboard) and the scroll
 * position moves down by the same amount to keep content anchored. When the
 * keyboard closes the container returns to full height but `scrollTop` is left
 * where it was, so the view stays displaced — permanently, and it accumulates
 * across open/close cycles.
 *
 * `IsShowingVirtualKeyboard` fires *before* the animated resize begins, so the
 * values read synchronously on show are the pristine pre-keyboard ones. On hide
 * this waits for each container to return to its recorded height, then puts the
 * recorded scroll position back.
 *
 * Independent of any CSSLoader theme: the container is scrollable on stock too,
 * a theme only makes the displacement larger.
 */
export function installKeyboardScrollRestore(
  overrides: Partial<KeyboardScrollRestoreDependencies> = {},
): () => void {
  const dependencies = { ...defaultDependencies(), ...overrides };
  let disposed = false;
  let subscription: { Unsubscribe?: () => void } | undefined;
  let subscribedManager: unknown;
  let lifecycleHandle: TimerHandle | undefined;
  let restoreHandle: TimerHandle | undefined;
  let records: ScrollRecord[] = [];

  const cancelRestore = (): void => {
    if (restoreHandle === undefined) return;
    try {
      dependencies.cancel(restoreHandle);
    } catch (error) {
      safeWarn("restore timer cleanup failed", error);
    }
    restoreHandle = undefined;
  };

  const capture = (): void => {
    records = [];
    const document = dependencies.getDocument();
    if (!document) return;
    try {
      for (const element of document.querySelectorAll("*")) {
        if (records.length >= MAX_TRACKED_ELEMENTS) break;
        const { scrollHeight, clientHeight, scrollTop } = element;
        if (scrollHeight - clientHeight <= MIN_SCROLLABLE_PX) continue;
        records.push({ element, scrollTop, clientHeight });
      }
    } catch (error) {
      safeWarn("scroll capture failed", error);
      records = [];
      return;
    }
    safeDebug("captured scroll positions", records.length);
  };

  const applyRestore = (): number => {
    let restored = 0;
    for (const record of records) {
      try {
        const element = record.element;
        if (!element.isConnected) continue;
        // Only touch containers the keyboard actually resized and that have
        // since returned to their previous height.
        if (element.clientHeight !== record.clientHeight) continue;
        if (Math.round(element.scrollTop) === Math.round(record.scrollTop)) continue;
        element.scrollTop = record.scrollTop;
        restored += 1;
      } catch (error) {
        safeWarn("scroll restore failed for one container", error);
      }
    }
    return restored;
  };

  const pendingRestoreTargets = (): number =>
    records.filter((record) => {
      try {
        return (
          record.element.isConnected &&
          record.element.clientHeight !== record.clientHeight
        );
      } catch {
        return false;
      }
    }).length;

  const scheduleRestore = (): void => {
    if (disposed || records.length === 0) return;
    cancelRestore();
    const deadline = dependencies.restoreTimeoutMs;
    let waited = 0;

    const poll = (): void => {
      restoreHandle = undefined;
      if (disposed) return;
      try {
        // Wait for Steam's resize animation to put the containers back.
        if (pendingRestoreTargets() > 0 && waited < deadline) {
          waited += dependencies.restorePollMs;
          restoreHandle = dependencies.schedule(poll, dependencies.restorePollMs);
          return;
        }
        const restored = applyRestore();
        safeDebug("restored scroll positions", restored, "after", waited, "ms");
      } catch (error) {
        safeWarn("scroll restore pass failed", error);
      }
      // Only reached once the pass is finished; the reschedule path returns
      // above so the captured records survive between polls.
      records = [];
    };

    restoreHandle = dependencies.schedule(poll, dependencies.restorePollMs);
  };

  const onShowingChanged = (showing: unknown): void => {
    try {
      if (disposed) return;
      if (showing) {
        cancelRestore();
        capture();
      } else {
        scheduleRestore();
      }
    } catch (error) {
      safeWarn("keyboard visibility handling failed", error);
    }
  };

  const unsubscribe = (): void => {
    if (!subscription) return;
    try {
      subscription.Unsubscribe?.();
    } catch (error) {
      safeWarn("keyboard visibility unsubscribe failed", error);
    }
    subscription = undefined;
    subscribedManager = undefined;
  };

  const ensureSubscription = (): void => {
    if (disposed) return;
    try {
      const manager = dependencies.getVirtualKeyboardManager();
      if (!manager) return;
      if (manager === subscribedManager && subscription) return;
      unsubscribe();
      const observable = manager.IsShowingVirtualKeyboard;
      if (typeof observable?.Subscribe !== "function") return;
      subscription = observable.Subscribe(onShowingChanged);
      subscribedManager = manager;
      safeDebug("subscribed to keyboard visibility");
    } catch (error) {
      safeWarn("keyboard visibility subscription failed", error);
    }
  };

  ensureSubscription();
  try {
    lifecycleHandle = dependencies.setLifecycleInterval(
      ensureSubscription,
      dependencies.lifecycleIntervalMs,
    );
  } catch (error) {
    safeWarn("lifecycle scheduling failed", error);
  }

  return () => {
    if (disposed) return;
    disposed = true;

    if (lifecycleHandle !== undefined) {
      try {
        dependencies.clearLifecycleInterval(lifecycleHandle);
      } catch (error) {
        safeWarn("lifecycle timer cleanup failed", error);
      }
      lifecycleHandle = undefined;
    }

    cancelRestore();
    unsubscribe();
    records = [];
  };
}
