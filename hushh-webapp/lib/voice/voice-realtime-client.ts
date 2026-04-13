"use client";

export type VoiceRealtimeSessionInfo = {
  clientSecret: string;
  model: string;
  voice: string;
  sessionId?: string | null;
};

type VoiceRealtimeEventPayload = Record<string, unknown>;

export type VoiceRealtimeTranscriptEvent = {
  kind: "partial" | "final";
  text: string;
  itemId?: string | null;
};

type VoiceRealtimeConnectInput = {
  session: VoiceRealtimeSessionInfo;
  localStream?: MediaStream;
  turnId?: string;
  signal?: AbortSignal;
  serverVadSilenceMs?: number;
  disableAutoResponse?: boolean;
  enableBargeIn?: boolean;
  onTranscript?: (event: VoiceRealtimeTranscriptEvent) => void;
  onDebug?: (event: string, payload?: VoiceRealtimeEventPayload) => void;
  onSpeechBoundary?: (event: "speech_started" | "speech_stopped") => void;
};

type VoiceRealtimeSpeechInput = {
  text: string;
  voice?: string;
  timeoutMs?: number;
  turnId: string;
  responseId: string;
  segmentType: "ack" | "final";
  onFirstAudio?: () => void;
  onPlaybackStarted?: () => void;
  onPlaybackEnded?: () => void;
};

type PendingSpeechState = {
  timeoutHandle: number;
  started: boolean;
  firstAudio: boolean;
  responseDone: boolean;
  turnId: string;
  responseId: string;
  segmentType: "ack" | "final";
  onFirstAudio?: () => void;
  onPlaybackStarted?: () => void;
  onPlaybackEnded?: () => void;
  resolve: () => void;
  reject: (error: Error) => void;
};

const DEFAULT_SPEECH_TIMEOUT_MS = 30000;
const DEFAULT_FINAL_TRANSCRIPT_TIMEOUT_MS = 25000;
const DEFAULT_REALTIME_SDP_TIMEOUT_MS = 15000;
const DEFAULT_SERVER_VAD_THRESHOLD = 0.72;
const DEFAULT_SERVER_VAD_PREFIX_PADDING_MS = 450;

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeTranscriptEvent(payload: Record<string, unknown>): VoiceRealtimeTranscriptEvent | null {
  const eventType = String(payload.type || "").trim();
  if (!eventType) return null;

  const itemId = typeof payload.item_id === "string" ? payload.item_id : null;
  if (
    eventType === "conversation.item.input_audio_transcription.delta" ||
    eventType === "input_audio_transcription.delta"
  ) {
    const delta = typeof payload.delta === "string" ? payload.delta : "";
    if (!delta.trim()) return null;
    return {
      kind: "partial",
      text: delta,
      itemId,
    };
  }
  if (eventType === "conversation.item.input_audio_transcription.segment") {
    const segment =
      typeof payload.transcript === "string"
        ? payload.transcript
        : typeof payload.text === "string"
          ? payload.text
          : "";
    if (!segment.trim()) return null;
    return {
      kind: "partial",
      text: segment,
      itemId,
    };
  }
  if (
    eventType === "conversation.item.input_audio_transcription.completed" ||
    eventType === "input_audio_transcription.completed"
  ) {
    const transcript = typeof payload.transcript === "string" ? payload.transcript : "";
    if (!transcript.trim()) return null;
    return {
      kind: "final",
      text: transcript,
      itemId,
    };
  }
  return null;
}

function parseResponseId(payload: Record<string, unknown>): string | null {
  if (typeof payload.response_id === "string" && payload.response_id.trim()) {
    return payload.response_id.trim();
  }
  const metadataObject = asObject(payload.metadata);
  if (
    metadataObject &&
    typeof metadataObject.response_id === "string" &&
    metadataObject.response_id.trim()
  ) {
    return metadataObject.response_id.trim();
  }
  const responseObject = asObject(payload.response);
  if (responseObject) {
    const responseMetadata = asObject(responseObject.metadata);
    if (
      responseMetadata &&
      typeof responseMetadata.response_id === "string" &&
      responseMetadata.response_id.trim()
    ) {
      return responseMetadata.response_id.trim();
    }
  }
  if (responseObject && typeof responseObject.id === "string" && responseObject.id.trim()) {
    return responseObject.id.trim();
  }
  return null;
}

