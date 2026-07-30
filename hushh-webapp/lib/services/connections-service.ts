import { ApiService } from "@/lib/services/api-service";
import {
  canonicalConsentExportAad,
  canonicalConsentExportJson,
  type ConsentExportAadV2,
} from "@/lib/consent/export-envelope-v2";
import type { ConnectScopedExportEnvelope } from "@/lib/connect/requester-key";

export type ConnectionRelationship =
  | "none"
  | "pending_outgoing"
  | "pending_incoming"
  | "connected";

export interface DirectoryPerson {
  userId: string;
  displayName: string | null;
  photoUrl: string | null;
  email: string | null;
  relationship: ConnectionRelationship;
}

export interface DirectoryPage {
  items: DirectoryPerson[];
  page: number;
  hasMore: boolean;
}

export interface ConnectionSummaryEntry {
  connectionId: string;
  userId: string;
  displayName: string | null;
  photoUrl: string | null;
  createdAt: string | null;
}

export interface ConnectionRequest {
  id: string;
  requesterUserId: string;
  addresseeUserId: string;
  status: string;
  message: string | null;
  counterpartUserId: string;
  counterpartDisplayName: string | null;
}

/** A curated bundle of related scopes the requester can ask for in one tap. */
export interface RequestableScopeBundle {
  id: string;
  label: string;
  description: string;
  icon_name: string | null;
  color_hex: string | null;
  scopes: string[];
}

/** A single requestable data scope with display metadata + sensitivity tier. */
export interface RequestableScope {
  scope: string;
  label: string | null;
  description: string | null;
  icon_name: string | null;
  color_hex: string | null;
  sensitivity: "high" | "low";
}

/** Global, presence-safe catalog powering the Connect scope picker. It reflects
 * no specific user's holdings, so surfacing it cannot leak whether the person
 * being connected with has any given data. */
export interface RequestableScopeCatalog {
  bundles: RequestableScopeBundle[];
  scopes: RequestableScope[];
}

/** Raw wire shape of one received scope export (mirrors the backend's
 * `list_received_scope_exports` dict). Kept internal; callers get the mapped,
 * decryption-ready {@link ReceivedScopeExport}. */
interface RawReceivedScopeExport {
  granter_user_id: string | null;
  granter_display_name: string | null;
  scope: string | null;
  scope_handle: string | null;
  grant_id: string | null;
  export_revision: number | null;
  export_generated_at: string | null;
  expires_at: string | null;
  encrypted_data: string | null;
  iv: string | null;
  tag: string | null;
  wrapped_key_bundle: {
    wrapped_export_key?: string | null;
    wrapped_key_iv?: string | null;
    wrapped_key_tag?: string | null;
    sender_public_key?: string | null;
    wrapping_alg?: string | null;
    connector_key_id?: string | null;
  } | null;
  export_envelope: {
    version: number | null;
    export_id: string | null;
    aad: ConsentExportAadV2 | null;
    aad_sha256: string | null;
    ciphertext_sha256: string | null;
    ciphertext_bytes: number | null;
  } | null;
}

/** A scope another user sealed to this device via the Connect ZK pipeline,
 * carrying display metadata plus a ready-to-decrypt {@link ConnectScopedExportEnvelope}
 * (both AAD strings are pre-computed to match the owner's wrap-time bytes). */
export interface ReceivedScopeExport {
  granterUserId: string | null;
  granterDisplayName: string | null;
  scope: string | null;
  scopeHandle: string | null;
  grantId: string | null;
  exportRevision: number | null;
  exportGeneratedAt: string | null;
  expiresAt: string | null;
  envelope: ConnectScopedExportEnvelope;
}

