import { ApiService } from "@/lib/services/api-service";

type AgentRealtimeSessionResponse = {
  session_id?: string | null;
  client_secret: string;
  client_secret_expires_at?: number | null;
  model: string;
  voice: string;
  transcription_model: string;
  transcription_language: string;
  transcription_prompt: string;
  server_vad_enabled: boolean;
  silence_duration_ms: number;
};

type AgentRealtimeConnectInput = {
  userId: string;
  vaultOwnerToken: string;
};

type AgentRealtimeTextHandlers = {
  onDelta: (delta: string) => void;
  onDone: (text: string) => void;
  onError: (message: string) => void;
};

export type AgentRealtimeVoiceState =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking";

type AgentRealtimeVoiceHandlers = {
  onInputTranscriptDelta: (delta: string) => void;
  onInputTranscriptDone: (text: string) => void;
  onResponseStart: () => void;
  onResponseDelta: (delta: string) => void;
  onResponseDone: (text: string) => void;
  onVoiceState: (state: AgentRealtimeVoiceState) => void;
  onError: (message: string) => void;
};

type ActiveTextStream = {
  text: string;
  finalText: string | null;
  handlers: AgentRealtimeTextHandlers;
};

type ActiveVoiceResponse = {
  text: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractErrorMessage(payload: unknown): string {
  const record = asRecord(payload);
  if (!record) return "Realtime request failed.";
  const error = record.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  const errorRecord = asRecord(error);
  if (errorRecord) {
    const message = errorRecord.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  const detail = record.detail;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  return "Realtime request failed.";
}

function extractSdpError(text: string, status: number): string {
  try {
    return extractErrorMessage(JSON.parse(text));
  } catch {
    return text || `Realtime SDP exchange failed (${status}).`;
  }
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

async function createRealtimeSession(
  input: AgentRealtimeConnectInput
): Promise<AgentRealtimeSessionResponse> {
  const response = await ApiService.apiFetch("/api/kai/agent/realtime/session", {
    method: "POST",
    headers: ApiService.getAuthHeaders(input.vaultOwnerToken),
    body: JSON.stringify({ user_id: input.userId }),
  });
  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload));
  }

  const session = payload as Partial<AgentRealtimeSessionResponse>;
  if (!session.client_secret || !session.model) {
    throw new Error("Realtime session payload was incomplete.");
  }
  return {
    session_id: session.session_id ?? null,
    client_secret: session.client_secret,
    client_secret_expires_at: session.client_secret_expires_at ?? null,
    model: session.model,
    voice: session.voice || "alloy",
    transcription_model: session.transcription_model || "gpt-4o-mini-transcribe",
    transcription_language: session.transcription_language || "en",
    transcription_prompt: session.transcription_prompt || "",
    server_vad_enabled: session.server_vad_enabled !== false,
    silence_duration_ms: session.silence_duration_ms || 800,
  };
}

function extractFinalText(response: unknown): string {
  const responseRecord = asRecord(response);
  if (!responseRecord) return "";
  const output = responseRecord.output;
  if (!Array.isArray(output)) return "";

  return output
    .flatMap((item) => {
      const itemRecord = asRecord(item);
      if (!itemRecord) return [];
      const content = itemRecord.content;
      if (!Array.isArray(content)) return [];
      return content.flatMap((part) => {
        const partRecord = asRecord(part);
        if (!partRecord) return [];
        const text =
          partRecord.text ||
          partRecord.transcript ||
          partRecord.audio_transcript;
        return typeof text === "string" ? [text] : [];
      });
    })
    .join("");
}

function readText(payload: Record<string, unknown>): string {
  const delta = payload.delta;
  if (typeof delta === "string") return delta;
  const text = payload.text;
  if (typeof text === "string") return text;
  const transcript = payload.transcript;
  return typeof transcript === "string" ? transcript : "";
}

function isInputTranscriptDelta(type: string): boolean {
  return (
    type === "conversation.item.input_audio_transcription.delta" ||
    type === "input_audio_transcription.delta" ||
    type === "conversation.item.input_audio_transcription.segment"
  );
}

