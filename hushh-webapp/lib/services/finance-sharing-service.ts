import { ApiService } from "@/lib/services/api-service";
import { OneLocationService } from "@/lib/one-location/service";
import { bootstrapCurrentUserLocationRecipientKey } from "@/lib/one-location/key-bootstrap";
import { openRecipientPayload, sealRecipientPayload, RecipientPayloadKeyUnavailableError, type RecipientPayloadEnvelope } from "@/lib/one-location/encryption";
import type { OneLocationRecipient } from "@/lib/one-location/types";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { financeConfigContext, financeContext, financeDigest, readFinanceProjection, financeGrantSchema, financeHistorySchema, financeOwnerConfigSchema, committedFinanceProjection, committedFinanceConfig, financeInformation,
  type FinanceGrant, type FinanceOwnerConfig, type FinancePolicy, type FinancePolicyInput, type FinanceProjection } from "@/lib/finance-sharing/contract";

export type FinanceShareContext = {
  userId: string; vaultKey: string; vaultOwnerToken: string;
  getIdToken: () => Promise<string>; isCurrent: () => boolean;
};
export class FinanceSharingError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code === "FINANCE_ADVISOR_NOT_VERIFIED" ? "This connection is not currently eligible for advisor review."
      : code === "DIRECT_MESSAGE_BLOCKED" || code === "DIRECT_MESSAGE_CONNECTION_REQUIRED" ? "This person is blocked or no longer connected. Check your Connections."
      : code === "FINANCE_SHARE_NOT_READY" ? "Finance sharing is not available on this server yet."
      : code === "FINANCE_SHARE_KEY_CHANGED" ? "Secure access changed. Review the recipient again."
      : status === 409 ? "Sharing changed. Refresh and review before retrying."
      : "Sharing could not be confirmed. Check Manage sharing before retrying.");
  }
}
export function requireFinanceSession(context: FinanceShareContext): void {
  if (!context.isCurrent()) throw new Error("Your vault session changed. Unlock and try again.");
}
async function request<T>(context: FinanceShareContext, path = "", method = "GET", body?: unknown): Promise<T> {
  requireFinanceSession(context);
  const token = await context.getIdToken();
  requireFinanceSession(context);
  const response = await ApiService.apiFetch(`/api/one/finance/shares${path}`, { method, cache: "no-store", isEffectCurrent: context.isCurrent,
    headers: { Authorization: `Bearer ${token}`, "X-Hushh-Consent": context.vaultOwnerToken, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  requireFinanceSession(context);
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new FinanceSharingError(error?.detail?.code ?? "FINANCE_SHARE_UNAVAILABLE", response.status);
  }
  const payload = await response.json();
  requireFinanceSession(context);
  return payload as T;
}

async function currentRecipients(context: FinanceShareContext, refs: string[]): Promise<OneLocationRecipient[]> {
  const wanted = new Set(refs);
  const byRef = new Map<string, OneLocationRecipient>();
  for (let page = 1; page <= 200; page++) {
    const result = await OneLocationService.listRecipientsPage({ vaultOwnerToken: context.vaultOwnerToken, page, limit: 50 });
    requireFinanceSession(context);
    for (const row of result.items) if (row.publicPersonRef && wanted.has(row.publicPersonRef)) byRef.set(row.publicPersonRef, row);
    if (byRef.size === wanted.size || !result.hasMore) break;
    if (result.page !== page || !result.items.length) throw new Error("Connections could not be checked.");
  }
  const found = [...byRef.values()];
  if (found.length !== wanted.size || found.some(r => r.userId === context.userId || !r.keyId || !r.publicKeyJwk)) {
    throw new Error("Each selected person needs to connect with you and unlock One before receiving Finance information.");
  }
  return found;
}

async function seal(context: FinanceShareContext, value: unknown, aad: string, recipient: OneLocationRecipient): Promise<RecipientPayloadEnvelope> {
  requireFinanceSession(context);
  if (!recipient.keyId || !recipient.publicKeyJwk) throw new Error("Secure sharing is unavailable.");
  const result = await sealRecipientPayload({ bytes: new TextEncoder().encode(JSON.stringify(value)), context: aad,
    recipientKeyId: recipient.keyId, recipientPublicKeyJwk: recipient.publicKeyJwk });
  requireFinanceSession(context);
  return result;
}
async function open(context: FinanceShareContext, envelope: RecipientPayloadEnvelope, aad: string): Promise<unknown> {
  requireFinanceSession(context);
  let plaintext: ArrayBuffer;
  try { plaintext = await openRecipientPayload({ userId: context.userId, context: aad, envelope }); }
  catch (error) {
    if (!(error instanceof RecipientPayloadKeyUnavailableError)) throw error;
    requireFinanceSession(context);
    const backup = (await OneLocationService.getState(context.vaultOwnerToken)).myRecipientKey;
    requireFinanceSession(context);
    if (!backup) throw error;
    plaintext = await openRecipientPayload({ userId: context.userId, context: aad, envelope,
      recovery: { vaultKey: context.vaultKey, remoteBackup: backup } });
  }
  requireFinanceSession(context);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export type PreparedFinanceShare = {
  requestId: string; policy: FinancePolicy; ownerConfig: RecipientPayloadEnvelope;
  recipients: { grantId: string; personRef: string; envelope: RecipientPayloadEnvelope; ownerEnvelope: RecipientPayloadEnvelope; contentHash: string }[];
};
// Only ciphertext and the original confirmation identity survive an uncertain
// acknowledgement. Never persist this queue or retain it beyond vault retirement.
const pending = new Map<string, { epoch: number; body: PreparedFinanceShare }>();
export function clearPendingFinanceShares(userId: string) { pending.delete(userId); }
export function pendingFinanceShare(context: FinanceShareContext | null): PreparedFinanceShare | null {
  if (!context) return null;
  const entry = pending.get(context.userId);
  if (!entry) return null;
  if (entry.epoch !== snapshotVaultSessionEpoch()) { pending.delete(context.userId); return null; }
  return entry.body;
}

export const FinanceSharingService = {
  async recipients(context: FinanceShareContext, query: string, page = 1) {
    requireFinanceSession(context);
    const result = await OneLocationService.listRecipientsPage({ vaultOwnerToken: context.vaultOwnerToken, query, page, limit: 30 });
    requireFinanceSession(context);
    return result;
  },
  history: async (context: FinanceShareContext, direction: "outgoing" | "received" = "outgoing", cursor?: string) =>
    financeHistorySchema.parse(await request(context, `?direction=${direction}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)) as { items: FinanceGrant[]; nextCursor: string | null },
  view: async (context: FinanceShareContext, id: string) => financeGrantSchema.parse(await request(context, `/${encodeURIComponent(id)}`)) as FinanceGrant,
  stop: (context: FinanceShareContext, id: string) => request<{ stopped: boolean }>(context, `/${encodeURIComponent(id)}`, "DELETE"),
  async publish(context: FinanceShareContext, prepared: PreparedFinanceShare) {
    requireFinanceSession(context);
    const previous = pendingFinanceShare(context);
    if (previous && previous.requestId !== prepared.requestId) throw new Error("Check the previous sharing confirmation before creating another.");
    pending.set(context.userId, { epoch: snapshotVaultSessionEpoch(), body: prepared });
    let postAccepted = false;
    try {
      const result = await request<{ items: unknown[] }>(context, "", "POST", prepared);
      postAccepted = true;
      const items = result.items.map(value => financeGrantSchema.parse(value) as FinanceGrant);
      const expected = new Map(prepared.recipients.map(recipient => [recipient.grantId, recipient]));
      const seen = new Set<string>();
      if (expected.size !== prepared.recipients.length || items.length !== expected.size || items.some(g => {
        const recipient = expected.get(g.id);
        if (!recipient || seen.has(g.id) || g.ownerUserId !== context.userId || g.requestId !== prepared.requestId
          || g.recipientPersonRef !== recipient.personRef || g.recipientKeyId !== recipient.envelope.recipientKeyId
          || g.direction !== "outgoing" || (g.revision === 1 && g.contentHash !== recipient.contentHash)
          || (g.revision !== 1 && (g.policy.version !== 1 || g.policy.mode !== "ongoing"))) return true;
        seen.add(g.id);
        return false;
      }) || items.some(g =>
        g.policy.selectionHash !== prepared.policy.selectionHash || g.policy.version !== prepared.policy.version || (g.policy.version === 2 && (prepared.policy.version !== 2 || g.policy.purpose !== prepared.policy.purpose)) || g.policy.mode !== prepared.policy.mode
        || g.policy.durationSeconds !== prepared.policy.durationSeconds || g.policy.showAmounts !== prepared.policy.showAmounts
        || g.policy.model_processing.allowed !== prepared.policy.model_processing.allowed
        || [...g.policy.sections].sort().join() !== [...prepared.policy.sections].sort().join())) throw new Error("The sharing receipt did not match the confirmation.");
      // An earlier acknowledgement can arrive after an ongoing share refreshed.
      // Recheck its current authority before treating that retry as confirmed.
      for (const item of items.filter(g => g.revision > 1)) {
        const current = await FinanceSharingService.view(context, item.id);
        if (current.id !== item.id || current.direction !== "outgoing" || current.ownerUserId !== context.userId || current.requestId !== item.requestId
          || current.revision !== item.revision || current.contentHash !== item.contentHash || current.status !== item.status
          || current.recipientPersonRef !== item.recipientPersonRef || current.recipientKeyId !== item.recipientKeyId
          || JSON.stringify(current.policy) !== JSON.stringify(item.policy)) throw new Error("The sharing receipt did not match the current access.");
      }
      pending.delete(context.userId);
      return { items };
    } catch (e) {
      if (!postAccepted && e instanceof FinanceSharingError && e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status)) pending.delete(context.userId);
      throw e;
    }
  },
  async prepare(context: FinanceShareContext, config: FinanceOwnerConfig, projection: FinanceProjection,
    policy: FinancePolicyInput, selected: OneLocationRecipient[]): Promise<PreparedFinanceShare> {
    requireFinanceSession(context);
    const recipientRows = await currentRecipients(context, selected.map(r => r.publicPersonRef!));
    for (const recipient of recipientRows) {
      if (selected.find(r => r.userId === recipient.userId)?.keyId !== recipient.keyId) throw new Error("A recipient’s secure key changed. Select them again.");
    }
    const sender = await bootstrapCurrentUserLocationRecipientKey({ ...context, strictRecovery: true });
    requireFinanceSession(context);
    const requestId = crypto.randomUUID();
    const committedConfig = committedFinanceConfig(config);
    if (committedConfig.selection.showAmounts !== policy.showAmounts
      || JSON.stringify([...committedConfig.selection.sections].sort()) !== JSON.stringify([...policy.sections].sort())) throw new Error("Sharing settings do not match the approval.");
    const approved = { ...policy, selectionHash: await financeDigest(JSON.stringify(committedConfig)) };
    const exact = committedFinanceProjection(projection, approved);
    const contentHash = await financeDigest(JSON.stringify(exact));
    const ownerConfig = await seal(context, committedConfig, financeConfigContext(context.userId, requestId), sender);
    const recipients: PreparedFinanceShare["recipients"] = [];
    for (const recipient of recipientRows) {
      const grantId = crypto.randomUUID();
      const aad = financeContext({ requestId, id: grantId, ownerUserId: context.userId, recipientUserId: recipient.userId, policy: approved, revision: 1 });
      recipients.push({ grantId, personRef: recipient.publicPersonRef!, contentHash,
        envelope: await seal(context, exact, aad, recipient), ownerEnvelope: await seal(context, exact, aad, sender) });
    }
    requireFinanceSession(context);
    return { requestId, policy: approved, ownerConfig, recipients };
  },
  async decrypt(context: FinanceShareContext, grant: FinanceGrant): Promise<FinanceProjection> {
    if (grant.status !== "active" || !grant.envelope || ![grant.ownerUserId, grant.recipientUserId].includes(context.userId)) throw new Error("Sharing has ended.");
    const value = readFinanceProjection(await open(context, grant.envelope, financeContext(grant)), grant.policy);
    if (!value.commitmentNonce || await financeDigest(JSON.stringify(value)) !== grant.contentHash) throw new Error("Shared contents could not be verified.");
    // Revocation/expiry/key change wins while decryption was in flight.
    const current = await FinanceSharingService.view(context, grant.id);
    if (current.status !== "active" || current.revision !== grant.revision || current.contentHash !== grant.contentHash) throw new Error("Sharing changed. Open it again.");
    requireFinanceSession(context);
    return value;
  },
  async ownerConfig(context: FinanceShareContext, grant: FinanceGrant): Promise<FinanceOwnerConfig> {
    if (grant.ownerUserId !== context.userId || !grant.ownerConfig) throw new Error("Owner settings unavailable.");
    const value = financeOwnerConfigSchema.parse(await open(context, grant.ownerConfig, financeConfigContext(context.userId, grant.requestId)));
    if (!value.commitmentNonce || await financeDigest(JSON.stringify(value)) !== grant.policy.selectionHash) throw new Error("Sharing settings changed.");
    requireFinanceSession(context);
    return value;
  },
  async refresh(context: FinanceShareContext, grant: FinanceGrant, projection: FinanceProjection) {
    if (grant.status !== "active" || grant.policy.mode !== "ongoing" || grant.ownerUserId !== context.userId) return;
    const proposed = readFinanceProjection(projection, grant.policy);
    const previous = await FinanceSharingService.decrypt(context, grant);
    if (JSON.stringify(financeInformation(previous)) === JSON.stringify(financeInformation(proposed))) return;
    const exact = committedFinanceProjection(proposed, grant.policy);
    const contentHash = await financeDigest(JSON.stringify(exact));
    const [recipient] = await currentRecipients(context, [grant.recipientPersonRef]);
    if (!recipient || recipient.keyId !== grant.recipientKeyId) throw new Error("Recipient access changed.");
    const sender = await bootstrapCurrentUserLocationRecipientKey({ ...context, strictRecovery: true });
    requireFinanceSession(context);
    const aad = financeContext({ ...grant, revision: grant.revision + 1 });
    const envelope = await seal(context, exact, aad, recipient);
    const ownerEnvelope = await seal(context, exact, aad, sender);
    return request<{ revision: number }>(context, `/${encodeURIComponent(grant.id)}`, "PUT", { expectedRevision: grant.revision, contentHash, envelope, ownerEnvelope });
  },
  async review(context: FinanceShareContext, grant: FinanceGrant, projection: FinanceProjection, signal: AbortSignal) {
    requireFinanceSession(context);
    const current = await FinanceSharingService.view(context, grant.id);
    if (current.direction !== "received" || current.status !== "active" || !current.policy.model_processing.allowed
      || current.revision !== grant.revision || current.contentHash !== grant.contentHash) throw new Error("Open the current shared view to check private-agent permission.");
    const projectionText = JSON.stringify(readFinanceProjection(projection, current.policy));
    if (await financeDigest(projectionText) !== current.contentHash) throw new Error("Shared information changed.");
    requireFinanceSession(context); signal.throwIfAborted();
    const { streamAgentChat } = await import("@/lib/services/agent-chat-client");
    const result = await streamAgentChat({ userId: context.userId, message: "Review shared Finance", vaultOwnerToken: context.vaultOwnerToken, vaultKey: context.vaultKey,
      specialistFocus: "finance", financeShare: { grantId: current.id, revision: current.revision, projectionText }, signal });
    requireFinanceSession(context); signal.throwIfAborted();
    const after = await FinanceSharingService.view(context, current.id);
    if (after.status !== "active" || after.revision !== current.revision || !after.policy.model_processing.allowed) throw new Error("Access changed during review.");
    if (result.interrupted || result.detached || !result.text) throw new Error("The review did not finish. Please try again.");
    return result.text;
  },
};
