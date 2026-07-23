// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SmsContactsFlow } from "@/components/one-location/redesign/sms-contacts-flow";
import type { OneLocationRecipient } from "@/lib/one-location/types";

const recipients: OneLocationRecipient[] = [
  {
    userId: "selected",
    displayName: "Kushal",
    maskedPhone: "•••• 303",
    phoneVerified: true,
    keyId: "key-selected",
    publicKeyJwk: { kty: "EC" },
    keyAlgorithm: "ECDH-P256-AES256-GCM",
    canReceiveLocation: true,
  },
  {
    userId: "available",
    displayName: "Neelesh",
    maskedPhone: "•••• 404",
    phoneVerified: true,
    keyId: "key-available",
    publicKeyJwk: { kty: "EC" },
    keyAlgorithm: "ECDH-P256-AES256-GCM",
    canReceiveLocation: true,
  },
];

const baseProps = {
  recipients,
  selectedUserIds: ["selected"],
  busyKey: null,
  onBack: vi.fn(),
  onAdd: vi.fn(),
  onRemove: vi.fn(),
  recipientLabel: (recipient: OneLocationRecipient) => recipient.displayName,
  recipientSubtitle: (recipient: OneLocationRecipient) =>
    recipient.maskedPhone || "Connected",
  isRecipientShareReady: (recipient: OneLocationRecipient) =>
    recipient.canReceiveLocation,
};

describe("SmsContactsFlow", () => {
  it("separates selected and available circle members", () => {
    render(<SmsContactsFlow {...baseProps} />);

    expect(screen.getByText("Alerted on SMS")).toBeInTheDocument();
    expect(screen.getByText("Add from your circle")).toBeInTheDocument();
    expect(screen.getByText("Kushal")).toBeInTheDocument();
    expect(screen.getByText("Neelesh")).toBeInTheDocument();
  });

  it("adds an available recipient", () => {
    const onAdd = vi.fn();
    render(<SmsContactsFlow {...baseProps} onAdd={onAdd} />);

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onAdd).toHaveBeenCalledWith("available");
  });

  it("requires confirmation before removing membership", () => {
    const onRemove = vi.fn();
    render(<SmsContactsFlow {...baseProps} onRemove={onRemove} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByText("Remove Kushal?")).toBeInTheDocument();
    const removeButtons = screen.getAllByRole("button", {
      name: "Remove",
      hidden: true,
    });
    fireEvent.click(removeButtons[removeButtons.length - 1]!);
    expect(onRemove).toHaveBeenCalledWith("selected");
  });
});
