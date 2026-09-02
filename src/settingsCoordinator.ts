import type { PluginSettings, UpdateChannel } from "./backend";

type SettingOperation =
  | "feature"
  | "homeCarouselFix"
  | "keyboardChordFix"
  | "keyboardScrollRestore"
  | "debug"
  | "updateChannel"
  | "automaticChecks";

type ToggleableFeature = {
  readonly enabled: boolean;
  setEnabled(enabled: boolean): boolean;
  dispose(): void;
};

export type SettingsSnapshot = {
  settings: PluginSettings;
  loaded: boolean;
  featureBusy: boolean;
  homeCarouselFixBusy: boolean;
  keyboardChordFixBusy: boolean;
  keyboardScrollRestoreBusy: boolean;
  debugBusy: boolean;
  updateChannelBusy: boolean;
  automaticChecksBusy: boolean;
};

type SettingsCoordinatorOptions = {
  achievementController: ToggleableFeature;
  homeCarouselController: ToggleableFeature;
  keyboardChordController: ToggleableFeature;
  keyboardScrollController: ToggleableFeature;
  defaults: PluginSettings;
  loadSettings: () => Promise<PluginSettings>;
  setFeatureEnabled: (enabled: boolean) => Promise<PluginSettings>;
  setHomeCarouselFixEnabled: (enabled: boolean) => Promise<PluginSettings>;
  setKeyboardChordFixEnabled: (enabled: boolean) => Promise<PluginSettings>;
  setKeyboardScrollRestoreEnabled: (enabled: boolean) => Promise<PluginSettings>;
  setDebugLogging: (enabled: boolean) => Promise<PluginSettings>;
  setUpdateChannel: (channel: UpdateChannel) => Promise<PluginSettings>;
  setAutomaticUpdateChecks: (enabled: boolean) => Promise<PluginSettings>;
  setVerboseLogging: (enabled: boolean) => void;
  onError?: (operation: "load" | SettingOperation, error: unknown) => void;
};

type Listener = (snapshot: SettingsSnapshot) => void;

/**
 * Own the settings lifecycle shared by plugin startup and QAM content.
 *
 * One load feeds every subscriber, mutations are globally serialized, and disposal is terminal.
 * This keeps late RPC responses from touching an unloaded plugin or overwriting another toggle.
 */
export class SettingsCoordinator {
  private active = true;
  private started = false;
  private listeners = new Set<Listener>();
  private queue: Promise<void> = Promise.resolve();
  private state: SettingsSnapshot;

  constructor(private readonly options: SettingsCoordinatorOptions) {
    this.state = {
      settings: { ...options.defaults },
      loaded: false,
      featureBusy: false,
      homeCarouselFixBusy: false,
      keyboardChordFixBusy: false,
      keyboardScrollRestoreBusy: false,
      debugBusy: false,
      updateChannelBusy: false,
      automaticChecksBusy: false,
    };
  }

  get snapshot(): SettingsSnapshot {
    return {
      ...this.state,
      settings: { ...this.state.settings },
    };
  }

