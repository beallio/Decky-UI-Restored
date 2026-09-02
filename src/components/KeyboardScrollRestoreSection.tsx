import { Field, PanelSection, PanelSectionRow, ToggleField } from "@decky/ui";

type Props = {
  enabled: boolean;
  settingsLoaded: boolean;
  busy: boolean;
  onChange: (enabled: boolean) => void;
};

export function KeyboardScrollRestoreSection(props: Props) {
  return (
    <PanelSection title="Keyboard Scroll Restore">
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
            Steam makes room for the on-screen keyboard by making the page shorter,
            and the page scrolls down by the same amount. When the keyboard closes,
            the page returns to full height but stays scrolled, so the view keeps
            moving up. This puts the scroll position back.
          </div>
        </Field>
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="Restore scroll position after the keyboard closes"
          checked={props.enabled}
          disabled={!props.settingsLoaded || props.busy}
          highlightOnFocus={true}
          onChange={props.onChange}
        />
      </PanelSectionRow>
    </PanelSection>
  );
}
