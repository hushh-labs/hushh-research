/**
 * Pure PCM helpers for One Live Voice.
 *
 * The relay speaks `audio/pcm;rate=16000` upstream and `audio/pcm;rate=24000`
 * downstream (see lib/one-voice/protocol.ts). Everything here is side-effect
 * free and runs in any JS runtime, so the capture path, the playback
 * scheduler, and their tests share one implementation.
 */

export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;
export const PCM16_BYTES_PER_SAMPLE = 2;
/** Mirrors FRAME_SIZE in public/audio/one-live-capture.worklet.js. */
export const CAPTURE_FRAME_SIZE = 2048;

/**
 * Downsample a Float32 buffer to 16 kHz.
 *
 * Averages every source sample that falls inside each output window (a box
 * filter), which is a cheap anti-alias for the 44.1 / 48 / 96 kHz rates a
 * browser AudioContext actually runs at. Nearest-sample decimation, which the
 * retired client used, folds the 8-24 kHz band down onto speech. A source
 * that is already 16 kHz is returned as is; a source below 16 kHz is linearly
 * interpolated up.
 */
export function downsampleTo16k(
  input: Float32Array,
  inputRate: number,
): Float32Array {
  if (!Number.isFinite(inputRate) || inputRate <= 0) return input;
  if (inputRate === INPUT_SAMPLE_RATE) return input;
  const ratio = inputRate / INPUT_SAMPLE_RATE;
  if (ratio < 1) return upsampleLinear(input, ratio);
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(
      input.length,
      Math.max(start + 1, Math.floor((i + 1) * ratio)),
    );
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j] ?? 0;
    output[i] = sum / (end - start);
  }
  return output;
}

function upsampleLinear(input: Float32Array, ratio: number): Float32Array {
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    output[i] = a + (b - a) * fraction;
  }
  return output;
}

/** Float32 [-1, 1] -> little-endian PCM16 bytes (clamped). */
export function floatToPcm16(input: Float32Array): Uint8Array {
  const view = new DataView(
    new ArrayBuffer(input.length * PCM16_BYTES_PER_SAMPLE),
  );
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Uint8Array(view.buffer);
}

/** Little-endian PCM16 bytes -> Float32 [-1, 1). A trailing odd byte is ignored. */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const frames = Math.floor(bytes.byteLength / PCM16_BYTES_PER_SAMPLE);
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    frames * PCM16_BYTES_PER_SAMPLE,
  );
  const output = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    output[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return output;
}

/** Bytes -> base64 (chunked so large frames never blow the argument list). */
export function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** base64 -> bytes. Malformed input throws (the caller drops the frame). */
export function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Root mean square of a Float32 frame, in [0, 1]. */
export function rms(buffer: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const value = buffer[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / Math.max(1, buffer.length));
}

/** RMS of a PCM16 frame without allocating a Float32 copy. */
export function rmsPcm16(bytes: Uint8Array): number {
  const frames = Math.floor(bytes.byteLength / PCM16_BYTES_PER_SAMPLE);
  if (frames === 0) return 0;
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    frames * PCM16_BYTES_PER_SAMPLE,
  );
  let sum = 0;
  for (let i = 0; i < frames; i += 1) {
    const value = view.getInt16(i * 2, true) / 0x8000;
    sum += value * value;
  }
  return Math.sqrt(sum / frames);
}

/**
 * Map an RMS value to a meter level in [0, 1]. Speech at a normal distance
 * sits around 0.05-0.25 RMS, so a x4 gain fills the meter without pinning it.
 */
export function levelFromRms(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value * 4);
}

/** Duration of a PCM16 byte buffer at the given rate, in milliseconds. */
export function pcm16DurationMs(
  byteLength: number,
  sampleRate: number,
): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 0;
  return (byteLength / PCM16_BYTES_PER_SAMPLE / sampleRate) * 1000;
}
