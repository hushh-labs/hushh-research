/** The existing device recorder emits bounded 16 kHz, mono PCM WAV. */
export const MAX_VOICE_MESSAGE_MS = 60_000;

export function inspectVoiceMessage(bytes: Uint8Array): { durationMs: number; peaks: number[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const invalid = () => new Error("Choose a valid voice recording up to one minute.");
  if (bytes.length < 46 || bytes.length > 5 * 1024 * 1024 || tag(0) !== "RIFF" || tag(8) !== "WAVE"
    || view.getUint32(4, true) + 8 !== bytes.length) throw invalid();
  let pcm: Uint8Array | null = null;
  let format = false;
  let offset = 12;
  for (; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset + 4, true);
    const end = offset + 8 + length;
    if (end > bytes.length) throw invalid();
    if (tag(offset) === "fmt ") {
      if (format || length < 16 || view.getUint16(offset + 8, true) !== 1
        || view.getUint16(offset + 10, true) !== 1 || view.getUint32(offset + 12, true) !== 16_000
        || view.getUint32(offset + 16, true) !== 32_000 || view.getUint16(offset + 20, true) !== 2
        || view.getUint16(offset + 22, true) !== 16) throw invalid();
      format = true;
    }
    if (tag(offset) === "data") {
      if (!format || pcm || length < 2 || length % 2) throw invalid();
      pcm = bytes.subarray(offset + 8, end);
    }
    offset = end + length % 2;
  }
  if (offset !== bytes.length || !format || !pcm || pcm.length / 32 > MAX_VOICE_MESSAGE_MS) throw invalid();
  const samples = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const count = pcm.length / 2;
  const peaks = Array.from({ length: 32 }, (_, bar) => {
    const start = Math.floor(bar * count / 32), end = Math.floor((bar + 1) * count / 32);
    let peak = 0;
    for (let index = start; index < end; index++) peak = Math.max(peak, Math.abs(samples.getInt16(index * 2, true)) / 32768);
    return peak;
  });
  return { durationMs: Math.max(1, Math.round(pcm.length / 32)), peaks };
}

export function formatVoiceDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
