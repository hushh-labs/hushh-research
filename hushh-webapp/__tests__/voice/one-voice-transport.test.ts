import { expect, it } from "vitest";
import { createRealtimeVoiceTransport } from "@/lib/voice/one-voice-transport-factory";
it("rejects obsolete realtime startup explicitly", () => { expect(() => createRealtimeVoiceTransport()).toThrow("ONE_LIVE_RETIRED"); });
