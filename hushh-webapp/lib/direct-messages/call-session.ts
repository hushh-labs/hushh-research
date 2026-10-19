import { DirectCallsService, type DirectCall, type DirectCallRead } from "@/lib/services/direct-calls-service";
import { CallMedia } from "./call-media";
import { callSignalContext, digest, openCallSignal, sealCallSignal, verifyCallProof, type CommunicationDevice } from "./call-crypto";
import { canonicalJson } from "@/lib/services/owner-pod-crypto";
import { apiErrorCode } from "@/lib/services/api-client";

export type CallView = { call: DirectCall | null; error: string | null; muted: boolean; mediaConnected: boolean };
const finished = new Set(["declined", "cancelled", "ended", "expired"]);
const isHidden = () => document.visibilityState === "hidden";
export type VerifyPeer = (conversationId: string, fingerprint: string) => Promise<boolean>;

/** One foreground browser call; OS-owned native calling is admitted separately. */
export class DirectCallSession {
  private call: DirectCall | null = null;
  private generation = 0;
  private disposed = false;
  private devices: CommunicationDevice[] = [];
  private after = 0;
  private answerApplied = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private muted = false;
  private mediaConnected = false;
  private peerVerified = false;
  private ignored = new Set<string>();
  private answering = false;
  private starting = false;

  constructor(readonly service: DirectCallsService, private readonly publish: (view: CallView) => void,
    private readonly verifyPeer: VerifyPeer, private readonly media = new CallMedia()) {}

  private emit(error: string | null = null): void {
    if (!this.disposed) this.publish({ call: this.call, error, muted: this.muted, mediaConnected: this.mediaConnected });
  }

  private current(generation: number): void {
    if (generation !== this.generation || this.disposed) throw new Error("The call was cancelled.");
  }

  async initialize(): Promise<void> {
    const capabilities = await this.service.capabilities();
    if (!capabilities.available || this.disposed) return;
    await this.service.initialize();
    if (!this.disposed) this.schedule();
  }

  private async loadDevices(conversationId: string, generation: number): Promise<void> {
    const directory = await this.service.devices(conversationId);
    if (generation !== this.generation || this.disposed) throw new Error("The call was cancelled.");
    this.devices = directory.items;
  }

  private async verifyPair(call: DirectCall, peerDevice: string, generation: number): Promise<void> {
    const identity = this.service.identity!;
    const local = this.devices.find(device => device.deviceId === identity.deviceId);
    const peer = this.devices.find(device => device.deviceId === peerDevice);
    if (!local || !peer || peer.userId === this.service.userId) throw new Error("The call participants changed.");
    // Verify the two winning endpoints, not every device claimed by a mutable
    // directory. Each participant anchors their own actual local keypair.
    const pair = [local, peer].map(({ userId, deviceId, keyId, publicKey, signingKey }) => ({ userId, deviceId, keyId, publicKey, signingKey }))
      .sort((a, b) => a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);
    const fingerprint = await digest(pair);
    this.current(generation);
    if (!await this.verifyPeer(call.conversationId, fingerprint)) throw new Error("Compare the security code before calling.");
    this.current(generation);
    this.peerVerified = true;
  }

  private async adopt(call: DirectCall, generation: number): Promise<void> {
    if (generation !== this.generation || this.disposed) {
      await this.service.action(call, "end").catch(() => undefined);
      throw new Error("The call was cancelled.");
    }
    this.call = call;
    this.emit();
  }

