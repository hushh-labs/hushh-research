// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const native = vi.hoisted(() => ({
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
    const emitted: ArrayBuffer[] = [];
    class AudioWorkletProcessor {
      port = {
        onmessage: null,
        postMessage: (value: ArrayBuffer) => emitted.push(value),
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
    return { instance: new Constructor(), emitted };
  }
  it("includes the final short frame exactly once and ignores late input", () => {
    const { instance, emitted } = worklet();
    instance.process([[new Float32Array([0.25, 0.5])]]);
    instance.process([[new Float32Array([0.75])]]);
    instance.port.onmessage({ data: "finish" });
    instance.process([[new Float32Array([1])]]);
    instance.port.onmessage({ data: "finish" });
    expect(emitted).toHaveLength(1);
    const view = new DataView(emitted[0]!);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(48, true)).toBeGreaterThan(24000);
  });
  it("caps sixty seconds without losing the last permitted sample", () => {
    const { instance, emitted } = worklet();
    const frame = new Float32Array(16000).fill(0.5);
    for (let i = 0; i < 65; i++) instance.process([[frame]]);
    instance.port.onmessage({ data: "finish" });
    expect(emitted[0]!.byteLength).toBe(44 + 60 * 16000 * 2);
  });
});
