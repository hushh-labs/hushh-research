// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const native = vi.hoisted(() => ({
  addListener: vi.fn(),
  getCommandCapturePermission: vi.fn(),
  requestCommandCapturePermission: vi.fn(),
  startCommandCapture: vi.fn(),
  finishCommandCapture: vi.fn(),
  cancelCommandCapture: vi.fn().mockResolvedValue({ cancelled: true }),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
}));
vi.mock("@/lib/capacitor/one-voice-invocation", () => ({
  NativeOneVoiceInvocation: native,
}));
import { CommandCapture } from "@/lib/voice/command-capture";

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
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
