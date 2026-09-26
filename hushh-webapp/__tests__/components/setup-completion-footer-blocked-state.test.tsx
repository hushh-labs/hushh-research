import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";
import { Button } from "@/lib/morphy-ux/button";

describe("SetupCompletionFooter shared primary action", () => {
  it.each([{}, {disabled:true}, {blocked:true}, {busy:true}])("matches the shared CTA and honors readiness %j", (state) => {
    const onComplete = vi.fn();
    const inactive = Boolean((state as {disabled?:boolean}).disabled || (state as {blocked?:boolean}).blocked);
    render(<>
      <SetupCompletionFooter label="Finish setup" onComplete={onComplete} controlId="finish" purpose="Finish setup" testId="finish" {...state} />
      <Button data-testid="reference" variant="blue" effect="fill" size="prominent" fullWidth disabled={inactive} loading={(state as {busy?:boolean}).busy}>Reference</Button>
    </>);
    const button = screen.getByTestId("finish");
    expect(button.className).toBe(screen.getByTestId("reference").className);
    fireEvent.click(button);
    if (inactive || (state as {busy?:boolean}).busy) {
      expect(button).toBeDisabled();
      expect(onComplete).not.toHaveBeenCalled();
    } else expect(onComplete).toHaveBeenCalledOnce();
  });
});