function isInputTranscriptDone(type: string): boolean {
  return (
    type === "conversation.item.input_audio_transcription.completed" ||
    type === "input_audio_transcription.completed"
  );
}

function isAssistantTextDelta(type: string): boolean {
  return type === "response.output_text.delta" || type === "response.text.delta";
}

function isAssistantTextDone(type: string): boolean {
  return type === "response.output_text.done" || type === "response.text.done";
}

function isAssistantAudioTranscriptDelta(type: string): boolean {
  return (
    type === "response.audio_transcript.delta" ||
    type === "response.output_audio_transcript.delta"
  );
}

function isAssistantAudioTranscriptDone(type: string): boolean {
  return (
    type === "response.audio_transcript.done" ||
    type === "response.output_audio_transcript.done"
  );
}

export class AgentRealtimeClient {
  private session: AgentRealtimeSessionResponse | null = null;
  private peerConnection: RTCPeerConnection | null = null;
  private audioTransceiver: RTCRtpTransceiver | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private localStream: MediaStream | null = null;
  private connectPromise: Promise<void> | null = null;
  private activeTextStream: ActiveTextStream | null = null;
  private activeVoiceResponse: ActiveVoiceResponse | null = null;
  private voiceHandlers: AgentRealtimeVoiceHandlers | null = null;
  private pendingVoiceResponse = false;
  private speechDetected = false;
  private currentInputTranscript = "";
  private closed = false;

  async connect(input: AgentRealtimeConnectInput): Promise<void> {
    if (typeof window === "undefined" || typeof RTCPeerConnection === "undefined") {
      throw new Error("Realtime WebRTC is not available in this browser.");
    }
    if (this.dataChannel?.readyState === "open") return;
    if (this.connectPromise) return this.connectPromise;

    this.closed = false;
    this.connectPromise = this.openConnection(input)
      .catch((error) => {
        this.close();
        throw error;
      })
      .finally(() => {
        this.connectPromise = null;
      });
    return this.connectPromise;
  }

  async sendText(text: string, handlers: AgentRealtimeTextHandlers): Promise<void> {
    if (this.activeTextStream || this.activeVoiceResponse) {
      throw new Error("Agent is still finishing the previous response.");
    }
    this.ensureDataChannel();

    this.activeTextStream = {
      text: "",
      finalText: null,
      handlers,
    };

    this.sendJson({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.sendJson({
      type: "response.create",
      response: {
        output_modalities: ["text"],
      },
    });
  }

  async startMicrophone(handlers: AgentRealtimeVoiceHandlers): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone access is not available in this browser.");
    }
    if (!this.session) {
      throw new Error("Realtime session is not connected.");
    }

    this.ensureDataChannel();
    this.voiceHandlers = handlers;
    this.voiceHandlers.onVoiceState("connecting");
    this.configureVoiceInput();

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach((streamTrack) => streamTrack.stop());
      throw new Error("No microphone audio track was available.");
    }

