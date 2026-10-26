// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const native = vi.hoisted(() => ({
  enabled: true,
  addListener: vi.fn(),
  getCommandCapturePermission: vi.fn(),
  requestCommandCapturePermission: vi.fn(),
  startCommandCapture: vi.fn(),
  finishCommandCapture: vi.fn(),
  cancelCommandCapture: vi.fn().mockResolvedValue({ cancelled: true }),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => native.enabled },
}));
vi.mock("@/lib/capacitor/one-voice-invocation", () => ({
  NativeOneVoiceInvocation: native,
}));
import { CommandCapture } from "@/lib/voice/command-capture";

it.each(["granted", "denied", "prompt"])("reports the actual %s result of a native permission prompt", async (state) => {
  native.getCommandCapturePermission.mockResolvedValueOnce({ state: "prompt" });
  native.requestCommandCapturePermission.mockResolvedValueOnce({ state });
  const capture = new CommandCapture();
  await expect(capture.start("permission", vi.fn())).rejects.toThrow(
    state === "granted" ? "Microphone permission updated" : "Allow microphone access in device settings.",
  );
  expect(native.startCommandCapture).not.toHaveBeenCalled();
});

it("discards a permission grant after cancellation without cancelling a newer recording", async () => {
  let grant!: (value: { state: string }) => void;
  native.getCommandCapturePermission.mockResolvedValueOnce({ state: "prompt" }).mockResolvedValueOnce({ state: "granted" });
  native.requestCommandCapturePermission.mockReturnValueOnce(new Promise(resolve => { grant = resolve; }));
  native.startCommandCapture.mockResolvedValueOnce({ sessionId: "B" });
  const capture = new CommandCapture();
  const pending = capture.start("A", vi.fn());
  const rejected = expect(pending).rejects.toThrow("cancelled");
  await Promise.resolve();
  await capture.cancel();
  await capture.start("B", vi.fn());
  grant({ state: "granted" });
  await rejected;
  expect(native.cancelCommandCapture.mock.calls.every(([input]) => input.sessionId === "A")).toBe(true);
  await capture.cancel();
});