function authHeaders(idToken: string): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` };
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error((payload as { error?: string })?.error || `Request failed (${response.status})`);
  }
  return payload as T;
}

export class ConnectionsService {
  static async searchDirectory(opts: {
    idToken: string;
    query?: string;
    page?: number;
    limit?: number;
  }): Promise<DirectoryPage> {
    const params = new URLSearchParams();
    if (opts.query) params.set("query", opts.query);
    params.set("page", String(opts.page ?? 1));
    if (typeof opts.limit === "number") params.set("limit", String(opts.limit));
    const response = await ApiService.apiFetch(`/api/one/connections/directory?${params.toString()}`, {
      method: "GET",
      headers: authHeaders(opts.idToken),
    });
    return jsonOrThrow<DirectoryPage>(response);
  }

  static async listConnections(opts: { idToken: string }): Promise<ConnectionSummaryEntry[]> {
    const response = await ApiService.apiFetch("/api/one/connections", {
      method: "GET",
      headers: authHeaders(opts.idToken),
    });
    const payload = await jsonOrThrow<{ items: ConnectionSummaryEntry[] }>(response);
    return payload.items ?? [];
  }

  static async listRequests(opts: {
    idToken: string;
    direction: "incoming" | "outgoing";
  }): Promise<ConnectionRequest[]> {
    const response = await ApiService.apiFetch(
      `/api/one/connections/requests?direction=${opts.direction}`,
      { method: "GET", headers: authHeaders(opts.idToken) },
    );
    const payload = await jsonOrThrow<{ items: ConnectionRequest[] }>(response);
    return payload.items ?? [];
  }

  /** Global catalog of scopes/bundles the requester may ask for. Presence-safe:
   * it does not reflect the addressee's actual holdings. */
  static async listRequestableScopes(opts: {
    idToken: string;
  }): Promise<RequestableScopeCatalog> {
    const response = await ApiService.apiFetch(
      "/api/one/connections/requestable-scopes",
      { method: "GET", headers: authHeaders(opts.idToken) },
    );
    const payload = await jsonOrThrow<RequestableScopeCatalog>(response);
    return { bundles: payload.bundles ?? [], scopes: payload.scopes ?? [] };
  }

  /** List scope exports other users sealed to THIS user's Connect requester key.
   * Each item is returned decryption-ready: the owner wrapped the export key with
   * the full v2 envelope submission as AAD and encrypted the payload with the AAD
   * object alone, so we recompute both here byte-for-byte. Rows missing the
   * wrapped key or the authenticated AAD are undecryptable and dropped. Nothing
   * here is plaintext — decryption happens on-device via the stored private key. */
  static async listReceivedExports(opts: {
    idToken: string;
  }): Promise<ReceivedScopeExport[]> {
    const response = await ApiService.apiFetch(
      "/api/one/connections/received-exports",
      { method: "GET", headers: authHeaders(opts.idToken) },
    );
    const payload = await jsonOrThrow<{ items: RawReceivedScopeExport[] }>(response);
    const items = payload.items ?? [];
    const mapped: ReceivedScopeExport[] = [];
    for (const raw of items) {
      const bundle = raw.wrapped_key_bundle;
      const env = raw.export_envelope;
      // Every field below is required to unwrap + decrypt; a missing one means
      // the row can never be opened on this device, so skip it silently.
      if (
        !bundle?.wrapped_export_key ||
        !bundle.wrapped_key_iv ||
        !bundle.wrapped_key_tag ||
        !bundle.sender_public_key ||
        !raw.encrypted_data ||
        !raw.iv ||
        !raw.tag ||
        !env?.aad
      ) {
        continue;
      }
      const envelope: ConnectScopedExportEnvelope = {
        wrappingAlg: bundle.wrapping_alg ?? undefined,
        connectorKeyId: bundle.connector_key_id ?? undefined,
        wrappedExportKey: bundle.wrapped_export_key,
        wrappedKeyIv: bundle.wrapped_key_iv,
        wrappedKeyTag: bundle.wrapped_key_tag,
        senderPublicKey: bundle.sender_public_key,
        // Key-wrap AAD = canonical JSON of the FULL v2 envelope submission.
        keyAdditionalData: canonicalConsentExportJson(env),
        ciphertext: raw.encrypted_data,
        iv: raw.iv,
        tag: raw.tag,
        // Data-encrypt AAD = canonical JSON of the AAD object alone.
        dataAdditionalData: canonicalConsentExportAad(env.aad),
      };
      mapped.push({
        granterUserId: raw.granter_user_id ?? null,
        granterDisplayName: raw.granter_display_name ?? null,
        scope: raw.scope ?? null,
        scopeHandle: raw.scope_handle ?? null,
        grantId: raw.grant_id ?? null,
        exportRevision: raw.export_revision ?? null,
        exportGeneratedAt: raw.export_generated_at ?? null,
        expiresAt: raw.expires_at ?? null,
        envelope,
      });
    }
    return mapped;
  }

  /** Send a connection request, optionally bundling a granular scope ask. When
   * `requestedScopes` is present the caller also publishes its on-device X25519
   * public key so the addressee can ZK-wrap each granted scope to it. */
  static async sendRequest(opts: {
    idToken: string;
    addresseeUserId: string;
    message?: string;
    requestedScopes?: string[];
    requesterPublicKey?: string;
    requesterKeyId?: string;
  }): Promise<void> {
    const body: Record<string, unknown> = {
      addressee_user_id: opts.addresseeUserId,
      message: opts.message,
    };
    if (opts.requestedScopes && opts.requestedScopes.length > 0) {
      body.requested_scopes = opts.requestedScopes;
      if (opts.requesterPublicKey) body.requester_public_key = opts.requesterPublicKey;
      if (opts.requesterKeyId) body.requester_key_id = opts.requesterKeyId;
    }
    const response = await ApiService.apiFetch("/api/one/connections/requests", {
      method: "POST",
      headers: authHeaders(opts.idToken),
      body: JSON.stringify(body),
    });
    await jsonOrThrow<unknown>(response);
  }

  /** Accept a connection request. Pass `grantedScopes`/`deniedScopes` to apply a
   * per-scope decision at accept time; omit both to queue every requested scope
   * for later per-scope resolution in the consent center. */
  static async accept(opts: {
    idToken: string;
    requestId: string;
    grantedScopes?: string[];
    deniedScopes?: string[];
  }): Promise<void> {
    const hasDecision =
      opts.grantedScopes !== undefined || opts.deniedScopes !== undefined;
    const response = await ApiService.apiFetch(
      `/api/one/connections/requests/${encodeURIComponent(opts.requestId)}/accept`,
      {
        method: "POST",
        headers: authHeaders(opts.idToken),
        ...(hasDecision
          ? {
              body: JSON.stringify({
                granted_scopes: opts.grantedScopes ?? null,
                denied_scopes: opts.deniedScopes ?? null,
              }),
            }
          : {}),
      },
    );
    await jsonOrThrow<unknown>(response);
  }

  static async reject(opts: { idToken: string; requestId: string }): Promise<void> {
    const response = await ApiService.apiFetch(
      `/api/one/connections/requests/${encodeURIComponent(opts.requestId)}/reject`,
      { method: "POST", headers: authHeaders(opts.idToken) },
    );
    await jsonOrThrow<unknown>(response);
  }

  static async cancel(opts: { idToken: string; requestId: string }): Promise<void> {
    const response = await ApiService.apiFetch(
      `/api/one/connections/requests/${encodeURIComponent(opts.requestId)}/cancel`,
      { method: "POST", headers: authHeaders(opts.idToken) },
    );
    await jsonOrThrow<unknown>(response);
  }

  static async removeConnection(opts: { idToken: string; connectionId: string }): Promise<void> {
    const response = await ApiService.apiFetch(
      `/api/one/connections/${encodeURIComponent(opts.connectionId)}`,
      { method: "DELETE", headers: authHeaders(opts.idToken) },
    );
    await jsonOrThrow<unknown>(response);
  }

  static async linkCircleInvite(opts: { idToken: string; peerUserId: string }): Promise<void> {
    const response = await ApiService.apiFetch("/api/one/connections/link-circle-invite", {
      method: "POST",
      headers: authHeaders(opts.idToken),
      body: JSON.stringify({ peer_user_id: opts.peerUserId }),
    });
    await jsonOrThrow<unknown>(response);
  }
}
