/** Media lifetime owner. A late permission result can never restart a stopped call. */
import { appInteractionCoordinator, type VoiceSessionLease } from "@/lib/interaction/interaction-intent-coordinator";

export class CallMedia {
  private generation = 0;
  private stream: MediaStream | null = null;
  private peer: RTCPeerConnection | null = null;
  private audio: HTMLAudioElement | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private lease: VoiceSessionLease | null = null;

  constructor(private readonly ports = {
    capture: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }),
    connect: (configuration: RTCConfiguration) => new RTCPeerConnection(configuration),
    audio: () => new Audio(),
  }) {}

  async open(configuration: RTCConfiguration, onConnected: () => void, onEnded: () => void): Promise<RTCPeerConnection> {
    this.stop();
    if (configuration.iceTransportPolicy !== "relay" || !configuration.iceServers?.length) throw new Error("A verified calling relay is required.");
    const generation = this.generation;
    this.lease = appInteractionCoordinator.acquireVoiceLease({ owner: "direct-message-call", onRevoked: () => {
      if (generation === this.generation) { this.stop(); onEnded(); }
    } });
    let stream: MediaStream;
    try { stream = await this.ports.capture(); }
    catch (error) { if (generation === this.generation) this.stop(); throw error; }
    if (generation !== this.generation) {
      stream.getTracks().forEach(track => track.stop());
      throw new Error("This call was cancelled.");
    }
    try {
      const peer = this.ports.connect(configuration);
      this.stream = stream;
      this.peer = peer;
      this.audio = this.ports.audio();
      this.audio.autoplay = true;
      stream.getTracks().forEach(track => {
        track.onended = () => { if (generation === this.generation) { this.stop(); onEnded(); } };
        peer.addTrack(track, stream);
      });
      peer.ontrack = event => {
        if (generation !== this.generation || !this.audio) return;
        const audio = this.audio;
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio.play().catch(() => {
          if (generation !== this.generation || this.audio !== audio || this.peer !== peer) return;
          this.stop(); onEnded();
        });
      };
      peer.onconnectionstatechange = () => {
        if (generation !== this.generation) return;
        if (peer.connectionState === "connected") {
          if (this.timeout) clearTimeout(this.timeout);
          this.timeout = null;
          onConnected();
        }
        if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
          this.stop(); onEnded();
        }
      };
      this.timeout = setTimeout(() => { this.stop(); onEnded(); }, 90_000);
      return peer;
    } catch (error) {
      stream.getTracks().forEach(track => track.stop());
      this.stop();
      throw error;
    }
  }

  async description(kind: "offer" | "answer"): Promise<RTCSessionDescriptionInit> {
    const peer = this.peer;
    const generation = this.generation;
    if (!peer) throw new Error("The call has ended.");
    await peer.setLocalDescription(kind === "offer" ? await peer.createOffer() : await peer.createAnswer());
    if (peer.iceGatheringState !== "complete") {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", changed); };
        const changed = () => { if (peer.iceGatheringState === "complete") { cleanup(); resolve(); } };
        const timer = setTimeout(() => { cleanup(); reject(new Error("The calling relay could not be reached.")); }, 10_000);
        peer.addEventListener("icegatheringstatechange", changed);
        changed();
      });
    }
    if (generation !== this.generation || !peer.localDescription) throw new Error("The call has ended.");
    const description = peer.localDescription.toJSON();
    if (!description.sdp || !/a=candidate:.* typ relay(?: |\r?$)/im.test(description.sdp)
      || /a=candidate:.* typ (?:host|srflx|prflx)(?: |\r?$)/im.test(description.sdp)) throw new Error("The call could not establish a private relay.");
    return description;
  }

  remote(description: RTCSessionDescriptionInit): Promise<void> {
    if (!this.peer) return Promise.reject(new Error("The call has ended."));
    return this.peer.setRemoteDescription(description);
  }

  mute(muted: boolean): void { this.stream?.getAudioTracks().forEach(track => { track.enabled = !muted; }); }

  stop(): void {
    this.generation += 1;
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
    const peer = this.peer;
    this.peer = null;
    if (peer) { peer.ontrack = null; peer.onconnectionstatechange = null; peer.close(); }
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.stream = null;
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; }
    this.audio = null;
    const lease = this.lease;
    this.lease = null;
    lease?.release("call_ended");
  }
}
