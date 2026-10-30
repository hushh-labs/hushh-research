import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  CAPTURE_FRAME_SIZE,
  base64FromBytes,
  bytesFromBase64,
  downsampleTo16k,
  floatToPcm16,
  levelFromRms,
  pcm16DurationMs,
  pcm16ToFloat,
  rms,
  rmsPcm16,
} from "@/lib/one-voice/audio/pcm";

describe("downsampleTo16k", () => {
  it("returns the same buffer when the source is already 16 kHz", () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(downsampleTo16k(input, 16000)).toBe(input);
  });

  it("decimates 48 kHz by three and averages each window", () => {
    const input = new Float32Array([0, 0.3, 0.6, 1, 1, 1, -0.5, 0.5, 0]);
    const output = downsampleTo16k(input, 48000);
    expect(output.length).toBe(3);
    expect(output[0]).toBeCloseTo(0.3, 5);
    expect(output[1]).toBeCloseTo(1, 5);
    expect(output[2]).toBeCloseTo(0, 5);
  });

  it("preserves a DC level through a non-integer ratio (44.1 kHz)", () => {
    const input = new Float32Array(4410).fill(0.25);
    const output = downsampleTo16k(input, 44100);
    expect(output.length).toBe(Math.floor(4410 / (44100 / 16000)));
    for (const value of output) expect(value).toBeCloseTo(0.25, 6);
  });

  it("produces the expected frame length for a worklet frame at 48 kHz", () => {
    const output = downsampleTo16k(new Float32Array(CAPTURE_FRAME_SIZE), 48000);
    expect(output.length).toBe(Math.floor(CAPTURE_FRAME_SIZE / 3));
  });

  it("interpolates up when the source is below 16 kHz", () => {
    const output = downsampleTo16k(new Float32Array([0, 1]), 8000);
    expect(output.length).toBe(4);
    expect(output[0]).toBeCloseTo(0, 6);
    expect(output[1]).toBeCloseTo(0.5, 6);
    expect(output[2]).toBeCloseTo(1, 6);
  });
});

describe("PCM16 conversion", () => {
  it("encodes little-endian and clamps out-of-range samples", () => {
    const bytes = floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    const view = new DataView(bytes.buffer);
    expect(bytes.byteLength).toBe(12);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(0x7fff);
    expect(view.getInt16(4, true)).toBe(-0x8000);
    expect(view.getInt16(6, true)).toBe(0x7fff);
    expect(view.getInt16(8, true)).toBe(-0x8000);
    expect(view.getInt16(10, true)).toBe(Math.trunc(0.5 * 0x7fff));
    // Byte order: 0x7fff little-endian is ff 7f.
    expect(bytes[2]).toBe(0xff);
    expect(bytes[3]).toBe(0x7f);
  });

  it("round-trips float -> pcm16 -> float within two LSBs", () => {
    const input = new Float32Array([0, 0.25, -0.25, 0.999, -0.999, 0.001]);
    const output = pcm16ToFloat(floatToPcm16(input));
    expect(output.length).toBe(input.length);
    for (let i = 0; i < input.length; i += 1) {
      expect(Math.abs((output[i] ?? 0) - (input[i] ?? 0))).toBeLessThan(
        2 / 0x7fff,
      );
    }
  });

  it("ignores a trailing odd byte and honours byteOffset views", () => {
    const backing = new Uint8Array([9, 9, 0x00, 0x40, 0x00, 0xc0, 7]);
    const slice = backing.subarray(2, 7);
    const output = pcm16ToFloat(slice);
    expect(output.length).toBe(2);
    expect(output[0]).toBeCloseTo(0.5, 6);
    expect(output[1]).toBeCloseTo(-0.5, 6);
  });
});

describe("base64", () => {
  it("round-trips bytes including chunks above 32 KiB", () => {
    const bytes = new Uint8Array(70_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31) & 0xff;
    const encoded = base64FromBytes(bytes);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(bytesFromBase64(encoded)).toEqual(bytes);
  });

  it("encodes an empty buffer to an empty string", () => {
    expect(base64FromBytes(new Uint8Array())).toBe("");
    expect(bytesFromBase64("")).toEqual(new Uint8Array());
  });
});

describe("levels", () => {
  it("computes rms and maps it to a bounded meter level", () => {
    expect(rms(new Float32Array())).toBe(0);
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5, 6);
    expect(levelFromRms(0.1)).toBeCloseTo(0.4, 6);
    expect(levelFromRms(0.5)).toBe(1);
    expect(levelFromRms(Number.NaN)).toBe(0);
    expect(levelFromRms(-1)).toBe(0);
  });

  it("rmsPcm16 matches rms of the decoded frame", () => {
    const samples = new Float32Array([0.5, -0.5, 0.25, -0.25]);
    const bytes = floatToPcm16(samples);
    expect(rmsPcm16(bytes)).toBeCloseTo(rms(pcm16ToFloat(bytes)), 6);
    expect(rmsPcm16(new Uint8Array())).toBe(0);
  });

  it("derives frame duration from byte length", () => {
    // 2048 samples at 48 kHz downsampled to 682 samples at 16 kHz.
    expect(pcm16DurationMs(682 * 2, 16000)).toBeCloseTo(42.625, 3);
    expect(pcm16DurationMs(32000, 16000)).toBe(1000);
    expect(pcm16DurationMs(100, 0)).toBe(0);
  });
});

describe("one-live-capture worklet", () => {
  function worklet() {
    let Constructor: any;
    const emitted: Array<{ frame: Float32Array; rms: number }> = [];
    const transfers: unknown[][] = [];
    class AudioWorkletProcessor {
      port = {
        onmessage: null,
        postMessage: (value: (typeof emitted)[number], transfer: unknown[]) => {
          emitted.push(value);
          transfers.push(transfer);
        },
      };
    }
    runInNewContext(
      readFileSync("public/audio/one-live-capture.worklet.js", "utf8"),
      {
        AudioWorkletProcessor,
        sampleRate: 48000,
        registerProcessor: (name: string, value: any) => {
          expect(name).toBe("one-live-capture");
          Constructor = value;
        },
      },
    );
    return { instance: new Constructor(), emitted, transfers };
  }

  it("posts 2048-sample frames with their rms and transfers the buffer", () => {
    const { instance, emitted, transfers } = worklet();
    const quantum = new Float32Array(128).fill(0.5);
    for (let i = 0; i < 15; i += 1)
      expect(instance.process([[quantum]])).toBe(true);
    expect(emitted).toHaveLength(0);
    instance.process([[quantum]]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.frame.length).toBe(CAPTURE_FRAME_SIZE);
    expect(emitted[0]!.rms).toBeCloseTo(0.5, 6);
    expect(transfers[0]).toEqual([emitted[0]!.frame.buffer]);
    // The next frame starts from a fresh accumulator.
    for (let i = 0; i < 16; i += 1) instance.process([[new Float32Array(128)]]);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]!.rms).toBe(0);
  });

  it("stays alive on empty input", () => {
    const { instance, emitted } = worklet();
    expect(instance.process([])).toBe(true);
    expect(instance.process([[]])).toBe(true);
    expect(emitted).toHaveLength(0);
  });
});
