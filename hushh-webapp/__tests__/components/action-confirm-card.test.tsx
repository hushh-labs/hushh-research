import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ActionConfirmCard } from "@/components/one-location/redesign/action-confirm-card";
import type { ClientAction } from "@/lib/one-location/types";

const baseAction: ClientAction = {
  id: "act-1",
  type: "publish_share",
  shares: [{ grantId: "g1", recipientUserId: "r1", recipientKeyId: "k1", label: "Mom" }],
  summary: "Share your live location with Mom",
};

describe("ActionConfirmCard", () => {
  it("renders the action summary text", () => {
    render(
      <ActionConfirmCard
        action={baseAction}
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Share your live location with Mom")).toBeTruthy();
  });

  it("fires onConfirm when the accept button is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <ActionConfirmCard
        action={baseAction}
        busy={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("action-confirm-accept"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("fires onCancel when the cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(
      <ActionConfirmCard
        action={baseAction}
        busy={false}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("action-confirm-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does NOT auto-confirm — onConfirm is not called without a click", () => {
    const onConfirm = vi.fn();
    render(
      <ActionConfirmCard
        action={baseAction}
        busy={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    // No click — just rendering must never call onConfirm
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows a 'Share' label for publish_share actions", () => {
    render(
      <ActionConfirmCard
        action={baseAction}
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId("action-confirm-accept").textContent).toMatch(/share/i);
  });

  it("shows a 'View' label for view_envelope actions", () => {
    const viewAction: ClientAction = {
      id: "a2",
      type: "view_envelope",
      grantId: "g2",
      summary: "View Mom's location",
    };
    render(
      <ActionConfirmCard
        action={viewAction}
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId("action-confirm-accept").textContent).toMatch(/view/i);
  });

  it("shows a 'Create' label for create_public_link actions", () => {
    const linkAction: ClientAction = {
      id: "a3",
      type: "create_public_link",
      durationHours: 2,
      summary: "Create a public link (viewable for 2h)",
    };
    render(
      <ActionConfirmCard
        action={linkAction}
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId("action-confirm-accept").textContent).toMatch(/create/i);
  });

  it("disables the cancel button when busy", () => {
    render(
      <ActionConfirmCard
        action={baseAction}
        busy={true}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const cancelBtn = screen.getByTestId("action-confirm-cancel") as HTMLButtonElement;
    expect(cancelBtn.disabled).toBe(true);
    // Accept button is also disabled when isLoading
    const acceptBtn = screen.getByTestId("action-confirm-accept") as HTMLButtonElement;
    expect(acceptBtn.disabled).toBe(true);
  });

  it("has the action-confirm-card testid", () => {
    render(
      <ActionConfirmCard
        action={baseAction}
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId("action-confirm-card")).toBeTruthy();
  });
});