afterEach(() => {
  native.enabled = true;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

it.each(["starting", "recording"])("cancels an ended web microphone while %s and releases its resources", async (phase) => {
  native.enabled = false;
  const stop = vi.fn();
  const track = Object.assign(new EventTarget(), { readyState: "live", stop });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let currentStream = stream;
  let loaded!: () => void;
  const moduleLoaded = phase === "starting" ? new Promise<void>(resolve => { loaded = resolve; }) : Promise.resolve();
  const audio = {
    audioWorklet: { addModule: vi.fn(() => moduleLoaded) },
    createMediaStreamSource: () => ({ connect: vi.fn() }),
    createGain: () => ({ gain: { value: 1 } }),
    resume: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), destination: {},
  };
  vi.stubGlobal("navigator", { permissions: { query: async () => ({ state: "granted" }) }, mediaDevices: { getUserMedia: async () => currentStream } });
  vi.stubGlobal("AudioContext", vi.fn(function () { return audio; }));
  vi.stubGlobal("AudioWorkletNode", vi.fn(function () { return { port: {}, connect: () => ({ connect: vi.fn() }), disconnect: vi.fn() }; }));
  const capture = new CommandCapture();
  const onEnded = vi.fn();
  const pending = capture.start("web", vi.fn(), undefined, onEnded);
  const settled = phase === "starting" ? expect(pending).rejects.toThrow("cancelled") : pending;
  await vi.waitFor(() => expect(audio.audioWorklet.addModule).toHaveBeenCalledOnce());
  if (phase === "recording") await pending;
  track.dispatchEvent(new Event("ended"));
  if (phase === "starting") loaded();
  await settled;
  expect(onEnded).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
  expect(audio.close).toHaveBeenCalledOnce();
  await expect(capture.finish()).rejects.toThrow("No recording is active");
  track.dispatchEvent(new Event("ended"));
  expect(onEnded).toHaveBeenCalledOnce();
  const retryTrack = Object.assign(new EventTarget(), { readyState: "live", stop: vi.fn() });
  currentStream = { getTracks: () => [retryTrack], getAudioTracks: () => [retryTrack] };
  // Older owners without a terminal callback retain their timeout recovery.
  await capture.start("retry", vi.fn());
  track.dispatchEvent(new Event("ended"));
  retryTrack.dispatchEvent(new Event("ended"));
  await expect(capture.start("another", vi.fn())).rejects.toThrow("already in use");
  expect(onEnded).toHaveBeenCalledOnce();
  await capture.cancel();
  expect(retryTrack.stop).toHaveBeenCalledOnce();
});

it("cancelled permission lookup cannot open a stale system prompt", async () => {
  let permission!: (value: { state: string }) => void;
  native.getCommandCapturePermission.mockReturnValueOnce(
    new Promise((resolve) => {
      permission = resolve;
    }),
  );
  const capture = new CommandCapture();
  const pending = capture.start("A", vi.fn());
  const rejected = expect(pending).rejects.toThrow("cancelled");
  await capture.cancel();
  permission({ state: "prompt" });
  await rejected;
  expect(native.requestCommandCapturePermission).not.toHaveBeenCalled();
  expect(native.startCommandCapture).not.toHaveBeenCalled();
});

it("cancel during native start discards A without cancelling a newer B", async () => {
  native.getCommandCapturePermission.mockResolvedValue({ state: "granted" });
  let started!: () => void;
  native.startCommandCapture
    .mockReturnValueOnce(
      new Promise((resolve) => {
        started = () => resolve({ sessionId: "A" });
      }),
    )
    .mockResolvedValueOnce({ sessionId: "B" });
  const capture = new CommandCapture();
  const first = capture.start("A", vi.fn());
  const rejected = expect(first).rejects.toThrow("cancelled");
  await Promise.resolve();
  await capture.cancel();
  await capture.start("B", vi.fn());
  started();
  await rejected;
  expect(
    native.cancelCommandCapture.mock.calls.every(
      ([arg]) => arg.sessionId === "A",
    ),
  ).toBe(true);
  await capture.cancel();
});

it("finish awaits one complete recording and rejects a duplicate finish", async () => {
  native.getCommandCapturePermission.mockResolvedValue({ state: "granted" });
  native.startCommandCapture.mockResolvedValue({ sessionId: "A" });
  let completed!: (value: unknown) => void;
  native.finishCommandCapture.mockReturnValueOnce(
    new Promise((resolve) => {
      completed = resolve;
    }),
  );
  const capture = new CommandCapture();
  await capture.start("A", vi.fn());
  const result = capture.finish();
  await expect(capture.finish()).rejects.toThrow("already finishing");
  const recording = { sessionId: "A", audioBase64: "whole final recording" };
  completed(recording);
  expect(await result).toBe(recording);
  expect(native.finishCommandCapture).toHaveBeenCalledTimes(1);
});

it("cancel during finalization cannot submit a late native result", async () => {
  native.getCommandCapturePermission.mockResolvedValue({ state: "granted" });
  native.startCommandCapture.mockResolvedValue({ sessionId: "A" });
  let completed!: (value: unknown) => void;
  native.finishCommandCapture.mockReturnValueOnce(
    new Promise((resolve) => {
      completed = resolve;
    }),
  );
  const capture = new CommandCapture();
  await capture.start("A", vi.fn());
  const pending = capture.finish();
  const rejected = expect(pending).rejects.toThrow("cancelled");
  await capture.cancel();
  completed({ sessionId: "A" });
  await rejected;
});

describe("whole recording AudioWorklet", () => {
  function worklet(rate = 16000) {
    let Constructor: any;
    const emitted: Array<{ type: string; sessionId: string; wav?: ArrayBuffer; level?: number; elapsedMs?: number }> = [];
    class AudioWorkletProcessor {
      port = {
        onmessage: null,
        postMessage: (value: typeof emitted[number]) => emitted.push(value),
      };
    }
    runInNewContext(
      readFileSync("public/audio/one-command-capture.worklet.js", "utf8"),
      {
        AudioWorkletProcessor,
        sampleRate: rate,
        registerProcessor: (_name: string, value: any) => {
          Constructor = value;
        },
      },
    );
    return { instance: new Constructor({ processorOptions: { sessionId: "W" } }), emitted };
  }
  it("includes the final short frame exactly once and ignores late input", () => {
    const { instance, emitted } = worklet();
    instance.process([[new Float32Array([0.25, 0.5])]]);
    instance.process([[new Float32Array([0.75])]]);
    instance.port.onmessage({ data: "finish" });
    instance.process([[new Float32Array([1])]]);
    instance.port.onmessage({ data: "finish" });
    expect(emitted).toHaveLength(1);
    const view = new DataView(emitted[0]!.wav!);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(48, true)).toBeGreaterThan(24000);
  });
  it("meters the admitted samples at most every 50ms and closes before final output", () => {
    const { instance, emitted } = worklet();
    for (let i = 0; i < 100; i++) instance.process([[new Float32Array(160).fill(0.5)]]);
    const levels = emitted.filter((event) => event.type === "level");
    expect(levels).toHaveLength(20);
    expect(levels.every((event) => event.sessionId === "W" && event.level === 0.5)).toBe(true);
    expect(levels.at(-1)?.elapsedMs).toBe(1000);
    instance.port.onmessage({ data: "finish" });
    instance.process([[new Float32Array(16000)]]);
    expect(emitted.at(-1)?.type).toBe("finished");
    expect(emitted).toHaveLength(21);
  });
  it("caps sixty seconds without losing the last permitted sample", () => {
    const { instance, emitted } = worklet();
    const frame = new Float32Array(16000).fill(0.5);
    for (let i = 0; i < 65; i++) instance.process([[frame]]);
    instance.port.onmessage({ data: "finish" });
    expect(emitted.find((event) => event.type === "finished")!.wav!.byteLength).toBe(44 + 60 * 16000 * 2);
  });
});


