let audioContext: AudioContext | null = null;

/** Open audio only from the person's sound-toggle gesture. */
export async function prepareFeedChime(): Promise<boolean> {
  if (typeof window === "undefined" || typeof window.AudioContext !== "function") return false;
  try {
    audioContext ??= new window.AudioContext();
    if (audioContext.state === "suspended") await audioContext.resume();
    return audioContext.state === "running";
  } catch {
    // Browser sound policy and device audio settings remain authoritative.
    return false;
  }
}

/** A quiet, short cue. A blocked/suspended context never delays Feed updates. */
export function playFeedChime(): void {
  const context = audioContext;
  if (!context || context.state !== "running") return;
  try {
    const tone = context.createOscillator();
    const volume = context.createGain();
    const start = context.currentTime;
    tone.type = "sine";
    tone.frequency.setValueAtTime(660, start);
    tone.frequency.exponentialRampToValueAtTime(880, start + 0.12);
    volume.gain.setValueAtTime(0.0001, start);
    volume.gain.exponentialRampToValueAtTime(0.035, start + 0.025);
    volume.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
    tone.connect(volume);
    volume.connect(context.destination);
    tone.start(start);
    tone.stop(start + 0.21);
    tone.onended = () => {
      tone.disconnect();
      volume.disconnect();
    };
  } catch {
    // A failed cue must never affect notification delivery or Feed rendering.
  }
}
