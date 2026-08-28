import { Field, PanelSection, PanelSectionRow, ToggleField } from "@decky/ui";

type Props = {
  enabled: boolean;
  settingsLoaded: boolean;
  busy: boolean;
  onChange: (enabled: boolean) => void;
};

export function HomeCarouselTitleFixSection(props: Props) {
  return (
    <PanelSection title="Home Carousel Title Fix">
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
            Removes the stale title, glow, and raised tile after controller focus moves
            to another Home carousel card. Preserves CSSLoader theme styling.
          </div>
        </Field>
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="Fix stale Home carousel state"
          checked={props.enabled}
          disabled={!props.settingsLoaded || props.busy}
          highlightOnFocus={true}
          onChange={props.onChange}
        />
      </PanelSectionRow>
    </PanelSection>
  );
}
