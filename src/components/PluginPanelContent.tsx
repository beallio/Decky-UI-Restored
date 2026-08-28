import type { Ref } from "react";
import type { PluginSettings, UpdateChannel, Versions } from "../backend";
import { FocusablePanel } from "./FocusablePanel";
import { HomeCarouselTitleFixSection } from "./HomeCarouselTitleFixSection";
import { PluginUpdateSection } from "./PluginUpdateSection";
import { RestoreMiniAchievementsSection } from "./RestoreMiniAchievementsSection";
import { SettingsSection } from "./SettingsSection";
import { VersionsSection } from "./VersionsSection";

type Props = {
  descriptionRef: Ref<HTMLDivElement>;
  settings: PluginSettings;
  settingsLoaded: boolean;
  featureBusy: boolean;
  homeCarouselFixBusy: boolean;
  debugBusy: boolean;
  updateChannelBusy: boolean;
  automaticChecksBusy: boolean;
  versions: Versions;
  onFeatureChange: (enabled: boolean) => void;
  onHomeCarouselFixChange: (enabled: boolean) => void;
  onDebugChange: (enabled: boolean) => void;
  onUpdateChannelChange: (channel: UpdateChannel) => void;
  onAutomaticChecksChange: (enabled: boolean) => void;
  onInstallVersionConfirmed: (version: string) => void;
};

export function PluginPanelContent(props: Props) {
  return (
    <FocusablePanel>
      <RestoreMiniAchievementsSection
        focusRef={props.descriptionRef}
        featureEnabled={props.settings.feature_enabled}
        settingsLoaded={props.settingsLoaded}
        featureBusy={props.featureBusy}
        onFeatureChange={props.onFeatureChange}
      />
      <HomeCarouselTitleFixSection
        enabled={props.settings.home_carousel_fix_enabled}
        settingsLoaded={props.settingsLoaded}
        busy={props.homeCarouselFixBusy}
        onChange={props.onHomeCarouselFixChange}
      />
      <SettingsSection
        debugLogging={props.settings.debug_logging}
        settingsLoaded={props.settingsLoaded}
        debugBusy={props.debugBusy}
        onDebugChange={props.onDebugChange}
      />
      <PluginUpdateSection
        currentVersion={props.versions.plugin || "Loading..."}
        updateChannel={props.settings.update_channel}
        automaticUpdateChecks={props.settings.automatic_update_checks}
        settingsLoaded={props.settingsLoaded}
        updateChannelBusy={props.updateChannelBusy}
        automaticChecksBusy={props.automaticChecksBusy}
        onToggleUpdateChannel={(enabled) =>
          props.onUpdateChannelChange(enabled ? "development" : "stable")
        }
        onToggleAutomaticUpdateChecks={props.onAutomaticChecksChange}
        onInstallVersionConfirmed={props.onInstallVersionConfirmed}
      />
      <VersionsSection versions={props.versions} />
    </FocusablePanel>
  );
}
