import { Field, PanelSection, PanelSectionRow, ToggleField } from "@decky/ui";
import type { FocusEvent, Ref } from "react";
import * as log from "../log";

function findDescriptionScroller(description: HTMLDivElement) {
  let ancestor = description.parentElement;
  while (ancestor) {
    const overflowY = getComputedStyle(ancestor).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      ancestor.scrollHeight > ancestor.clientHeight
    ) {
      return ancestor;
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

export function resetDescriptionScroll(description: HTMLDivElement) {
  const scroller = findDescriptionScroller(description);
  if (scroller) {
    // Calling scrollTo cancels Steam's in-flight smooth nearest-scroll;
    // assigning scrollTop does not reliably cancel that animation.
    scroller.scrollTo(0, 0);
    return;
  }
  description.scrollIntoView({ block: "start", inline: "nearest" });
}

function resetAfterSteamScroll(description: HTMLDivElement) {
  const scroller = findDescriptionScroller(description);
  if (!scroller) {
    resetDescriptionScroll(description);
    return;
  }

  const reveal = () => scroller.scrollTo(0, 0);
  const finalReveal = () => {
    scroller.removeEventListener("scrollend", reveal);
    reveal();
  };

  scroller.addEventListener("scrollend", reveal, { once: true });
  // Keep this independent from scrollend: Steam can emit an early scrollend,
  // then apply its final sticky-header offset hundreds of milliseconds later.
  setTimeout(finalReveal, 500);
}

const revealOnFocus = {
  // Decky's Field forwards DOM focus props even though its public type omits them.
  onFocus: (event: FocusEvent<HTMLDivElement>) => {
    const description = event.currentTarget;
    try {
      // Steam scrolls the row again after focus. Correct its final position so
      // the sticky QAM header cannot cover the first description line.
      resetAfterSteamScroll(description);
    } catch (error) {
      log.debug("focus", "could not reveal QAM description", error);
    }
  },
};

type Props = {
  focusRef?: Ref<HTMLDivElement>;
  featureEnabled: boolean;
  settingsLoaded: boolean;
  featureBusy: boolean;
  onFeatureChange: (enabled: boolean) => void;
};

export function RestoreMiniAchievementsSection({
  focusRef,
  featureEnabled,
  settingsLoaded,
  featureBusy,
  onFeatureChange,
}: Props) {
  return (
    <PanelSection title="Restore Mini Achievements">
      <PanelSectionRow>
        <Field
          ref={focusRef}
          {...revealOnFocus}
          focusable={true}
          highlightOnFocus={false}
          preferredFocus={true}
          onActivate={() => undefined}
          childrenLayout="below"
          childrenContainerWidth="max"
          bottomSeparator="none"
          padding="standard"
        >
          <div style={{ fontSize: "0.8rem", opacity: 0.8 }}>
            Restores the achievement progress bar on the game details page (next
            to Play Time). Open a game that has achievements to see it.
          </div>
        </Field>
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="Enable mini achievements"
          description="Shows achievement progress on game details pages."
          checked={featureEnabled}
          disabled={!settingsLoaded || featureBusy}
          highlightOnFocus={true}
          onChange={onFeatureChange}
        />
      </PanelSectionRow>
    </PanelSection>
  );
}