export class VoiceRealtimeClient {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private localStream: MediaStream | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private onTranscript?: (event: VoiceRealtimeTranscriptEvent) => void;
  private onDebug?: (event: string, payload?: VoiceRealtimeEventPayload) => void;
  private onSpeechBoundary?: (event: "speech_started" | "speech_stopped") => void;
  private latestFinalTranscript = "";
  private finalTranscriptWaiters: Array<{
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    timeoutHandle: number;
  }> = [];
  private pendingSpeech: PendingSpeechState | null = null;
  private isConnected = false;
  private remoteAudioPlaybackError: Error | null = null;

  async connect(input: VoiceRealtimeConnectInput): Promise<MediaStream> {
    if (input.signal?.aborted) {
      throw new Error("VOICE_SESSION_CONNECT_ABORTED");
    }
    await this.close();
    this.onTranscript = input.onTranscript;
    this.onDebug = input.onDebug;
    this.onSpeechBoundary = input.onSpeechBoundary;

    const stream =
      input.localStream || (await navigator.mediaDevices.getUserMedia({ audio: true }));
    this.localStream = stream;

    const pc = new RTCPeerConnection();
    this.peerConnection = pc;
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    this.remoteAudio = new Audio();
    this.remoteAudio.autoplay = true;
    this.remoteAudio.onplay = () => {
      const pending = this.pendingSpeech;
      if (!pending || pending.started) return;
      pending.started = true;
      pending.onPlaybackStarted?.();
      if (pending.responseDone) {
        pending.onPlaybackEnded?.();
        pending.resolve();
      }
    };

    pc.ontrack = (event: RTCTrackEvent) => {
      if (!this.remoteAudio) return;
      this.remoteAudio.srcObject = event.streams[0] || new MediaStream([event.track]);
      this.remoteAudioPlaybackError = null;
      const playResult = this.remoteAudio.play();
      if (!playResult) return;
      void playResult.catch((error: unknown) => {
        const playbackError =
          error instanceof Error ? error : new Error("VOICE_STREAM_TTS_PLAYBACK_FAILED");
        this.remoteAudioPlaybackError = playbackError;
        this.pendingSpeech?.reject(playbackError);
      });
    };

    const channel = pc.createDataChannel("oai-events");
    this.dataChannel = channel;
    channel.onmessage = (event: MessageEvent<string>) => this.handleDataMessage(event.data);
    channel.onerror = () => {
      this.onDebug?.("data_channel_error", {
        ready_state: channel.readyState,
      });
    };
    channel.onclose = () => {
      this.isConnected = false;
      this.onDebug?.("data_channel_closed", {
        ready_state: channel.readyState,
      });
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "failed" || state === "closed" || state === "disconnected") {
        this.isConnected = false;
      }
      this.onDebug?.("peer_connection_state_changed", {
        connection_state: state,
      });
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (!offer.sdp) {
      throw new Error("Realtime SDP offer missing");
    }

    const realtimeUrl = `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(input.session.model)}`;
    let realtimeFetchTimedOut = false;
    const realtimeFetchAbortController = new AbortController();
    const forwardAbort = () => {
      if (!realtimeFetchAbortController.signal.aborted) {
        realtimeFetchAbortController.abort();
      }
    };
    const timeoutHandle = window.setTimeout(() => {
      realtimeFetchTimedOut = true;
      forwardAbort();
    }, DEFAULT_REALTIME_SDP_TIMEOUT_MS);
    input.signal?.addEventListener("abort", forwardAbort, { once: true });

    let response: Response;
    try {
      response = await globalThis.fetch(realtimeUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.session.clientSecret}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
        signal: realtimeFetchAbortController.signal,
      });
    } catch (error) {
      if (input.signal?.aborted) {
        throw new Error("VOICE_SESSION_CONNECT_ABORTED");
      }
      if (realtimeFetchTimedOut) {
        throw new Error("VOICE_REALTIME_SDP_TIMEOUT");
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutHandle);
      input.signal?.removeEventListener("abort", forwardAbort);
    }
    if (input.signal?.aborted) {
      throw new Error("VOICE_SESSION_CONNECT_ABORTED");
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(detail || `Realtime SDP exchange failed (${response.status})`);
    }

    const answerSdp = await response.text();
    await pc.setRemoteDescription({
      type: "answer",
      sdp: answerSdp,
    });
    if (input.signal?.aborted) {
      throw new Error("VOICE_SESSION_CONNECT_ABORTED");
    }

    await this.waitForDataChannelOpen(channel, 10000, input.signal);
    this.isConnected = true;
    this.onDebug?.("stream_session_start", {
      turn_id: input.turnId || null,
      model: input.session.model,
      voice: input.session.voice,
      session_id: input.session.sessionId || null,
    });

    this.configureServerVAD({
      silenceDurationMs:
        typeof input.serverVadSilenceMs === "number" && Number.isFinite(input.serverVadSilenceMs)
          ? Math.max(300, Math.round(input.serverVadSilenceMs))
          : 800,
      disableAutoResponse: input.disableAutoResponse !== false,
      enableBargeIn: input.enableBargeIn !== false,
      model: input.session.model,
      voice: input.session.voice,
    });

    return stream;
  }

  private configureServerVAD(input: {
    silenceDurationMs: number;
    disableAutoResponse: boolean;
    enableBargeIn: boolean;
    model: string;
    voice: string;
  }): void {
    try {
      this.sendEvent({
        type: "session.update",
        session: {
          type: "realtime",
          model: input.model,
          audio: {
            input: {
              turn_detection: {
                type: "server_vad",
                threshold: DEFAULT_SERVER_VAD_THRESHOLD,
                prefix_padding_ms: DEFAULT_SERVER_VAD_PREFIX_PADDING_MS,
                silence_duration_ms: input.silenceDurationMs,
                create_response: input.disableAutoResponse ? false : true,
                interrupt_response: input.enableBargeIn ? true : false,
              },
            },
            output: {
              voice: input.voice || "alloy",
            },
          },
        },
      });
      this.onDebug?.("session_update_sent", {
        threshold: DEFAULT_SERVER_VAD_THRESHOLD,
        prefix_padding_ms: DEFAULT_SERVER_VAD_PREFIX_PADDING_MS,
        silence_duration_ms: input.silenceDurationMs,
        create_response: input.disableAutoResponse ? false : true,
        interrupt_response: input.enableBargeIn ? true : false,
      });
    } catch (error) {
      this.onDebug?.("session_update_failed", {
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  getStream(): MediaStream | null {
    return this.localStream;
  }

  connected(): boolean {
    const channelOpen = Boolean(this.dataChannel && this.dataChannel.readyState === "open");
    const pcState = this.peerConnection?.connectionState || "new";
    const pcUsable = pcState !== "failed" && pcState !== "closed" && pcState !== "disconnected";
    return Boolean(this.isConnected && channelOpen && pcUsable);
  }

  commitInputAudio(): void {
    this.sendEvent({
      type: "input_audio_buffer.commit",
    });
  }

  waitForFinalTranscript(timeoutMs: number = DEFAULT_FINAL_TRANSCRIPT_TIMEOUT_MS): Promise<string> {
    if (this.latestFinalTranscript.trim()) {
      const text = this.latestFinalTranscript.trim();
      this.latestFinalTranscript = "";
      return Promise.resolve(text);
    }
    return new Promise<string>((resolve, reject) => {
      const timeoutHandle = window.setTimeout(() => {
        this.finalTranscriptWaiters = this.finalTranscriptWaiters.filter((entry) => entry.reject !== reject);
        reject(new Error("VOICE_STREAM_FINAL_TRANSCRIPT_TIMEOUT"));
      }, timeoutMs);
      this.finalTranscriptWaiters.push({ resolve, reject, timeoutHandle });
    });
  }

  async requestSpeech(input: VoiceRealtimeSpeechInput): Promise<void> {
    if (!this.connected()) {
      throw new Error("Realtime session is not connected");
    }

    const cleanText = String(input.text || "").trim();
    if (!cleanText) return;

    if (!input.turnId || !input.responseId) {
      throw new Error("VOICE_STREAM_TTS_CORRELATION_REQUIRED");
    }

    if (this.pendingSpeech) {
      this.cancelSpeech("VOICE_STREAM_TTS_INTERRUPTED");
    }

    await new Promise<void>((resolve, reject) => {
      const timeoutMs =
        typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
          ? Math.round(input.timeoutMs)
          : DEFAULT_SPEECH_TIMEOUT_MS;
      const timeoutHandle = window.setTimeout(() => {
        this.pendingSpeech = null;
        reject(new Error("VOICE_STREAM_TTS_TIMEOUT"));
      }, timeoutMs);
      this.pendingSpeech = {
        timeoutHandle,
        started: false,
        firstAudio: false,
        responseDone: false,
        turnId: input.turnId,
        responseId: input.responseId,
        segmentType: input.segmentType,
        onFirstAudio: input.onFirstAudio,
        onPlaybackStarted: input.onPlaybackStarted,
        onPlaybackEnded: input.onPlaybackEnded,
        resolve: () => {
          window.clearTimeout(timeoutHandle);
          this.pendingSpeech = null;
          resolve();
        },
        reject: (error: Error) => {
          window.clearTimeout(timeoutHandle);
          this.pendingSpeech = null;
          reject(error);
        },
      };

      this.sendEvent({
        type: "response.create",
        response: {
          output_modalities: ["audio"],
          instructions: cleanText,
          audio: {
            output: {
              voice: input.voice || "alloy",
            },
          },
          metadata: {
            turn_id: input.turnId,
            response_id: input.responseId,
            segment_type: input.segmentType,
          },
        },
      });
      this.onDebug?.("stream_tts_requested", {
        turn_id: input.turnId,
        response_id: input.responseId,
        segment_type: input.segmentType,
      });
    });
  }

  cancelSpeech(reason: string = "VOICE_STREAM_TTS_CANCELLED"): void {
    const pending = this.pendingSpeech;
    const hasCancelablePendingResponse = Boolean(
      pending &&
        !pending.responseDone &&
        this.dataChannel &&
        this.dataChannel.readyState === "open"
    );
    if (hasCancelablePendingResponse) {
      try {
        this.sendEvent({ type: "response.cancel" });
      } catch {
        // Ignore cancel attempts during teardown when the data channel is racing closed.
      }
    }
    if (!pending) return;
    this.pendingSpeech = null;
    window.clearTimeout(pending.timeoutHandle);
    pending.reject(new Error(reason));
  }

  async close(options?: { stopLocalStream?: boolean }): Promise<void> {
    this.isConnected = false;
    this.cancelSpeech("VOICE_STREAM_SESSION_CLOSED");

    this.finalTranscriptWaiters.forEach((waiter) => {
      window.clearTimeout(waiter.timeoutHandle);
      waiter.reject(new Error("VOICE_STREAM_SESSION_CLOSED"));
    });
    this.finalTranscriptWaiters = [];
    this.latestFinalTranscript = "";

    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch {
        // noop
      }
      this.dataChannel = null;
    }
    if (this.peerConnection) {
      try {
        this.peerConnection.close();
      } catch {
        // noop
      }
      this.peerConnection = null;
    }
    if (this.remoteAudio) {
      this.remoteAudio.pause();
      this.remoteAudio.srcObject = null;
      this.remoteAudio.onplay = null;
      this.remoteAudio = null;
    }
    this.remoteAudioPlaybackError = null;
    if (this.localStream && options?.stopLocalStream !== false) {
      this.localStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // noop
        }
      });
    }
    if (this.localStream) {
      this.localStream = null;
    }
  }

  private waitForDataChannelOpen(
    channel: RTCDataChannel,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    if (channel.readyState === "open") return Promise.resolve();
    if (signal?.aborted) {
      return Promise.reject(new Error("VOICE_SESSION_CONNECT_ABORTED"));
    }
    return new Promise<void>((resolve, reject) => {
      const timeoutHandle = window.setTimeout(() => {
        cleanup();
        reject(new Error("VOICE_STREAM_DATA_CHANNEL_TIMEOUT"));
      }, timeoutMs);
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error("VOICE_STREAM_DATA_CHANNEL_ERROR"));
      };
      const handleClose = () => {
        cleanup();
        reject(new Error("VOICE_STREAM_DATA_CHANNEL_CLOSED_BEFORE_OPEN"));
      };
      const handleAbort = () => {
        cleanup();
        reject(new Error("VOICE_SESSION_CONNECT_ABORTED"));
      };
      const cleanup = () => {
        window.clearTimeout(timeoutHandle);
        channel.removeEventListener("open", handleOpen);
        channel.removeEventListener("error", handleError);
        channel.removeEventListener("close", handleClose);
        signal?.removeEventListener("abort", handleAbort);
      };
      channel.addEventListener("open", handleOpen);
      channel.addEventListener("error", handleError);
      channel.addEventListener("close", handleClose);
      signal?.addEventListener("abort", handleAbort, { once: true });
    });
  }

  private sendEvent(payload: Record<string, unknown>): void {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      throw new Error("Realtime data channel is not open");
    }
    this.dataChannel.send(JSON.stringify(payload));
  }

  private shouldAcceptPendingSpeechEvent(payload: Record<string, unknown>): boolean {
    const pending = this.pendingSpeech;
    if (!pending) return false;

    const responseId = parseResponseId(payload);
    if (!responseId) {
      // If the event has no correlation id, treat as unsolicited to prevent cross-turn speech bleed.
      this.onDebug?.("stream_tts_event_dropped_missing_response_id", {
        expected_response_id: pending.responseId,
        event_type: payload.type,
      });
      return false;
    }

    if (responseId !== pending.responseId) {
      this.onDebug?.("stream_tts_event_dropped_response_mismatch", {
        expected_response_id: pending.responseId,
        observed_response_id: responseId,
        event_type: payload.type,
      });
      return false;
    }

    return true;
  }

  private maybeDropUnsolicitedAssistantEvent(payload: Record<string, unknown>): boolean {
    const eventType = String(payload.type || "").trim();
    if (!eventType.startsWith("response.")) return false;

    if (this.pendingSpeech) {
      return false;
    }

    const responseId = parseResponseId(payload);
    if (!responseId) {
      return false;
    }

    if (
      eventType === "response.created" ||
      eventType === "response.audio.delta" ||
      eventType === "response.done"
    ) {
      this.onDebug?.("stream_unsolicited_response_dropped", {
        event_type: eventType,
        response_id: responseId,
      });
      if (eventType !== "response.done") {
        try {
          this.sendEvent({ type: "response.cancel" });
        } catch {
          // ignore race when channel is closing
        }
      }
      return true;
    }

    return false;
  }

  private handleDataMessage(raw: string): void {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = asObject(JSON.parse(raw));
    } catch {
      payload = null;
    }
    if (!payload) return;

    const transcriptEvent = normalizeTranscriptEvent(payload);
    if (transcriptEvent) {
      if (transcriptEvent.kind === "final") {
        this.latestFinalTranscript = transcriptEvent.text;
        this.finalTranscriptWaiters.forEach((waiter) => {
          window.clearTimeout(waiter.timeoutHandle);
          waiter.resolve(transcriptEvent.text);
        });
        this.finalTranscriptWaiters = [];
      }
      this.onTranscript?.(transcriptEvent);
      return;
    }

    const eventType = String(payload.type || "").trim();
    if (!eventType) return;

    if (eventType === "input_audio_buffer.speech_started") {
      this.onSpeechBoundary?.("speech_started");
      this.onDebug?.("speech_started", {});
      return;
    }

    if (eventType === "input_audio_buffer.speech_stopped") {
      this.onSpeechBoundary?.("speech_stopped");
      this.onDebug?.("speech_stopped", {});
      return;
    }

    if (this.maybeDropUnsolicitedAssistantEvent(payload)) {
      return;
    }

    if (eventType === "response.audio.delta") {
      const pending = this.pendingSpeech;
      if (!pending) return;
      if (!this.shouldAcceptPendingSpeechEvent(payload)) return;
      if (!pending.firstAudio) {
        pending.firstAudio = true;
        pending.onFirstAudio?.();
      }
      return;
    }

    if (eventType === "response.done") {
      const pending = this.pendingSpeech;
      if (!pending) return;
      if (!this.shouldAcceptPendingSpeechEvent(payload)) return;
      if (this.remoteAudioPlaybackError) {
        pending.reject(this.remoteAudioPlaybackError);
        return;
      }
      pending.responseDone = true;
      if (pending.started) {
        pending.onPlaybackEnded?.();
        pending.resolve();
        return;
      }
      if (this.remoteAudio && !this.remoteAudio.paused) {
        pending.started = true;
        pending.onPlaybackStarted?.();
        pending.onPlaybackEnded?.();
        pending.resolve();
      }
      return;
    }

    if (eventType === "error") {
      const errorObject = asObject(payload.error);
      const message =
        (errorObject && typeof errorObject.message === "string" && errorObject.message) ||
        "Realtime API error";
      const code =
        (errorObject && typeof errorObject.code === "string" && errorObject.code.trim()) || null;
      const errorType =
        (errorObject && typeof errorObject.type === "string" && errorObject.type.trim()) || null;
      const eventId = (typeof payload.event_id === "string" && payload.event_id.trim()) || null;
      const param =
        (errorObject && typeof errorObject.param === "string" && errorObject.param.trim()) || null;
      const pending = this.pendingSpeech;
      if (pending) {
        pending.reject(new Error(message));
      }
      this.onDebug?.("stream_error", {
        message,
        code,
        error_type: errorType,
        event_id: eventId,
        param,
      });
    }
  }
}
