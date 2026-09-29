import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SpecialistDirectiveCard } from "@/components/agent/specialist-directive-card";

describe("SpecialistDirectiveCard while busy", () => {
  it("keeps Cancel disabled while busy by default", () => {
    render(
      <SpecialistDirectiveCard summary="s" confirmLabel="Connect" busy onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("lets the person abandon an open Google sign-in", () => {
    const onCancel = vi.fn();
    render(
      <SpecialistDirectiveCard
        summary="Connect Google Calendar"
        confirmLabel="Connect Calendar"
        busy
        busyLabel="Waiting for Google…"
        cancelWhileBusy
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole("button", { name: "Waiting for Google…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
