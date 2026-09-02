import { describe, expect, it, vi } from "vitest";
import { SettingsCoordinator } from "./settingsCoordinator";
import type { PluginSettings } from "./backend";

const defaults: PluginSettings = {
  feature_enabled: true,
  home_carousel_fix_enabled: false,
  keyboard_chord_fix_enabled: false,
  debug_logging: false,
  update_channel: "stable",
  automatic_update_checks: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness() {
  let achievementEnabled = false;
  let homeCarouselEnabled = false;
  let keyboardChordEnabled = false;
  const achievementController = {
    get enabled() {
      return achievementEnabled;
    },
    setEnabled: vi.fn((next: boolean) => {
      achievementEnabled = next;
      return true;
    }),
    dispose: vi.fn(() => {
      achievementEnabled = false;
    }),
  };
  const homeCarouselController = {
    get enabled() {
      return homeCarouselEnabled;
    },
    setEnabled: vi.fn((next: boolean) => {
      homeCarouselEnabled = next;
      return true;
    }),
    dispose: vi.fn(() => {
      homeCarouselEnabled = false;
    }),
  };
  const keyboardChordController = {
    get enabled() {
      return keyboardChordEnabled;
    },
    setEnabled: vi.fn((next: boolean) => {
      keyboardChordEnabled = next;
      return true;
    }),
    dispose: vi.fn(() => {
      keyboardChordEnabled = false;
    }),
  };
  const loadSettings = vi.fn(async () => defaults);
  const setFeatureEnabled = vi.fn(async (feature_enabled: boolean) => ({
    ...defaults,
    feature_enabled,
  }));
  const setHomeCarouselFixEnabled = vi.fn(
    async (home_carousel_fix_enabled: boolean) => ({
      ...defaults,
      home_carousel_fix_enabled,
    }),
  );
  const setKeyboardChordFixEnabled = vi.fn(
    async (keyboard_chord_fix_enabled: boolean) => ({
      ...defaults,
      keyboard_chord_fix_enabled,
    }),
  );
  const setDebugLogging = vi.fn(async (debug_logging: boolean) => ({
    ...defaults,
    debug_logging,
  }));
  const setUpdateChannel = vi.fn(async (update_channel: "stable" | "development") => ({
    ...defaults,
    update_channel,
  }));
  const setAutomaticUpdateChecks = vi.fn(async (automatic_update_checks: boolean) => ({
    ...defaults,
    automatic_update_checks,
  }));
  const setVerboseLogging = vi.fn();
  const onError = vi.fn();
  const coordinator = new SettingsCoordinator({
    achievementController,
    homeCarouselController,
    keyboardChordController,
    defaults,
    loadSettings,
    setFeatureEnabled,
    setHomeCarouselFixEnabled,
    setKeyboardChordFixEnabled,
    setDebugLogging,
    setUpdateChannel,
    setAutomaticUpdateChecks,
    setVerboseLogging,
    onError,
  });
  return {
    achievementController,
    homeCarouselController,
    keyboardChordController,
    coordinator,
    loadSettings,
    onError,
    setDebugLogging,
    setUpdateChannel,
    setAutomaticUpdateChecks,
    setFeatureEnabled,
    setHomeCarouselFixEnabled,
    setKeyboardChordFixEnabled,
    setVerboseLogging,
  };
}

describe("SettingsCoordinator", () => {
  it("loads settings exactly once and shares the resulting snapshot", async () => {
    const pending = deferred<typeof defaults>();
    const test = harness();
    test.loadSettings.mockReturnValue(pending.promise);
    const snapshots: any[] = [];
    test.coordinator.subscribe((snapshot) => snapshots.push(snapshot));

    test.coordinator.start();
    test.coordinator.start();
    expect(test.loadSettings).toHaveBeenCalledOnce();

    pending.resolve({ ...defaults, feature_enabled: false, debug_logging: true });
    await pending.promise;
    await Promise.resolve();

    expect(test.coordinator.snapshot).toMatchObject({
      settings: { ...defaults, feature_enabled: false, debug_logging: true },
      loaded: true,
    });
    expect(test.achievementController.setEnabled).toHaveBeenLastCalledWith(false);
    expect(test.homeCarouselController.setEnabled).toHaveBeenLastCalledWith(false);
    expect(test.setVerboseLogging).toHaveBeenLastCalledWith(true);
    expect(snapshots[snapshots.length - 1]).toEqual(test.coordinator.snapshot);
  });

  it("serializes cross-toggle writes and applies backend responses in order", async () => {
    const feature = deferred<typeof defaults>();
    const debug = deferred<typeof defaults>();
    const test = harness();
    test.setFeatureEnabled.mockReturnValue(feature.promise);
    test.setDebugLogging.mockReturnValue(debug.promise);
    test.coordinator.start();
    await Promise.resolve();
    await Promise.resolve();

    const first = test.coordinator.setFeatureEnabled(false);
    const second = test.coordinator.setDebugLogging(true);
    await Promise.resolve();
    expect(test.setFeatureEnabled).toHaveBeenCalledWith(false);
    expect(test.setDebugLogging).not.toHaveBeenCalled();

    feature.resolve({ ...defaults, feature_enabled: false, debug_logging: false });
    await feature.promise;
    await vi.waitFor(() => {
      expect(test.setDebugLogging).toHaveBeenCalledWith(true);
    });

    debug.resolve({ ...defaults, feature_enabled: false, debug_logging: true });
    await Promise.all([first, second]);
    expect(test.coordinator.snapshot.settings).toEqual({
      ...defaults,
      feature_enabled: false,
      debug_logging: true,
    });
  });

  it("rolls back a failed write before processing the next queued setting", async () => {
    const feature = deferred<typeof defaults>();
    const test = harness();
    test.setFeatureEnabled.mockReturnValue(feature.promise);
    test.coordinator.start();
    await Promise.resolve();
    await Promise.resolve();

    const first = test.coordinator.setFeatureEnabled(false);
    const second = test.coordinator.setDebugLogging(true);
    feature.reject(new Error("feature save failed"));
    await Promise.all([first, second]);

    expect(test.onError).toHaveBeenCalledWith("feature", expect.any(Error));
    expect(test.coordinator.snapshot.settings).toEqual({
      ...defaults,
      feature_enabled: true,
      debug_logging: true,
    });
  });

  it("ignores late load/save effects after terminal disposal", async () => {
    const load = deferred<typeof defaults>();
    const feature = deferred<typeof defaults>();
    const test = harness();
    test.loadSettings.mockReturnValue(load.promise);
    test.setFeatureEnabled.mockReturnValue(feature.promise);
    test.coordinator.start();

    load.resolve(defaults);
    await load.promise;
    await Promise.resolve();
    const save = test.coordinator.setFeatureEnabled(false);
    await Promise.resolve();
    const callsBeforeDispose = test.achievementController.setEnabled.mock.calls.length;
    test.coordinator.dispose();
    feature.resolve({ ...defaults, feature_enabled: true, debug_logging: false });
    await save;

    expect(test.achievementController.dispose).toHaveBeenCalledOnce();
    expect(test.homeCarouselController.dispose).toHaveBeenCalledOnce();
    expect(test.achievementController.enabled).toBe(false);
    expect(test.achievementController.setEnabled).toHaveBeenCalledTimes(callsBeforeDispose);
  });

  it.each([
    ["the first", true, false],
    ["the second", false, true],
    ["both", true, true],
  ] as const)(
    "disposes both controllers when %s disposer throws",
    (_caseName, achievementThrows, homeCarouselThrows) => {
      const test = harness();
      if (achievementThrows) {
        test.achievementController.dispose.mockImplementation(() => {
          throw new Error("achievement dispose failed");
        });
      }
      if (homeCarouselThrows) {
        test.homeCarouselController.dispose.mockImplementation(() => {
          throw new Error("carousel dispose failed");
        });
      }

      expect(() => test.coordinator.dispose()).not.toThrow();
      expect(test.achievementController.dispose).toHaveBeenCalledOnce();
      expect(test.homeCarouselController.dispose).toHaveBeenCalledOnce();
      expect(test.keyboardChordController.dispose).toHaveBeenCalledOnce();
      if (achievementThrows) {
        expect(test.onError).toHaveBeenCalledWith(
          "feature",
          expect.any(Error),
        );
      }
      if (homeCarouselThrows) {
        expect(test.onError).toHaveBeenCalledWith(
          "homeCarouselFix",
          expect.any(Error),
        );
      }
      if (!achievementThrows) {
        expect(test.onError).not.toHaveBeenCalledWith(
          "feature",
          expect.any(Error),
        );
      }
    },
  );

  it("serializes updater writes with independent busy flags", async () => {
    const channel = deferred<typeof defaults>();
    const automatic = deferred<typeof defaults>();
    const test = harness();
    test.setUpdateChannel.mockReturnValue(channel.promise);
    test.setAutomaticUpdateChecks.mockReturnValue(automatic.promise);
    test.coordinator.start();
    await Promise.resolve();
    await Promise.resolve();

    const first = test.coordinator.setUpdateChannel("development");
    const second = test.coordinator.setAutomaticUpdateChecks(false);
    expect(test.coordinator.snapshot.updateChannelBusy).toBe(true);
    expect(test.coordinator.snapshot.automaticChecksBusy).toBe(true);
    await Promise.resolve();
    expect(test.setUpdateChannel).toHaveBeenCalledWith("development");
    expect(test.setAutomaticUpdateChecks).not.toHaveBeenCalled();

    channel.resolve({ ...defaults, update_channel: "development" });
    await vi.waitFor(() => expect(test.setAutomaticUpdateChecks).toHaveBeenCalledWith(false));
    automatic.resolve({
      ...defaults,
      update_channel: "development",
      automatic_update_checks: false,
    });
    await Promise.all([first, second]);
    expect(test.coordinator.snapshot.settings.update_channel).toBe("development");
    expect(test.coordinator.snapshot.settings.automatic_update_checks).toBe(false);
    expect(test.coordinator.snapshot.updateChannelBusy).toBe(false);
    expect(test.coordinator.snapshot.automaticChecksBusy).toBe(false);
  });

  it("rolls back a failed updater write and ignores late completion after dispose", async () => {
    const channel = deferred<typeof defaults>();
    const test = harness();
    test.setUpdateChannel.mockReturnValue(channel.promise);
    test.coordinator.start();
    await Promise.resolve();
    await Promise.resolve();

    const save = test.coordinator.setUpdateChannel("development");
    channel.reject(new Error("channel save failed"));
    await save;
    expect(test.coordinator.snapshot.settings.update_channel).toBe("stable");
    expect(test.onError).toHaveBeenCalledWith("updateChannel", expect.any(Error));

    const automatic = deferred<typeof defaults>();
    test.setAutomaticUpdateChecks.mockReturnValue(automatic.promise);
    const lateSave = test.coordinator.setAutomaticUpdateChecks(false);
    await Promise.resolve();
    const before = test.coordinator.snapshot;
    test.coordinator.dispose();
    automatic.resolve({ ...defaults, automatic_update_checks: false });
    await lateSave;
    expect(test.coordinator.snapshot).toEqual(before);
  });

  it("optimistically controls the Home-carousel fix, then rolls back persistence or installation failures", async () => {
    const save = deferred<typeof defaults>();
    const test = harness();
    test.setHomeCarouselFixEnabled.mockReturnValue(save.promise);
    test.coordinator.start();
    await Promise.resolve();
    await Promise.resolve();

    const requested = test.coordinator.setHomeCarouselFixEnabled(true);
    expect(test.coordinator.snapshot.homeCarouselFixBusy).toBe(true);
    await Promise.resolve();
    expect(test.homeCarouselController.setEnabled).toHaveBeenLastCalledWith(true);
    expect(test.coordinator.snapshot.settings.home_carousel_fix_enabled).toBe(true);

    save.reject(new Error("carousel save failed"));
    await requested;
    expect(test.homeCarouselController.setEnabled).toHaveBeenLastCalledWith(false);
    expect(test.coordinator.snapshot.settings.home_carousel_fix_enabled).toBe(false);
    expect(test.coordinator.snapshot.homeCarouselFixBusy).toBe(false);
    expect(test.onError).toHaveBeenCalledWith("homeCarouselFix", expect.any(Error));

    test.setHomeCarouselFixEnabled.mockClear();
    test.homeCarouselController.setEnabled.mockImplementationOnce(() => false);
    await test.coordinator.setHomeCarouselFixEnabled(true);
    expect(test.setHomeCarouselFixEnabled).not.toHaveBeenCalledWith(true);
    expect(test.coordinator.snapshot.settings.home_carousel_fix_enabled).toBe(false);
  });
  it("optimistically controls the keyboard chord fix, then rolls back persistence or installation failures", async () => {
    const save = deferred<typeof defaults>();
    const test = harness();
    test.setKeyboardChordFixEnabled.mockReturnValue(save.promise);
    test.coordinator.start();
    await Promise.resolve();
    await Promise.resolve();

    const requested = test.coordinator.setKeyboardChordFixEnabled(true);
    expect(test.coordinator.snapshot.keyboardChordFixBusy).toBe(true);
    await Promise.resolve();
    expect(test.keyboardChordController.setEnabled).toHaveBeenLastCalledWith(true);
    expect(test.coordinator.snapshot.settings.keyboard_chord_fix_enabled).toBe(true);

    save.reject(new Error("keyboard chord save failed"));
    await requested;
    expect(test.keyboardChordController.setEnabled).toHaveBeenLastCalledWith(false);
    expect(test.coordinator.snapshot.settings.keyboard_chord_fix_enabled).toBe(false);
    expect(test.coordinator.snapshot.keyboardChordFixBusy).toBe(false);
    expect(test.onError).toHaveBeenCalledWith("keyboardChordFix", expect.any(Error));

    // An install failure must not be persisted as an enabled setting.
    test.setKeyboardChordFixEnabled.mockClear();
    test.keyboardChordController.setEnabled.mockImplementationOnce(() => false);
    await test.coordinator.setKeyboardChordFixEnabled(true);
    expect(test.setKeyboardChordFixEnabled).not.toHaveBeenCalledWith(true);
    expect(test.coordinator.snapshot.settings.keyboard_chord_fix_enabled).toBe(false);
  });
});
