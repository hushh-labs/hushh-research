"use client";

import { publishVoiceCard } from "@/lib/voice/voice-action-card";

export type LocationCommandStatusCardV1 = {
  cardId:
    | "one.location.command.circle_verified.v1"
    | "one.location.command.location_verified.v1";
  actionId: "location.create_circle" | "workflow.setup.location";
};

const LOCATION_COMMAND_STATUS_CARD_COPY = {
  "one.location.command.circle_verified.v1": {
    actionId: "location.create_circle",
    heading: "Circle ready",
    fields: [{ label: "Status", value: "Verified" }],
  },
  "one.location.command.location_verified.v1": {
    actionId: "workflow.setup.location",
    heading: "Location ready",
    fields: [{ label: "Status", value: "Verified" }],
  },
} as const;

/**
 * Result cards are fixed client catalog entries, never server/model prose.
 * The command relay supplies only an already-validated identifier after an
 * audited settlement.
 */
export function publishLocationCommandStatusCard(
  input: LocationCommandStatusCardV1,
): boolean {
  const card = LOCATION_COMMAND_STATUS_CARD_COPY[input.cardId];
  if (!card || card.actionId !== input.actionId) return false;
  publishVoiceCard({
    kind: "data",
    heading: card.heading,
    shape: "summary",
    summary: { fields: [...card.fields], breakdowns: [] },
  });
  return true;
}
