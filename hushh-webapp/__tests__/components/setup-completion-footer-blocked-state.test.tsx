import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";

/**
 * The terminal setup action promises passage. Blue is that promise.
 *
 * The stock disabled treatment only fades the accent fill to 50%, which on the
 * light setup surface still reads as the primary blue button -- so a person
 * whose mandatory step was still pending saw a blue "Finish setup", tapped it,
 * and got nothing but a line of supporting text. These tests pin the rule:
 * accent while the tap can finish, neutral while it cannot.
 */
const ACCENT_FILL = "bg-[var(--app-accent)]";

function renderFooter(overrides: Partial<Parameters<typeof SetupCompletionFooter>[0]> = {}) {
  const onComplete = vi.fn();
  render(
    <SetupCompletionFooter
      label="Finish setup"
      onComplete={onComplete}
      controlId="one-setup-master-ack"
      testId="one-setup-master-ack"
      purpose="Finish setup and protect what you save."
      variant="blue-gradient"
      effect="fill"
      {...overrides}
    />,
  );
  return { onComplete, button: screen.getByTestId("one-setup-master-ack") };
}

describe("SetupCompletionFooter blocked state", () => {
  it("keeps the accent fill while the action can actually finish setup", () => {
    const { button } = renderFooter();

    expect(button.className).toContain(ACCENT_FILL);
    expect(button).not.toBeDisabled();
  });

  it("drops the accent fill for a neutral container while a step is still pending", () => {
    const { button } = renderFooter({ disabled: true });

    expect(button).toBeDisabled();
    // The neutral container must win outright, not sit behind a half-faded
    // accent: full opacity on a muted background is what makes "not yet"
    // legible instead of "blue but dim".
    expect(button.className).toContain("disabled:!bg-muted/60");
    expect(button.className).toContain("disabled:!text-muted-foreground");
    expect(button.className).toContain("disabled:!opacity-100");
  });

  it("keeps a visible edge, because the muted fill alone draws nothing in light theme", () => {
    const { button } = renderFooter({ disabled: true });

    // Measured on the built stylesheet: `muted` over the light page surface is
    // rgb(242,242,245) on rgb(242,242,247) -- 1:1. Without a border the pill
    // disappears and leaves a grey label floating on the page, which is a
    // worse control than the blue one this state replaced. The border is the
    // only thing keeping it a button, so it is the thing under test.
    expect(button.className).toContain("disabled:!border-border");
    expect(button.className).not.toContain("!border-0");
  });

  it("does not spend geometry to look disabled", () => {
    const enabled = renderFooter().button.className;
    cleanup();
    const blocked = renderFooter({ disabled: true }).button.className;

    // Both states reserve the same 1px. Only the border COLOUR changes, so the
    // button cannot resize between states -- a zero-drift requirement, and the
    // reason `!border-0` (which removes the reserved px) does not belong here.
    for (const state of [enabled, blocked]) {
      expect(state).toContain("border border-transparent");
      expect(state).not.toContain("!border-0");
    }
  });

  it("does not absorb a tap while blocked", () => {
    const { onComplete, button } = renderFooter({ disabled: true });

    fireEvent.click(button);

    expect(onComplete).not.toHaveBeenCalled();
  });

  it("states what is still needed next to the blocked action", () => {
    renderFooter({
      disabled: true,
      supportingText: "Choose your AI first.",
    });

    // Colour is never the only signal: the reason is readable text, so it
    // survives a screen reader and a person who cannot separate the two greys.
    expect(screen.getByText("Choose your AI first.")).toBeTruthy();
  });

  it("keeps the accent while a real completion is in flight", () => {
    // busy is a disabled button too, but it is mid-success -- fading it to a
    // neutral "blocked" container would read as a failure the person caused.
    const { button } = renderFooter({ busy: true });

    expect(button).toBeDisabled();
    expect(button.className).toContain(ACCENT_FILL);
    expect(button.className).not.toContain("disabled:!bg-muted/60");
  });

  it("keeps the accent when a caller re-blocks an action that is already running", () => {
    // A caller may flip its gate closed for the duration of the run (or race
    // the two). In-flight still wins: the person is watching their own tap
    // resolve, not being told it was never allowed.
    const { button } = renderFooter({ busy: true, disabled: true });

    expect(button).toBeDisabled();
    expect(button.className).toContain(ACCENT_FILL);
    expect(button.className).not.toContain("disabled:!bg-muted/60");
  });

  it("still takes the tap while blocked, so the caller can say what is missing", () => {
    // The whole point of `blocked` over `disabled`: an inert button cannot
    // explain itself, and the explanation is what the tap was asking for.
    const { button, onComplete } = renderFooter({ blocked: true });

    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(button);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("wears the same neutral container while blocked as it does while disabled", () => {
    // `disabled:` variants never match an enabled button, so the blocked look
    // has to be spelled out unprefixed or a tappable block renders full blue
    // and promises passage it cannot give.
    const { button } = renderFooter({ blocked: true });

    expect(button.className).toContain("!bg-muted/60");
    expect(button.className).toContain("!border-border");
    expect(button.className).toContain("!text-muted-foreground");
    expect(button.className).toContain("hover:!bg-muted/60");
    // The accent utility stays in the list and loses to the `!` override, the
    // same way the disabled path overrides it. What matters is that nothing
    // paints blue, not that the base class was removed.
    expect(button.className).toContain("!bg-muted/60");
  });

  it("lets a real disable win over a soft block", () => {
    // Both set: the caller means inert. Never leave a button that takes taps
    // while its owner believes it is switched off.
    const { button, onComplete } = renderFooter({ blocked: true, disabled: true });

    expect(button).toBeDisabled();
    expect(button.className).toContain("disabled:!bg-muted/60");

    fireEvent.click(button);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("keeps the in-flight run visible rather than re-blocking it mid-tap", () => {
    const { button } = renderFooter({ blocked: true, busy: true });

    expect(button.className).toContain(ACCENT_FILL);
    expect(button.className).not.toContain("!bg-muted/60");
  });

  it("leaves the quiet skip action on its own established treatment", () => {
    const { button } = renderFooter({
      disabled: true,
      variant: "none",
      effect: "fade",
    });

    expect(button.className).toContain("disabled:!bg-muted/35");
    expect(button.className).not.toContain("disabled:!bg-muted/60");
  });
});