  async start(conversationId: string | null, personRef?: string | null): Promise<void> {
    if (this.starting || (this.call && !finished.has(this.call.state))) return;
    this.starting = true;
    const generation = ++this.generation;
    try {
      if (!this.service.identity) await this.service.initialize();
      const call = await this.service.create(conversationId, crypto.randomUUID(),personRef);
      await this.adopt(call, generation);
      await this.loadDevices(call.conversationId, generation);
      const configuration = await this.service.relay(call.id);
      if (generation !== this.generation || this.disposed) throw new Error("The call was cancelled.");
      await this.media.open(configuration, () => void this.connected(), () => void this.end());
      this.current(generation);
      const description = await this.media.description("offer");
      const identity = this.service.identity!;
      const peers = this.devices.filter(device => device.userId !== this.service.userId);
      const offers = await Promise.all(peers.map(device => sealCallSignal(device,
        callSignalContext(call.id, call.conversationId, identity.deviceId, device.deviceId, "offer", 0), description)));
      if (generation !== this.generation || this.disposed) throw new Error("The call was cancelled.");
      await this.adopt(await this.service.offer(call.id, offers), generation);
      this.schedule();
    } catch (error) {
      if (generation === this.generation) await this.fail(error);
    } finally { this.starting = false; }
  }

  async answer(expectedCallId?: string): Promise<void> {
    const call = this.call;
    if (expectedCallId && call?.id !== expectedCallId) return;
    const identity = this.service.identity;
    if (this.answering || !call || call.isCaller || call.state !== "ringing" || !identity) return;
    this.answering = true;
    const generation = ++this.generation;
    try {
      await this.loadDevices(call.conversationId, generation);
      const remote = await this.service.read(call.id);
      const caller = this.devices.find(device => device.deviceId === remote.callerDeviceId);
      if (!caller || caller.userId === this.service.userId) throw new Error("The caller device changed.");
      await verifyCallProof(caller, "offer", remote.offerProof.payload, remote.offerProof.proof);
      const offer = remote.offers[0];
      const signedOffers = remote.offerProof.payload.offers;
      if (!offer || remote.offerProof.payload.callId !== call.id || !Array.isArray(signedOffers)
        || !signedOffers.some(value => canonicalJson(value) === canonicalJson(offer))) throw new Error("The incoming call could not be verified.");
      const description = await openCallSignal(identity, offer,
        callSignalContext(call.id, call.conversationId, caller.deviceId, identity.deviceId, "offer", 0));
      if (description.type !== "offer") throw new Error("Invalid incoming call.");
      this.current(generation);
      await this.adopt(await this.service.action(remote, "accept"), generation);
      await this.verifyPair(this.call!, caller.deviceId, generation);
      const configuration = await this.service.relay(call.id);
      if (generation !== this.generation || this.disposed) throw new Error("The call was cancelled.");
      // Capture begins only after this device wins the authorized answer CAS.
      await this.media.open(configuration, () => void this.connected(), () => void this.end());
      this.current(generation);
      await this.media.remote(description);
      this.current(generation);
      const answer = await this.media.description("answer");
      const envelope = await sealCallSignal(caller, callSignalContext(call.id, call.conversationId,
        identity.deviceId, caller.deviceId, "answer", 1), answer);
      if (generation !== this.generation || this.disposed) throw new Error("The call was cancelled.");
      await this.service.signal(call.id, envelope);
      this.schedule();
    } catch (error) {
      if (generation === this.generation) await this.fail(error);
    } finally { this.answering = false; }
  }