  subscribe(listener: Listener): () => void {
    if (!this.active) return () => undefined;
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.started || !this.active) return;
    this.started = true;
    void this.options
      .loadSettings()
      .then((settings) => {
        if (!this.active) return;
        this.applySettings(settings);
        this.update({ loaded: true });
      })
      .catch((error) => {
        if (!this.active) return;
        this.options.onError?.("load", error);
        this.applySettings(this.options.defaults);
        this.update({ loaded: true });
      });
  }

  setFeatureEnabled(enabled: boolean): Promise<void> {
    return this.enqueue("feature", enabled);
  }

  setHomeCarouselFixEnabled(enabled: boolean): Promise<void> {
    return this.enqueue("homeCarouselFix", enabled);
  }

  setKeyboardChordFixEnabled(enabled: boolean): Promise<void> {
    return this.enqueue("keyboardChordFix", enabled);
  }

  setKeyboardScrollRestoreEnabled(enabled: boolean): Promise<void> {
    return this.enqueue("keyboardScrollRestore", enabled);
  }

  setDebugLogging(enabled: boolean): Promise<void> {
    return this.enqueue("debug", enabled);
  }

  setUpdateChannel(channel: UpdateChannel): Promise<void> {
    return this.enqueue("updateChannel", channel);
  }

  setAutomaticUpdateChecks(enabled: boolean): Promise<void> {
    return this.enqueue("automaticChecks", enabled);
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    this.listeners.clear();
    try {
      this.options.achievementController.dispose();
    } catch (error) {
      this.reportError("feature", error);
    }
    try {
      this.options.homeCarouselController.dispose();
    } catch (error) {
      this.reportError("homeCarouselFix", error);
    }
    try {
      this.options.keyboardChordController.dispose();
    } catch (error) {
      this.reportError("keyboardChordFix", error);
    }
    try {
      this.options.keyboardScrollController.dispose();
    } catch (error) {
      this.reportError("keyboardScrollRestore", error);
    }
  }

  private reportError(operation: "load" | SettingOperation, error: unknown): void {
    try {
      this.options.onError?.(operation, error);
    } catch {
      // Error reporting must not keep another feature from terminal cleanup.
    }
  }

  private notify(): void {
    if (!this.active) return;
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private update(patch: Partial<SettingsSnapshot>): void {
    if (!this.active) return;
    this.state = { ...this.state, ...patch };
    this.notify();
  }

  private applySettings(settings: PluginSettings): void {
    if (!this.active) return;
    const next = { ...settings };
    if (!this.options.achievementController.setEnabled(next.feature_enabled)) {
      next.feature_enabled = this.options.achievementController.enabled;
    }
    if (
      !this.options.homeCarouselController.setEnabled(
        next.home_carousel_fix_enabled,
      )
    ) {
      next.home_carousel_fix_enabled = this.options.homeCarouselController.enabled;
    }
    if (
      !this.options.keyboardChordController.setEnabled(
        next.keyboard_chord_fix_enabled,
      )
    ) {
      next.keyboard_chord_fix_enabled = this.options.keyboardChordController.enabled;
    }
    if (
      !this.options.keyboardScrollController.setEnabled(
        next.keyboard_scroll_restore_enabled,
      )
    ) {
      next.keyboard_scroll_restore_enabled =
        this.options.keyboardScrollController.enabled;
    }
    this.options.setVerboseLogging(next.debug_logging);
    this.update({ settings: next });
  }

  private enqueue(
    operation: SettingOperation,
    value: boolean | UpdateChannel,
  ): Promise<void> {
    if (!this.active || !this.state.loaded) return Promise.resolve();
    const busyKey =
      operation === "feature"
        ? "featureBusy"
        : operation === "homeCarouselFix"
          ? "homeCarouselFixBusy"
          : operation === "keyboardChordFix"
          ? "keyboardChordFixBusy"
          : operation === "keyboardScrollRestore"
          ? "keyboardScrollRestoreBusy"
          : operation === "debug"
          ? "debugBusy"
          : operation === "updateChannel"
            ? "updateChannelBusy"
            : "automaticChecksBusy";
    if (this.state[busyKey]) return Promise.resolve();
    this.update({ [busyKey]: true });

    const task = this.queue.then(async () => {
      if (!this.active) return;
      const previous = { ...this.state.settings };

      if (operation === "feature") {
        const enabled = value as boolean;
        if (!this.options.achievementController.setEnabled(enabled)) {
          this.update({
            settings: {
              ...previous,
              feature_enabled: this.options.achievementController.enabled,
            },
          });
          return;
        }
        this.update({
          settings: { ...previous, feature_enabled: enabled },
        });
      } else if (operation === "homeCarouselFix") {
        const enabled = value as boolean;
        if (!this.options.homeCarouselController.setEnabled(enabled)) {
          this.update({
            settings: {
              ...previous,
              home_carousel_fix_enabled:
                this.options.homeCarouselController.enabled,
            },
          });
          return;
        }
        this.update({
          settings: { ...previous, home_carousel_fix_enabled: enabled },
        });
      } else if (operation === "keyboardChordFix") {
        const enabled = value as boolean;
        if (!this.options.keyboardChordController.setEnabled(enabled)) {
          this.update({
            settings: {
              ...previous,
              keyboard_chord_fix_enabled:
                this.options.keyboardChordController.enabled,
            },
          });
          return;
        }
        this.update({
          settings: { ...previous, keyboard_chord_fix_enabled: enabled },
        });
      } else if (operation === "keyboardScrollRestore") {
        const enabled = value as boolean;
        if (!this.options.keyboardScrollController.setEnabled(enabled)) {
          this.update({
            settings: {
              ...previous,
              keyboard_scroll_restore_enabled:
                this.options.keyboardScrollController.enabled,
            },
          });
          return;
        }
        this.update({
          settings: { ...previous, keyboard_scroll_restore_enabled: enabled },
        });
      } else if (operation === "debug") {
        const enabled = value as boolean;
        this.options.setVerboseLogging(enabled);
        this.update({
          settings: { ...previous, debug_logging: enabled },
        });
      } else if (operation === "updateChannel") {
        this.update({
          settings: { ...previous, update_channel: value as UpdateChannel },
        });
      } else {
        this.update({
          settings: { ...previous, automatic_update_checks: value as boolean },
        });
      }

      try {
        let saved: PluginSettings;
        if (operation === "feature") {
          saved = await this.options.setFeatureEnabled(value as boolean);
        } else if (operation === "homeCarouselFix") {
          saved = await this.options.setHomeCarouselFixEnabled(value as boolean);
        } else if (operation === "keyboardChordFix") {
          saved = await this.options.setKeyboardChordFixEnabled(value as boolean);
        } else if (operation === "keyboardScrollRestore") {
          saved = await this.options.setKeyboardScrollRestoreEnabled(value as boolean);
        } else if (operation === "debug") {
          saved = await this.options.setDebugLogging(value as boolean);
        } else if (operation === "updateChannel") {
          saved = await this.options.setUpdateChannel(value as UpdateChannel);
        } else {
          saved = await this.options.setAutomaticUpdateChecks(value as boolean);
        }
        if (this.active) this.applySettings(saved);
      } catch (error) {
        if (!this.active) return;
        this.applySettings(previous);
        this.options.onError?.(operation, error);
      }
    });

    this.queue = task.catch(() => undefined);
    return task.finally(() => {
      if (this.active) this.update({ [busyKey]: false });
    });
  }
}