it("filters meter events by session and removes its listener on finish", async () => {
  const remove = vi.fn().mockResolvedValue(undefined);
  let meter!: (value: unknown) => void;
  native.addListener.mockImplementationOnce(async (_name, listener) => { meter = listener; return { remove }; });
  native.getCommandCapturePermission.mockResolvedValue({ state: "granted" });
  native.startCommandCapture.mockResolvedValue({ sessionId: "A" });
  native.finishCommandCapture.mockResolvedValue({ sessionId: "A" });
  const capture = new CommandCapture();
  const level = vi.fn();
  await capture.start("A", vi.fn(), level);
  meter({ sessionId: "old", level: 0.5, elapsedMs: 50 });
  meter({ sessionId: "A", level: NaN, elapsedMs: 50 });
  meter({ sessionId: "A", level: 0.5, elapsedMs: 50 });
  expect(level).toHaveBeenCalledExactlyOnceWith({ sessionId: "A", level: 0.5, elapsedMs: 50 });
  await capture.finish();
  meter({ sessionId: "A", level: 1, elapsedMs: 100 });
  expect(level).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledOnce();
});

it("removes a listener that finishes registering after cancellation", async () => {
  const remove = vi.fn().mockResolvedValue(undefined);
  let registered!: (value: unknown) => void;
  native.addListener.mockReturnValueOnce(new Promise((resolve) => { registered = resolve; }));
  native.getCommandCapturePermission.mockResolvedValue({ state: "granted" });
  const capture = new CommandCapture();
  const starting = capture.start("A", vi.fn(), vi.fn());
  const rejected = expect(starting).rejects.toThrow("cancelled");
  await Promise.resolve();
  await capture.cancel();
  registered({ remove });
  await rejected;
  expect(remove).toHaveBeenCalledOnce();
  expect(native.startCommandCapture).not.toHaveBeenCalled();
});
