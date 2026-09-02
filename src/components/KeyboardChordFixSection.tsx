import { Field, PanelSection, PanelSectionRow, ToggleField } from "@decky/ui";

type Props = {
  enabled: boolean;
  settingsLoaded: boolean;
  busy: boolean;
  onChange: (enabled: boolean) => void;
};

export function KeyboardChordFixSection(props: Props) {
  return (
    <PanelSection title="On-Screen Keyboard Shortcut">
      <PanelSectionRow>
        <Field
          focusable={true}
          highlightOnFocus={false}
          onActivate={() => undefined}
          childrenLayout="below"
          childrenContainerWidth="max"
          bottomSeparator="none"
          padding="standard"
        >
          <div style={{ fontSize: "0.8rem", opacity: 0.8 }}>
            Restores STEAM + X when no game is running in Big Picture and Desktop modes.
          </div>
        </Field>
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="Fix STEAM + X keyboard shortcut"
          checked={props.enabled}
          disabled={!props.settingsLoaded || props.busy}
          highlightOnFocus={true}
          onChange={props.onChange}
        />
      </PanelSectionRow>
    </PanelSection>
  );
}
