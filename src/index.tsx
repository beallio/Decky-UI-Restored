import { definePlugin, toaster } from "@decky/api";
import { staticClasses } from "@decky/ui";
import { useEffect, useRef, useState } from "react";
import { MdAutoFixHigh } from "react-icons/md";
import {
  getSettings,
  getUpdateCheckContextCall,
  getVersions,
  setAutomaticUpdateChecksCall,
  setDebugLogging,
  setFeatureEnabled,
  setHomeCarouselFixEnabled,
  setKeyboardChordFixEnabled,
  setKeyboardScrollRestoreEnabled,
  setUpdateChannelCall,
  checkForPluginUpdateCall,
  markUpdateNotifiedCall,
  type PluginSettings,
  type Versions,
} from "./backend";
import { installAchievementBarPatch } from "./achievementBar";
import { installHomeCarouselTitleFix } from "./homeCarouselTitleFix";
import { installKeyboardChordFix } from "./keyboardChordFix";
import { installKeyboardScrollRestore } from "./keyboardScrollRestore";
import { PluginPanelContent } from "./components/PluginPanelContent";
import {
  resetDescriptionScroll,
} from "./components/RestoreMiniAchievementsSection";
import { FeatureController } from "./featureController";
import { SettingsCoordinator } from "./settingsCoordinator";
import { createUpdatePoller } from "./runtime/updatePoller";
import * as log from "./log";

const PLUGIN_NAME = "Decky UI Restored";
const QAM_TITLE = "Decky UI Restored";
const DEFAULT_SETTINGS: PluginSettings = {
  feature_enabled: true,
  home_carousel_fix_enabled: false,
  keyboard_chord_fix_enabled: false,
  keyboard_scroll_restore_enabled: false,
  debug_logging: false,
  update_channel: "stable",
  automatic_update_checks: true,
};
const EMPTY_VERSIONS: Versions = { plugin: "", decky: "", steamos: "" };

