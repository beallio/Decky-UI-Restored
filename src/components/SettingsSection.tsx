import { PanelSection, PanelSectionRow, ToggleField } from "@decky/ui";

type Props = {
  debugLogging: boolean;
  settingsLoaded: boolean;
  debugBusy: boolean;
  onDebugChange: (enabled: boolean) => void;
};

export function SettingsSection(props: Props) {
  return (
    <PanelSection title="Settings">
      <PanelSectionRow>
        <ToggleField
          label="Debug logging"
          description="Enables verbose logging for troubleshooting."
          checked={props.debugLogging}
          disabled={!props.settingsLoaded || props.debugBusy}
          highlightOnFocus={true}
          onChange={props.onDebugChange}
        />
      </PanelSectionRow>
    </PanelSection>
  );
}
