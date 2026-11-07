import { apiJson } from "@/lib/services/api-client";
import { ApiService, type ApiFetchOptions } from "@/lib/services/api-service";
import { AuthService } from "@/lib/services/auth-service";
import { snapshotValidatedAuthSessionPrincipal, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { communicationIdentity, signCommunicationCommand } from "@/lib/services/owner-pod-endpoint";
import { digest, verifyCommunicationDevices, type CallEnvelope, type CallProof, type CommunicationDevice } from "@/lib/direct-messages/call-crypto";
import { dispatchDirectMessagesUpdated } from "@/lib/direct-messages/direct-message-events";

export type DirectCallState = "preparing" | "ringing" | "connecting" | "active" | "declined" | "cancelled" | "ended" | "expired";
export type DirectCall = { id: string; conversationId: string; state: DirectCallState; revision: number; expiresAt: number;
  isCaller: boolean; callerDeviceId: string; calleeDeviceId: string | null; peerDisplayName?: string | null };
export type SignedCallPayload = { payload: Record<string, unknown>; proof: CallProof };
export type DirectCallRead = DirectCall & { offers: CallEnvelope[]; offerProof: SignedCallPayload;
  signals: { sequence: number; senderDeviceId: string; envelope: CallEnvelope; proof: SignedCallPayload }[] };
export type CallIdentity = Awaited<ReturnType<typeof communicationIdentity>>;
export type CallCapabilities = { available: boolean; relayOnly: true; agentParticipation: false; reason: string | null };
export type CallRelay = { iceTransportPolicy: "relay"; iceServers: RTCIceServer[]; expiresAt: number };
const root = "/api/one/messages/calls";

/** Authentication is resolved for each request; never persist an ID/owner token. */
export class DirectCallsService {
  identity: CallIdentity | null = null;
  private readonly principal = snapshotValidatedAuthSessionPrincipal();
  constructor(readonly userId: string, private readonly getToken: () => Promise<string>) {}

  private current = (): boolean => Boolean(this.principal && this.principal.ownerId === this.userId
    && isValidatedAuthSessionOwnerCurrent(this.principal) && AuthService.getCurrentUser()?.uid === this.principal.firebaseUid);

  private assertCurrent = (): void => {
    if (!this.current()) throw new Error("Your sign-in changed. Reopen Messages before calling.");
  };

  private async options(init: ApiFetchOptions = {}): Promise<ApiFetchOptions> {
    this.assertCurrent();
    const token = await this.getToken();
    this.assertCurrent();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Content-Type", "application/json");
    return { ...init, cache: "no-store", isEffectCurrent: this.current, headers };
  }

  private async request<T>(path: string, init: ApiFetchOptions = {}): Promise<T> {
    const result = await apiJson<T>(path, await this.options(init));
    this.assertCurrent();
    return result;
  }

  capabilities = (): Promise<CallCapabilities> => this.request(`${root}/capabilities`);

  async initialize(): Promise<CallIdentity> {
    this.assertCurrent();
    const hub = async (path: string, init: RequestInit) => {
      const response = await ApiService.apiFetch(path, await this.options(init));
      this.assertCurrent();
      return response;
    };
    const identity = await communicationIdentity(this.userId, { hub, direct: hub }, this.assertCurrent);
    this.assertCurrent();
    await this.command("register-key", { keyId: identity.keyId, publicKey: identity.publicKey });
    this.identity = identity;
    return identity;
  }

  async command<T>(operation: string, payload: Record<string, unknown>): Promise<T> {
    this.assertCurrent();
    const proof = await signCommunicationCommand(this.userId, operation, payload, this.assertCurrent);
    this.assertCurrent();
    return this.request(`${root}/${operation}`, { method: "POST", body: JSON.stringify({ payload, proof }) });
  }

  async devices(conversationId: string): Promise<{ items: CommunicationDevice[]; fingerprint: string }> {
    const result = await this.command<{ items: CommunicationDevice[] }>("directory", { conversationId });
    await verifyCommunicationDevices(result.items);
    this.assertCurrent();
    const identity = this.identity;
    const local = result.items.find(device => device.deviceId === identity?.deviceId);
    if (!identity || !local || local.userId !== this.userId || local.keyId !== identity.keyId
      || local.publicKey !== identity.publicKey || local.signingKey !== identity.signingKey
      || new Set(result.items.map(device => device.userId)).size !== 2) throw new Error("The conversation device identities changed.");
    const sorted = result.items.map(({ userId, deviceId, keyId, publicKey, signingKey }) => ({ userId, deviceId, keyId, publicKey, signingKey }))
      .sort((a, b) => a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);
    const fingerprint = await digest(sorted);
    this.assertCurrent();
    return { items: result.items, fingerprint };
  }

  async create(conversationId: string | null, callId: string, recipientPersonRef?: string | null): Promise<DirectCall> {
    const call = await this.command<DirectCall>("create", { callId, ...(conversationId ? { conversationId } : { recipientPersonRef }) });
    dispatchDirectMessagesUpdated({ userId: this.userId,conversationId:call.conversationId,messageId:null,source:"call" });
    return call;
  }
  offer = (callId: string, offers: CallEnvelope[]): Promise<DirectCall> => this.command("offer", { callId, offers });
  read = (callId: string, after = 0): Promise<DirectCallRead> => this.command("read", { callId, after });
  heartbeat = (callId: string): Promise<DirectCall> => this.command("heartbeat", { callId });
  inbox = (): Promise<{ items: DirectCall[] }> => this.command("inbox", {});
  relay = (callId: string): Promise<CallRelay> => this.command("credentials", { callId });
  signal = (callId: string, envelope: CallEnvelope): Promise<{ accepted: boolean }> => this.command("signal", { callId, sequence: 1, envelope });
  action = (call: DirectCall, action: "accept" | "connected" | "decline" | "cancel" | "end"): Promise<DirectCall> =>
    this.command("action", { callId: call.id, action, revision: call.revision });
}
