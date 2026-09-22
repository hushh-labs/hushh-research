import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { ApiService } from "@/lib/services/api-service";

export type SharingStatus = {
  requestId: string;
  status: string;
  revision: number;
  direction: "incoming" | "outgoing";
};
export type SharingReview = {
  revision: number;
  status: string;
  recipientEmail: string;
  purpose: {
    purpose: string;
    periodStart: string | null;
    periodEnd: string | null;
  };
  files: { documentId: string; name: string }[];
  coverage: {
    summary: string;
    status: string;
    gaps: string[];
    truncated: boolean;
  } | null;
  reviewDigest: string | null;
  expiresAt: string | null;
  canApprove: boolean;
};
export type SharingDelivery = {
  status: string;
  files: {
    name: string;
    status: string;
    revocationStatus: string | null;
    grantId: string | null;
    managed: boolean;
    openUrl: string | null;
    manageInGoogle: boolean;
  }[];
};
export type SharingRevocationReview = {
  revision: number;
  directiveId: string;
  reviewDigest: string;
  expiresAt: string;
  files: { grantId: string; name: string; recipientEmail: string }[];
};

export class DriveSharingError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 0,
  ) {
    super("Could not complete the document request. Refresh and try again.");
  }
}
type RecordValue = Record<string, unknown>;
export type SharingSessionGuard = () => void;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DriveSharingError("invalid_response");
  return value as RecordValue;
}
function string(value: unknown, max = 2000): string {
  if (typeof value !== "string" || value.length > max)
    throw new DriveSharingError("invalid_response");
  return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new DriveSharingError("invalid_response");
  return value as number;
}
function id(value: unknown): string {
  const result = string(value, 36);
  if (!DOCUMENT_REQUEST_UUID.test(result))
    throw new DriveSharingError("invalid_response");
  return result;
}
function files<T>(value: unknown, parse: (item: RecordValue) => T): T[] {
  if (!Array.isArray(value) || value.length > 25)
    throw new DriveSharingError("invalid_response");
  return value.map((item) => parse(record(item)));
}
function digest(value: unknown): string {
  const result = string(value, 64);
  if (!/^[0-9a-f]{64}$/.test(result))
    throw new DriveSharingError("invalid_response");
  return result;
}
function date(value: unknown): string {
  const result = string(value, 64);
  if (!Number.isFinite(Date.parse(result)))
    throw new DriveSharingError("invalid_response");
  return result;
}

