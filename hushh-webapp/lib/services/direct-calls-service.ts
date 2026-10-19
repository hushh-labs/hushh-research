import { apiJson } from "@/lib/services/api-client";
import { ApiService } from "@/lib/services/api-service";
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
  constructor(readonly userId: string, private readonly getToken: () => Promise<string>) {}

  private async options(): Promise<RequestInit> {
    return { cache: "no-store", headers: { Authorization: `Bearer ${await this.getToken()}`, "Content-Type": "application/json" } };
  }

  capabilities = async (): Promise<CallCapabilities> => apiJson(`${root}/capabilities`, await this.options());

  async initialize(): Promise<CallIdentity> {
    const hub = async (path: string, init: RequestInit) => ApiService.apiFetch(path, { ...init,
      headers: { ...init.headers, Authorization: `Bearer ${await this.getToken()}` }, cache: "no-store" });
    const identity = await communicationIdentity(this.userId, { hub, direct: hub });
    await this.command("register-key", { keyId: identity.keyId, publicKey: identity.publicKey });
    this.identity = identity;
    return identity;
  }

  async command<T>(operation: string, payload: Record<string, unknown>): Promise<T> {
    const proof = await signCommunicationCommand(this.userId, operation, payload);
    return apiJson(`${root}/${operation}`, { ...await this.options(), method: "POST", body: JSON.stringify({ payload, proof }) });
  }

  async devices(conversationId: string): Promise<{ items: CommunicationDevice[]; fingerprint: string }> {
    const result = await this.command<{ items: CommunicationDevice[] }>("directory", { conversationId });
    await verifyCommunicationDevices(result.items);
    const identity = this.identity;
    const local = result.items.find(device => device.deviceId === identity?.deviceId);
    if (!identity || !local || local.userId !== this.userId || local.keyId !== identity.keyId
      || local.publicKey !== identity.publicKey || local.signingKey !== identity.signingKey
      || new Set(result.items.map(device => device.userId)).size !== 2) throw new Error("The conversation device identities changed.");
    const sorted = result.items.map(({ userId, deviceId, keyId, publicKey, signingKey }) => ({ userId, deviceId, keyId, publicKey, signingKey }))
      .sort((a, b) => a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);
    return { items: result.items, fingerprint: await digest(sorted) };
  }

  async create(conversationId: string | null, callId: string, recipientPersonRef?: string | null): Promise<DirectCall> {
    const call = await this.command<DirectCall>("create", { callId, ...(conversationId ? { conversationId } : { recipientPersonRef }) });
    dispatchDirectMessagesUpdated({ userId: this.userId,conversationId:call.conversationId,messageId:null,source:"call" });
    return call;
  }
  offer = (callId: string, offers: CallEnvelope[]): Promise<DirectCall> => this.command("offer", { callId, offers });
  read = (callId: string, after = 0): Promise<DirectCallRead> => this.command("read", { callId, after });
  inbox = (): Promise<{ items: DirectCall[] }> => this.command("inbox", {});
  relay = (callId: string): Promise<CallRelay> => this.command("credentials", { callId });
  signal = (callId: string, envelope: CallEnvelope): Promise<{ accepted: boolean }> => this.command("signal", { callId, sequence: 1, envelope });
  action = (call: DirectCall, action: "accept" | "connected" | "decline" | "cancel" | "end"): Promise<DirectCall> =>
    this.command("action", { callId: call.id, action, revision: call.revision });
}