  private async connected(): Promise<void> {
    const call = this.call;
    const generation = this.generation;
    if (!call || this.disposed) return;
    this.mediaConnected = true;
    this.emit();
    try {
      // Both endpoints can report transport connection against the same CAS.
      // Re-read once for that specific race; other failures still tear down.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const latest = await this.service.read(call.id);
        this.current(generation);
        try {
          const updated = await this.service.action(latest, "connected");
          this.current(generation);
          if (!this.call || updated.revision >= this.call.revision) this.call = updated;
          this.emit();
          return;
        } catch (error) {
          this.current(generation);
          if (attempt !== 0 || apiErrorCode(error) !== "CALL_CHANGED") throw error;
        }
      }
    } catch (error) { if (generation === this.generation) await this.fail(error); }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.disposed) this.timer = setTimeout(() => void this.poll(), 2000);
  }

  private async poll(): Promise<void> {
    if (this.disposed || !this.service.identity) return;
    if (isHidden()) { this.schedule(); return; }
    const generation = this.generation;
    try {
      if (!this.call || finished.has(this.call.state)) {
        const inbox = await this.service.inbox();
        if (generation !== this.generation || this.disposed) return;
        if (inbox.items[0] && !this.ignored.has(inbox.items[0].id) && !isHidden()) {
          this.call = inbox.items[0]; this.emit();
        }
      } else {
        const call = await this.service.read(this.call.id, this.after);
        if (generation !== this.generation || this.disposed) return;
        if (!this.call || call.revision >= this.call.revision) this.call = call;
        if (finished.has(call.state) || Date.now() / 1000 >= call.expiresAt) { await this.end(); return; }
        if (call.isCaller && !this.answerApplied && call.calleeDeviceId) await this.applyAnswer(call, generation);
        this.current(generation);
        this.emit();
      }
    } catch (error) {
      if (generation === this.generation && this.call && !finished.has(this.call.state)) await this.fail(error);
    } finally { this.schedule(); }
  }

  private async applyAnswer(call: DirectCallRead, generation: number): Promise<void> {
    const identity = this.service.identity!;
    const peer = this.devices.find(device => device.deviceId === call.calleeDeviceId);
    if (!peer || peer.userId === this.service.userId) throw new Error("The answering device changed.");
    if (!this.peerVerified) await this.verifyPair(call, peer.deviceId, generation);
    const signal = call.signals[0];
    if (!signal) return;
    if (signal.senderDeviceId !== peer.deviceId || signal.proof.payload.callId !== call.id
      || signal.proof.payload.sequence !== 1 || canonicalJson(signal.proof.payload.envelope) !== canonicalJson(signal.envelope)) throw new Error("The answer could not be verified.");
    await verifyCallProof(peer, "signal", signal.proof.payload, signal.proof.proof);
    const description = await openCallSignal(identity, signal.envelope,
      callSignalContext(call.id, call.conversationId, peer.deviceId, identity.deviceId, "answer", 1));
    if (description.type !== "answer") throw new Error("Invalid call answer.");
    this.current(generation);
    await this.media.remote(description);
    this.current(generation);
    this.answerApplied = true;
    this.after = signal.sequence;
  }

  async end(decline = false, expectedCallId?: string): Promise<void> {
    const call = this.call;
    if (expectedCallId && call?.id !== expectedCallId) return;
    this.generation += 1;
    const generation = this.generation;
    this.media.stop();
    this.mediaConnected = false;
    this.muted = false;
    this.after = 0;
    this.answerApplied = false;
    this.peerVerified = false;
    this.devices = [];
    this.call = null;
    this.emit();
    if (call && !finished.has(call.state)) {
      this.ignored.add(call.id);
      if (this.ignored.size > 20) this.ignored.delete(this.ignored.values().next().value!);
      const action = decline && !call.isCaller && call.state === "ringing" ? "decline"
        : call.isCaller && ["preparing", "ringing"].includes(call.state) ? "cancel" : "end";
      try {
        try { await this.service.action(call, action); }
        catch (error) {
          if (action === "end") throw error;
          // Cleanup remains authorized after a state or relationship change.
          await this.service.action(call, "end");
        }
      }
      catch { if (generation === this.generation) this.emit("The call ended on this device. Server cleanup is pending."); }
    }
  }

  private async fail(error: unknown): Promise<void> {
    const expected = this.generation + 1;
    await this.end();
    if (expected === this.generation) this.emit(error instanceof Error ? error.message : "The call could not connect.");
  }

  mute(expectedCallId?: string): void {
    if (expectedCallId && this.call?.id !== expectedCallId) return;
    this.muted = !this.muted; this.media.mute(this.muted); this.emit();
  }
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.end();
  }
}