/** Private responses stay in the invoking component's memory, never a cache. */
export class DriveSharingService {
  private static async request(
    token: string,
    requestId: string,
    guard: SharingSessionGuard,
    action = "",
    body?: object,
  ): Promise<RecordValue> {
    id(requestId);
    guard();
    const response = await ApiService.apiFetch(
      `/api/connectors/google_drive/sharing/requests/${requestId}${action}`,
      {
        isEffectCurrent: () => {
          guard();
          return true;
        },
        method: body === undefined ? "GET" : "POST",
        cache: "no-store",
        headers: {
          ...ApiService.getAuthHeaders(token),
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    guard();
    const serialized = await response.text();
    guard();
    if (serialized.length > 64 * 1024)
      throw new DriveSharingError("invalid_response");
    let payload: RecordValue;
    try {
      payload = record(JSON.parse(serialized));
    } catch {
      throw new DriveSharingError("invalid_response", response.status);
    }
    if (!response.ok) {
      const detail =
        payload.detail && typeof payload.detail === "object"
          ? record(payload.detail)
          : payload;
      const code =
        typeof detail.code === "string" && /^[a-z_]{1,80}$/.test(detail.code)
          ? detail.code
          : "request_failed";
      // Never render arbitrary provider/HTTP messages or log response contents.
      throw new DriveSharingError(code, response.status);
    }
    return payload;
  }

  static async status(
    token: string,
    requestId: string,
    guard: SharingSessionGuard,
  ): Promise<SharingStatus> {
    const result = await this.request(token, requestId, guard);
    if (result.direction !== "incoming" && result.direction !== "outgoing")
      throw new DriveSharingError("invalid_response");
    if (id(result.requestId) !== requestId)
      throw new DriveSharingError("invalid_response");
    return {
      requestId,
      revision: revision(result.revision),
      status: string(result.status, 80),
      direction: result.direction,
    };
  }

  static async review(
    token: string,
    requestId: string,
    guard: SharingSessionGuard,
  ): Promise<SharingReview> {
    const result = await this.request(token, requestId, guard, "/review");
    if (id(result.requestId) !== requestId)
      throw new DriveSharingError("invalid_response");
    const purpose = record(result.purpose);
    const selected = files(result.files, (file) => ({
      documentId: id(file.documentId),
      name: string(file.name, 1024),
    }));
    if (
      new Set(selected.map((file) => file.documentId)).size !== selected.length
    )
      throw new DriveSharingError("invalid_response");
    const coverage = result.coverage ? record(result.coverage) : null;
    if (
      coverage?.gaps != null &&
      (!Array.isArray(coverage.gaps) || coverage.gaps.length > 24)
    )
      throw new DriveSharingError("invalid_response");
    const expiresAt = result.expiresAt == null ? null : date(result.expiresAt);
    const reviewDigest =
      result.reviewDigest == null ? null : digest(result.reviewDigest);
    return {
      revision: revision(result.revision),
      status: string(result.status, 80),
      recipientEmail: string(result.recipientEmail, 320),
      purpose: {
        purpose: string(purpose.purpose),
        periodStart:
          purpose.periodStart == null ? null : string(purpose.periodStart, 10),
        periodEnd:
          purpose.periodEnd == null ? null : string(purpose.periodEnd, 10),
      },
      files: selected,
      coverage: coverage
        ? {
            summary: string(coverage.coverage_summary ?? coverage.summary),
            status: string(coverage.coverage_status ?? "unknown", 30),
            gaps: ((coverage.gaps ?? []) as unknown[]).map((gap) =>
              string(gap),
            ),
            truncated: coverage.truncated === true,
          }
        : null,
      expiresAt,
      reviewDigest,
      canApprove:
        result.canApprove === true &&
        result.status === "review_ready" &&
        selected.length > 0 &&
        !!expiresAt &&
        !!reviewDigest,
    };
  }

  static async delivery(
    token: string,
    requestId: string,
    guard: SharingSessionGuard,
  ): Promise<SharingDelivery> {
    const result = await this.request(token, requestId, guard, "/delivery");
    if (id(result.requestId) !== requestId)
      throw new DriveSharingError("invalid_response");
    return {
      status: string(result.status, 80),
      files: files(result.files, (file) => {
        const openUrl = file.openUrl == null ? null : string(file.openUrl, 512);
        if (
          openUrl &&
          !/^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+\/view$/.test(
            openUrl,
          )
        )
          throw new DriveSharingError("invalid_response");
        return {
          name: string(file.name, 1024),
          status: string(file.status, 80),
          revocationStatus:
            file.revocationStatus == null
              ? null
              : string(file.revocationStatus, 80),
          grantId: file.grantId == null ? null : id(file.grantId),
          managed: file.managed === true,
          openUrl,
          manageInGoogle: file.manageInGoogle === true,
        };
      }),
    };
  }

  static approve(
    token: string,
    requestId: string,
    review: SharingReview,
    guard: SharingSessionGuard,
  ) {
    if (
      !review.canApprove ||
      !review.expiresAt ||
      Date.parse(review.expiresAt) <= Date.now()
    )
      throw new DriveSharingError("review_changed");
    return this.request(token, requestId, guard, "/approve", {
      revision: review.revision,
      reviewDigest: review.reviewDigest,
      documentIds: review.files.map((file) => file.documentId),
      confirmed: true,
    });
  }
  static decide(
    token: string,
    requestId: string,
    action: "decline" | "cancel" | "review/refresh",
    value: number,
    guard: SharingSessionGuard,
  ) {
    return this.request(token, requestId, guard, `/${action}`, {
      revision: value,
    });
  }
  static async prepareRevocation(
    token: string,
    requestId: string,
    guard: SharingSessionGuard,
  ): Promise<SharingRevocationReview> {
    const result = await this.request(
      token,
      requestId,
      guard,
      "/revocation/prepare",
      {},
    );
    if (id(result.requestId) !== requestId)
      throw new DriveSharingError("invalid_response");
    return {
      revision: revision(result.revision),
      directiveId: string(result.directiveId, 200),
      reviewDigest: digest(result.reviewDigest),
      expiresAt: date(result.expiresAt),
      files: files(result.files, (file) => ({
        grantId: id(file.grantId),
        name: string(file.name, 1024),
        recipientEmail: string(file.recipientEmail, 320),
      })),
    };
  }
  static revoke(
    token: string,
    requestId: string,
    review: SharingRevocationReview,
    guard: SharingSessionGuard,
  ) {
    if (Date.parse(review.expiresAt) <= Date.now())
      throw new DriveSharingError("review_changed");
    return this.request(token, requestId, guard, "/revocation/confirm", {
      revision: review.revision,
      directiveId: review.directiveId,
      reviewDigest: review.reviewDigest,
      grantIds: review.files.map((file) => file.grantId),
      confirmed: true,
    });
  }
}