function Content({ coordinator }: { coordinator: SettingsCoordinator }) {
  const [runtime, setRuntime] = useState(coordinator.snapshot);
  const [versions, setVersions] = useState(EMPTY_VERSIONS);
  const descriptionRef = useRef<HTMLDivElement | null>(null);
  const {
    settings,
    loaded: settingsLoaded,
    featureBusy,
    homeCarouselFixBusy,
    keyboardChordFixBusy,
    keyboardScrollRestoreBusy,
    debugBusy,
    updateChannelBusy,
    automaticChecksBusy,
  } = runtime;

  useEffect(() => {
    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        try {
          const description = descriptionRef.current;
          if (!description) return;

          // Decky's outer QAM scroller survives content remounts. Reset only
          // that scroll position; native HTMLElement.focus() bypasses Steam's
          // gamepad navigation state and can make this preferred row unreachable.
          resetDescriptionScroll(description);
        } catch (error) {
          log.debug("focus", "could not reset QAM panel focus", error);
        }
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, []);

  useEffect(() => {
    const unsubscribe = coordinator.subscribe(setRuntime);
    return unsubscribe;
  }, [coordinator]);

  useEffect(() => {
    let cancelled = false;
    void getVersions()
      .then((loaded) => {
        if (!cancelled) setVersions(loaded);
      })
      .catch((error) => log.warn("versions", "version load failed", error));
    return () => {
      cancelled = true;
    };
  }, []);

  const saveFeature = async (enabled: boolean) => {
    await coordinator.setFeatureEnabled(enabled);
  };

  const saveDebug = async (enabled: boolean) => {
    await coordinator.setDebugLogging(enabled);
  };

  const saveHomeCarouselFix = async (enabled: boolean) => {
    await coordinator.setHomeCarouselFixEnabled(enabled);
  };

  const saveKeyboardChordFix = async (enabled: boolean) => {
    await coordinator.setKeyboardChordFixEnabled(enabled);
  };

  const saveKeyboardScrollRestore = async (enabled: boolean) => {
    await coordinator.setKeyboardScrollRestoreEnabled(enabled);
  };

  const confirmInstalledPluginVersion = (version: string) => {
    setVersions((current) => ({ ...current, plugin: version }));
  };

  return (
    <PluginPanelContent
      descriptionRef={descriptionRef}
      settings={settings}
      settingsLoaded={settingsLoaded}
      featureBusy={featureBusy}
      homeCarouselFixBusy={homeCarouselFixBusy}
      keyboardChordFixBusy={keyboardChordFixBusy}
      keyboardScrollRestoreBusy={keyboardScrollRestoreBusy}
      debugBusy={debugBusy}
      updateChannelBusy={updateChannelBusy}
      automaticChecksBusy={automaticChecksBusy}
      versions={versions}
      onFeatureChange={(enabled) => void saveFeature(enabled)}
      onHomeCarouselFixChange={(enabled) => void saveHomeCarouselFix(enabled)}
      onKeyboardChordFixChange={(enabled) => void saveKeyboardChordFix(enabled)}
      onKeyboardScrollRestoreChange={(enabled) => void saveKeyboardScrollRestore(enabled)}
      onDebugChange={(enabled) => void saveDebug(enabled)}
      onUpdateChannelChange={(channel) => void coordinator.setUpdateChannel(channel)}
      onAutomaticChecksChange={(enabled) =>
        void coordinator.setAutomaticUpdateChecks(enabled)
      }
      onInstallVersionConfirmed={confirmInstalledPluginVersion}
    />
  );
}

export default definePlugin(() => {
  log.info("plugin", "loaded");
  const achievementController = new FeatureController(
    installAchievementBarPatch,
    (error) => log.error("plugin", "achievement patch lifecycle failed", error),
  );
  const homeCarouselController = new FeatureController(
    installHomeCarouselTitleFix,
    (error) => log.error("plugin", "Home-carousel fix lifecycle failed", error),
  );
  const keyboardChordController = new FeatureController(
    installKeyboardChordFix,
    (error) => log.error("plugin", "keyboard chord fix lifecycle failed", error),
  );
  const keyboardScrollController = new FeatureController(
    installKeyboardScrollRestore,
    (error) => log.error("plugin", "keyboard scroll restore lifecycle failed", error),
  );
  const coordinator = new SettingsCoordinator({
    achievementController,
    homeCarouselController,
    keyboardChordController,
    keyboardScrollController,
    defaults: DEFAULT_SETTINGS,
    loadSettings: getSettings,
    setFeatureEnabled,
    setHomeCarouselFixEnabled,
    setKeyboardChordFixEnabled,
    setKeyboardScrollRestoreEnabled,
    setDebugLogging,
    setUpdateChannel: setUpdateChannelCall,
    setAutomaticUpdateChecks: setAutomaticUpdateChecksCall,
    setVerboseLogging: log.setVerboseLogging,
    onError(operation, error) {
      log.warn("settings", `${operation} setting operation failed`, error);
    },
  });
  coordinator.start();
  const updatePoller = createUpdatePoller({
    getUpdateCheckContext: getUpdateCheckContextCall,
    checkForUpdate: checkForPluginUpdateCall,
    markUpdateNotified: markUpdateNotifiedCall,
    notify(title, body) {
      toaster.toast({ title, body, duration: 5000 });
    },
    log(level, message) {
      if (level === "warning") log.warn("updater-poller", message);
      else if (level === "error") log.error("updater-poller", message);
      else if (level === "debug") log.debug("updater-poller", message);
      else log.info("updater-poller", message);
    },
  });
  updatePoller.start();

  return {
    name: PLUGIN_NAME,
    titleView: <div className={staticClasses.Title}>{QAM_TITLE}</div>,
    content: <Content coordinator={coordinator} />,
    icon: <MdAutoFixHigh />,
    onDismount() {
      updatePoller.dispose();
      coordinator.dispose();
    },
  };
});
