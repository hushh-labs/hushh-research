import { z } from "zod";
import { recipientEnvelopeSchema } from "@/lib/finance-sharing/contract";

const finite = z.number().finite();
const short = z.string().max(200);
export const advisorSnapshotSchema = z
  .object({
    schema: z.literal("advisor-finance-snapshot-v1"),
    capturedAt: z.string().datetime(),
    source: z.enum(["statement", "plaid"]),
    period: z.string().max(100).nullable(),
    total: finite,
    cash: finite.nullable(),
    holdings: z
      .array(
        z
          .object({
            symbol: short,
            name: short,
            value: finite,
            quantity: finite.nullable(),
            costBasis: finite.nullable(),
            sector: short.nullable(),
            assetType: short.nullable(),
          })
          .strict(),
      )
      .max(2000),
    allocation: z
      .array(z.object({ name: short, value: finite }).strict())
      .max(100),
    history: z
      .array(z.object({ date: z.string().max(40), value: finite }).strict())
      .max(366),
    profile: z
      .object({
        horizon: z.enum(["short_term", "medium_term", "long_term"]).nullable(),
        risk: z.enum(["conservative", "balanced", "aggressive"]).nullable(),
        drawdown: z.enum(["reduce", "stay", "buy_more"]).nullable(),
        volatility: z.enum(["small", "moderate", "large"]).nullable(),
      })
      .strict(),
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AdvisorSnapshot = z.infer<typeof advisorSnapshotSchema>;
export type AdvisorCandidate = {
  userId: string;
  personRef: string;
  name: string;
  bio: string;
  crd: string | null;
  verified: true;
  keyId: string | null;
  publicKeyJwk: JsonWebKey | null;
  ready: boolean;
};
export type AdvisorMeeting = {
  id?: string;
  status:
    | "proposed"
    | "agreed"
    | "review_ready"
    | "booking"
    | "retryable"
    | "confirmed"
    | "completed"
    | "cancelled"
    | "unknown";
  startAt?: string;
  endAt?: string;
  timeZone?: string;
  proposedBy?: string;
  agreedBy?: string[];
  proposalId?: string;
  invitationEmail?: string;
  joinUrl?: string | null;
  eventId?: string;
  reviewExpiresAt?: string;
};
export type AdvisorPlan = {
  amountCents: number;
  currency: "usd";
  interval: "month";
  services: string;
  cancellationTerms: string;
};
const instant = z.string().datetime({ offset: true });
const meetingSchema = z
  .object({
    id: z.string().uuid().optional(),
    status: z.enum([
      "proposed",
      "agreed",
      "review_ready",
      "booking",
      "retryable",
      "confirmed",
      "completed",
      "cancelled",
      "unknown",
    ]),
    startAt: instant.optional(),
    endAt: instant.optional(),
    timeZone: z.string().max(80).optional(),
    proposedBy: z.string().max(160).optional(),
    agreedBy: z.array(z.string().max(160)).max(2).optional(),
    operation: z.enum(["create", "cancel"]).optional(),
    calendarBinding: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    proposalId: z.string().max(200).optional(),
    invitationEmail: z.string().max(320).optional(),
    joinUrl: z.string().max(2000).nullable().optional(),
    eventId: z.string().max(2048).optional(),
    reviewExpiresAt: instant.optional(),
  })
  .strict();
const planSchema = z
  .object({
    amountCents: z.number().int().min(100).max(100000),
    currency: z.literal("usd"),
    interval: z.literal("month"),
    services: z.string().min(20).max(1500),
    cancellationTerms: z.string().min(20).max(1500),
  })
  .strict();
export const advisorReviewSchema = z
  .object({
    id: z.string().uuid(),
    ownerUserId: z.string().min(1).max(160),
    ownerPersonRef: z.string().uuid(),
    advisorUserId: z.string().min(1).max(160),
    advisorPersonRef: z.string().uuid(),
    ownerName: z.string().max(300),
    advisorName: z.string().max(300),
    direction: z.enum(["outgoing", "received"]),
    status: z.enum([
      "pending",
      "accepted",
      "declined",
      "withdrawn",
      "stopped",
      "expired",
    ]),
    introduction: z.string().max(600),
    createdAt: instant,
    expiresAt: instant,
    serverNow: instant,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    snapshotAvailable: z.boolean(),
    alreadyConnected: z.boolean().optional(),
    meeting: meetingSchema.nullable(),
    plan: planSchema.nullable(),
    planRevision: z.number().int().nonnegative(),
    envelope: recipientEnvelopeSchema.optional(),
  })
  .strict();
export type AdvisorReview = z.infer<typeof advisorReviewSchema>;
export const advisorSnapshotContext = (
  id: string,
  owner: string,
  advisor: string,
) =>
  JSON.stringify([
    "advisor-finance-snapshot-v1",
    id,
    owner,
    advisor,
    "connect_and_share_finance_snapshot_v1",
    604800,
  ]);
export const advisorReviewReference = (text: string) =>
  /^\[advisor-review:([a-f0-9-]{36})\]$/i.exec(text)?.[1] ?? null;
export function advisorWorkspaceHref(id: string, advisor = false) {
  return `${advisor ? "/ria/clients" : "/one/kai/portfolio/analysis"}?advisorReview=${encodeURIComponent(id)}`;
}