    this.localStream?.getTracks().forEach((streamTrack) => streamTrack.stop());
    this.localStream = stream;
    await this.audioTransceiver?.sender.replaceTrack(track);
    this.speechDetected = false;
    this.currentInputTranscript = "";
    this.voiceHandlers.onVoiceState("listening");
  }

  async stopMicrophone(): Promise<void> {
    await this.audioTransceiver?.sender.replaceTrack(null);
    const hadSpeech = this.speechDetected || Boolean(this.currentInputTranscript.trim());
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;

    if (hadSpeech && !this.pendingVoiceResponse && !this.activeVoiceResponse) {
      this.voiceHandlers?.onVoiceState("thinking");
      try {
        this.sendJson({ type: "input_audio_buffer.commit" });
      } catch {
        this.voiceHandlers?.onVoiceState("idle");
      }
      return;
    }

    if (!this.activeVoiceResponse && !this.pendingVoiceResponse) {
      this.voiceHandlers?.onVoiceState("idle");
    }
  }

  close(): void {
    this.closed = true;
    this.activeTextStream = null;
    this.activeVoiceResponse = null;
    this.voiceHandlers = null;
    this.pendingVoiceResponse = false;
    this.speechDetected = false;
    this.currentInputTranscript = "";
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    this.remoteAudio?.pause();
    this.remoteAudio && (this.remoteAudio.srcObject = null);
    this.remoteAudio = null;
    this.dataChannel?.close();
    this.peerConnection?.close();
    this.audioTransceiver = null;
    this.dataChannel = null;
    this.peerConnection = null;
    this.connectPromise = null;
    this.session = null;
  }

  private async openConnection(input: AgentRealtimeConnectInput): Promise<void> {
    const session = await createRealtimeSession(input);
    const peerConnection = new RTCPeerConnection();
    const audioTransceiver = peerConnection.addTransceiver("audio", {
      direction: "sendrecv",
    });
    const dataChannel = peerConnection.createDataChannel("oai-events");
    const remoteAudio = new Audio();
    remoteAudio.autoplay = true;

    this.session = session;
    this.peerConnection = peerConnection;
    this.audioTransceiver = audioTransceiver;
    this.dataChannel = dataChannel;
    this.remoteAudio = remoteAudio;

    const channelOpen = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error("Realtime data channel did not open."));
      }, 15_000);

      dataChannel.onopen = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      dataChannel.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("Realtime data channel failed."));
      };
      dataChannel.onclose = () => {
        window.clearTimeout(timeout);
        if (!this.closed) {
          this.failActiveStreams("Realtime session closed.");
        }
      };
    });

    dataChannel.onmessage = (event: MessageEvent<string>) => {
      this.handleServerEvent(event.data);
    };
    peerConnection.ontrack = (event) => {
      if (!this.remoteAudio) return;
      this.remoteAudio.srcObject = event.streams[0] || new MediaStream([event.track]);
      void this.remoteAudio.play().catch(() => {
        this.voiceHandlers?.onError("Assistant audio playback was blocked by the browser.");
      });
    };
    peerConnection.onconnectionstatechange = () => {
      if (
        !this.closed &&
        (peerConnection.connectionState === "failed" ||
          peerConnection.connectionState === "disconnected")
      ) {
        this.failActiveStreams("Realtime connection dropped.");
      }
    };

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    if (!offer.sdp) {
      throw new Error("Realtime SDP offer was empty.");
    }

    const sdpResponse = await fetch(
      `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(session.model)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.client_secret}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      }
    );

    const answerSdp = await sdpResponse.text();
    if (!sdpResponse.ok) {
      throw new Error(extractSdpError(answerSdp, sdpResponse.status));
    }

    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: answerSdp,
    });
    await channelOpen;
  }

  private configureVoiceInput(): void {
    const session = this.session;
    if (!session) return;

    this.sendJson({
      type: "session.update",
      session: {
        type: "realtime",
        model: session.model,
        audio: {
          input: {
            noise_reduction: { type: "near_field" },
            transcription: {
              model: session.transcription_model,
              language: session.transcription_language,
              prompt: session.transcription_prompt,
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.72,
              prefix_padding_ms: 450,
              silence_duration_ms: session.silence_duration_ms,
              create_response: false,
              interrupt_response: true,
            },
          },
          output: {
            voice: session.voice,
          },
        },
      },
    });
  }

  private requestVoiceResponse(): void {
    if (!this.voiceHandlers || this.pendingVoiceResponse || this.activeVoiceResponse) return;
    const session = this.session;
    if (!session) return;

    this.pendingVoiceResponse = true;
    this.activeVoiceResponse = { text: "" };
    this.voiceHandlers.onResponseStart();
    this.voiceHandlers.onVoiceState("speaking");
    this.sendJson({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        audio: {
          output: {
            voice: session.voice,
          },
        },
      },
    });
  }

  private ensureDataChannel(): void {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      throw new Error("Realtime data channel is not open.");
    }
  }

  private sendJson(event: Record<string, unknown>): void {
    this.ensureDataChannel();
    this.dataChannel?.send(JSON.stringify(event));
  }

  private handleServerEvent(rawData: unknown): void {
    if (typeof rawData !== "string") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      return;
    }
    const payload = asRecord(parsed);
    if (!payload) return;

    const activeTextStream = this.activeTextStream;
    const type = typeof payload.type === "string" ? payload.type : "";

    if (isInputTranscriptDelta(type)) {
      const delta = readText(payload);
      if (delta) {
        this.currentInputTranscript += delta;
        this.voiceHandlers?.onInputTranscriptDelta(delta);
      }
      return;
    }

    if (isInputTranscriptDone(type)) {
      const text = readText(payload) || this.currentInputTranscript;
      this.currentInputTranscript = text;
      this.voiceHandlers?.onInputTranscriptDone(text);
      this.voiceHandlers?.onVoiceState("thinking");
      this.requestVoiceResponse();
      return;
    }

    if (isAssistantTextDelta(type)) {
      const delta = readText(payload);
      if (delta && activeTextStream) {
        activeTextStream.text += delta;
        activeTextStream.handlers.onDelta(delta);
      }
      return;
    }

    if (isAssistantTextDone(type)) {
      const text = readText(payload);
      if (typeof text === "string" && activeTextStream) {
        activeTextStream.finalText = text;
      }
      return;
    }

    if (isAssistantAudioTranscriptDelta(type)) {
      const delta = readText(payload);
      if (!delta) return;
      if (!this.activeVoiceResponse) {
        this.activeVoiceResponse = { text: "" };
        this.voiceHandlers?.onResponseStart();
      }
      this.activeVoiceResponse.text += delta;
      this.voiceHandlers?.onResponseDelta(delta);
      return;
    }

    if (isAssistantAudioTranscriptDone(type)) {
      const text = readText(payload);
      if (text && this.activeVoiceResponse) {
        this.activeVoiceResponse.text = text;
      }
      return;
    }

    if (type === "response.audio.delta") {
      this.voiceHandlers?.onVoiceState("speaking");
      return;
    }

    if (type === "input_audio_buffer.speech_started") {
      this.speechDetected = true;
      this.currentInputTranscript = "";
      this.voiceHandlers?.onVoiceState("listening");
      return;
    }

    if (type === "input_audio_buffer.speech_stopped") {
      this.voiceHandlers?.onVoiceState("thinking");
      return;
    }

    if (type === "response.done") {
      this.finishResponse(payload);
      return;
    }

    if (type === "error") {
      this.failActiveStreams(extractErrorMessage(payload));
    }
  }

  private finishResponse(payload: Record<string, unknown>): void {
    if (this.activeTextStream) {
      this.finishTextStream(payload);
      return;
    }
    if (this.activeVoiceResponse) {
      this.finishVoiceResponse(payload);
    }
  }

  private finishTextStream(payload: Record<string, unknown>): void {
    const activeTextStream = this.activeTextStream;
    if (!activeTextStream) return;

    const response = payload.response;
    const status = asRecord(response)?.status;
    const finalText =
      activeTextStream.finalText || extractFinalText(response) || activeTextStream.text;

    this.activeTextStream = null;
    if (status && status !== "completed") {
      activeTextStream.handlers.onError("Realtime response did not complete.");
      return;
    }
    activeTextStream.handlers.onDone(finalText);
  }

  private finishVoiceResponse(payload: Record<string, unknown>): void {
    const activeVoiceResponse = this.activeVoiceResponse;
    if (!activeVoiceResponse) return;

    const response = payload.response;
    const status = asRecord(response)?.status;
    const finalText = extractFinalText(response) || activeVoiceResponse.text;

    this.activeVoiceResponse = null;
    this.pendingVoiceResponse = false;
    if (status && status !== "completed") {
      this.voiceHandlers?.onError("Realtime voice response did not complete.");
      return;
    }
    this.voiceHandlers?.onResponseDone(finalText);
    this.voiceHandlers?.onVoiceState(this.localStream ? "listening" : "idle");
  }

  private failActiveStreams(message: string): void {
    const activeTextStream = this.activeTextStream;
    const hadVoiceStream = Boolean(this.activeVoiceResponse || this.pendingVoiceResponse);
    this.activeTextStream = null;
    activeTextStream?.handlers.onError(message);

    this.activeVoiceResponse = null;
    this.pendingVoiceResponse = false;
    if (hadVoiceStream) {
      this.voiceHandlers?.onError(message);
      this.voiceHandlers?.onVoiceState(this.localStream ? "listening" : "idle");
    }
  }
}
