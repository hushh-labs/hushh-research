import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { apiErrorCode, apiJson } from "@/lib/services/api-client";
import { ApiService } from "@/lib/services/api-service";

const MAX_SOURCE_ROWS = 5_000;
const COUNTERPART_REF = /^sub_[0-9a-f]{32}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MODES = ["live", "test", "legacy"] as const;
const STATUSES = ["awaiting_payment", "checkout_open", "paid", "refunded", "expired"] as const;
const REFUND_STATUSES = ["queued", "dispatching", "unknown", "pending", "manual_review", "succeeded", "failed"] as const;

export type DocumentRequestPayment = {
  requestId: string;
  counterpartRef: string;
  mode: (typeof MODES)[number];
  status: (typeof STATUSES)[number];
  amountCents: number;
  currency: "USD";
  paidAt: string | null;
  refundStatus: (typeof REFUND_STATUSES)[number] | null;
  refundAmountCents: number | null;
  reconciliationRequired: boolean;
  createdAt: string;
  updatedAt: string;
};

export class DocumentRequestPaymentSourceCapacityError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function instant(value: unknown): value is string {
  return typeof value === "string" && INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

function oneOf<const T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.some((item) => item === value);
}

/** Accept only a certified, complete owner snapshot. Extra server fields are
 * deliberately discarded before any value reaches the encrypted projection. */
export function parseDocumentRequestPaymentSnapshot(body: unknown, ownerUserId: string): DocumentRequestPayment[] {
  if (!ownerUserId || !isRecord(body) || body.schemaVersion !== 1 ||
      body.ownerUserId !== ownerUserId || body.sourceReadVerified !== true ||
      !instant(body.asOf) || !Array.isArray(body.items))
    throw new Error("Document request payment snapshot is incomplete");
  if (body.items.length > MAX_SOURCE_ROWS)
    throw new DocumentRequestPaymentSourceCapacityError("Payment source exceeds its safe bound");
  const seen = new Set<string>();
  const rows: DocumentRequestPayment[] = [];
  for (const raw of body.items) {
    if (!isRecord(raw) || typeof raw.requestId !== "string" ||
        !DOCUMENT_REQUEST_UUID.test(raw.requestId) || seen.has(raw.requestId.toLowerCase()) ||
        typeof raw.counterpartRef !== "string" || !COUNTERPART_REF.test(raw.counterpartRef) ||
        !oneOf(MODES, raw.mode) || !oneOf(STATUSES, raw.status) ||
        !Number.isSafeInteger(raw.amountCents) ||
        (raw.amountCents as number) < 50 || (raw.amountCents as number) > 50_000 ||
        raw.currency !== "USD" ||
        !(raw.paidAt === null || instant(raw.paidAt)) ||
        !oneOf(REFUND_STATUSES, raw.refundStatus) && raw.refundStatus !== null ||
        !(raw.refundAmountCents === null ||
          (Number.isSafeInteger(raw.refundAmountCents) &&
            (raw.refundAmountCents as number) >= 1 &&
            (raw.refundAmountCents as number) <= (raw.amountCents as number))) ||
        (raw.refundStatus === null && raw.refundAmountCents !== null) ||
        (raw.status === "paid" || raw.status === "refunded") !== (raw.paidAt !== null) ||
        typeof raw.reconciliationRequired !== "boolean" ||
        !instant(raw.createdAt) || !instant(raw.updatedAt))
      throw new Error("Document request payment row is invalid");
    seen.add(raw.requestId.toLowerCase());
    rows.push({
      requestId: raw.requestId.toLowerCase(),
      counterpartRef: raw.counterpartRef,
      mode: raw.mode,
      status: raw.status,
      amountCents: raw.amountCents as number,
      currency: "USD",
      paidAt: raw.paidAt as string | null,
      refundStatus: raw.refundStatus as DocumentRequestPayment["refundStatus"],
      refundAmountCents: raw.refundAmountCents as number | null,
      reconciliationRequired: raw.reconciliationRequired,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    });
  }
  return rows.sort((a, b) => a.requestId.localeCompare(b.requestId));
}

export class DocumentRequestPaymentSourceService {
  static async snapshot(vaultOwnerToken: string, ownerUserId: string): Promise<DocumentRequestPayment[]> {
    if (!vaultOwnerToken || !ownerUserId) throw new Error("Owner authorization unavailable");
    let body: unknown;
    try {
      body = await apiJson<unknown>("/api/one/source-snapshots/document-request-payments", {
        method: "GET",
        headers: ApiService.getAuthHeaders(vaultOwnerToken),
        cache: "no-store",
      });
    } catch (error) {
      if (apiErrorCode(error) === "SOURCE_CAPACITY_EXCEEDED")
        throw new DocumentRequestPaymentSourceCapacityError("Payment source exceeds its safe bound");
      throw error;
    }
    return parseDocumentRequestPaymentSnapshot(body, ownerUserId);
  }
}
