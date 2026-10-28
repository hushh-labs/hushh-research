import { traceDriveRequest } from "@/lib/consent/drive-request-diagnostics";
/**
 * Requester-only document request calls: the Google account files go to,
 * the requester's own terms, and asking the owner to review unshared files.
 *
 * Responses stay in the caller's memory, never a cache. The recovery and price
 * parsers live in lib/consent/document-request-requester-view.ts so the
 * delivery parser can share them without an import cycle.
 */
import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import {
  parseReviewRequestResult,
  type ReviewRequestResult,
} from "@/lib/consent/document-request-requester-view";
import { ApiService } from "@/lib/services/api-service";
import {
  DriveSharingError,
  DriveSharingService,
  type SharingRequestContext,
  type SharingSessionGuard,
} from "@/lib/services/drive-sharing-service";

export {
  parseOwnerReviewRequest,
  parseRequesterRecovery,
  parseReviewRequestResult,
  presentOwnerReviewRequest,
  presentRequesterRecovery,
  requesterPriceLine,
  type OwnerReviewRequest,
  type OwnerRetryState,
  type RecoveryRefundState,
  type RequesterRecovery,
  type ReviewRequestResult,
} from "@/lib/consent/document-request-requester-view";

const SHARING_PATH = "/api/connectors/google_drive/sharing";
const RESPONSE_MAX_LENGTH = 16 * 1024;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

export type RecipientIdentity = { email: string; provider: "google.com" };

type RecordValue = Record<string, unknown>;

async function send(path: string, init: RequestInit, guard: SharingSessionGuard): Promise<RecordValue> {
  guard();
  return traceDriveRequest(path, init.method || "GET", async (diagnosticHeaders, observe) => {
    guard();
    const response = await ApiService.apiFetch(path, {
      ...init,
      headers: {
        ...(init.headers instanceof Headers || Array.isArray(init.headers)
          ? Object.fromEntries(new Headers(init.headers)) : init.headers),
        ...diagnosticHeaders,
      },
      cache: "no-store",
      isEffectCurrent: () => {
        guard();
        return true;
      },
  });
  guard();
  observe(response);
  const serialized = await response.text();
  guard();
  if (serialized.length > RESPONSE_MAX_LENGTH) throw new DriveSharingError("invalid_response");
  let payload: unknown;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw new DriveSharingError("invalid_response", response.status);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new DriveSharingError("invalid_response", response.status);
  const body = payload as RecordValue;
  observe(response, body);
  if (!response.ok) {
    const detail =
      body.detail && typeof body.detail === "object" && !Array.isArray(body.detail)
        ? (body.detail as RecordValue)
        : body;
    // Never render provider or HTTP messages; only a closed lowercase code.
    const code =
      typeof detail.code === "string" && /^[a-z_]{1,80}$/.test(detail.code)
        ? detail.code
        : "request_failed";
    throw new DriveSharingError(code, response.status);
  }
  return body;
  });
}

export class DriveRequestRequesterService {
  /**
   * The Google account a new request's files would be shared with, as the
   * server verifies it when sending. Never derived from client providerData,
   * which native builds synthesize from the sign-in email.
   * 409 verify_google_identity_required: no linked Google account yet.
   */
  static async recipientIdentity(
    vaultToken: string,
    firebaseToken: string,
    guard: SharingSessionGuard,
  ): Promise<RecipientIdentity> {
    if (!vaultToken || !firebaseToken) throw new DriveSharingError("invalid_argument");
    const result = await send(
      `${SHARING_PATH}/recipient-identity`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${firebaseToken}`, "X-Hushh-Consent": vaultToken },
      },
      guard,
    );
    const email = result.email;
    if (
      result.provider !== "google.com" ||
      typeof email !== "string" ||
      email.length > 254 ||
      !EMAIL.test(email)
    )
      throw new DriveSharingError("invalid_response");
    return { email, provider: "google.com" };
  }

  /** The requester's own terms: purpose, period, sent time and the sealed Google account. */
  static requesterContext(
    token: string,
    requestId: string,
    guard: SharingSessionGuard,
  ): Promise<SharingRequestContext> {
    return DriveSharingService.requesterContext(token, requestId, guard);
  }

  /** Ask the owner to review files that were not shared. Grants nothing; holds no refund. */
  static async reviewRequest(
    token: string,
    requestId: string,
    guard: SharingSessionGuard,
  ): Promise<ReviewRequestResult> {
    if (!token || !DOCUMENT_REQUEST_UUID.test(requestId))
      throw new DriveSharingError("invalid_argument");
    const result = await send(
      `${SHARING_PATH}/requests/${requestId}/review-request`,
      {
        method: "POST",
        headers: { ...ApiService.getAuthHeaders(token), "Content-Type": "application/json" },
        body: "{}",
      },
      guard,
    );
    const parsed = parseReviewRequestResult(result, requestId);
    if (!parsed) throw new DriveSharingError("invalid_response");
    return parsed;
  }
}
