import { vi } from "vitest";
import type { OneLocationRecipient } from "@/lib/one-location/types";

export const recipient = (
  overrides: Partial<OneLocationRecipient>,
): OneLocationRecipient => ({
  userId: "u1",
  displayName: "Carol",
  phoneVerified: true,
  keyAlgorithm: "ECDH-P256-AES256-GCM",
  canReceiveLocation: true,
  ...overrides,
});

export const baseProps = {
  recipients: [recipient({ userId: "u1", displayName: "Carol" })],
  active: false,
  busy: false,
  onTrigger: vi.fn(),
  onStopSos: vi.fn(),
  stopBusy: false,
  onClose: vi.fn(),
  onEditContacts: vi.fn(),
  recipientLabel: (value: OneLocationRecipient) => value.displayName,
  isRecipientShareReady: (value: OneLocationRecipient) =>
    value.canReceiveLocation,
  emergency: {
    countryCode: "IN",
    countryName: "India",
    number: "112",
  },
  emergencyStatus: "resolved" as const,
  onResolveEmergencyNumber: vi.fn(),
};
