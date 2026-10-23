let context: AudioContext | null = null;
const activeTones = new Map<() => void, string | undefined>();
const emergencyLoops = new Map<string | undefined, () => void>();
let vibrationGrant: string | undefined;
let vibrating = false;

export function stopOneLocationNotificationSound(grantId?: string): void {
  for (const [owner, stop] of emergencyLoops) {
    if (!grantId || owner === grantId) {
      stop();
      emergencyLoops.delete(owner);
    }
  }
  for (const [stop, owner] of activeTones) {
    if (!grantId || owner === grantId) stop();
  }
  if (vibrating && (!grantId || vibrationGrant === grantId)) {
    vibrating = false;
    try { navigator.vibrate(0); } catch { /* Device policy. */ }
  }
}

/** Prime the same context from an ordinary app gesture, before a push arrives. */
export function prepareOneLocationNotificationSound(): void {
  if (typeof window === "undefined") return;
  const Audio = window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Audio) return;
  try {
    if (!context || context.state === "closed") context = new Audio();
    if (context.state !== "running") void context.resume().catch(() => undefined);
  } catch {
    // Device sound policy remains authoritative; the system alert is the fallback.
  }
}

/** One authenticated provider owns audio; sign-out/unmount releases it. */
export function installOneLocationNotificationSound(): () => void {
  const onVisibility = () => {
    if (document.visibilityState !== "visible") stopOneLocationNotificationSound();
  };
  document.addEventListener("visibilitychange", onVisibility);
  const onPageHide = () => stopOneLocationNotificationSound();
  window.addEventListener("pagehide", onPageHide);
  const events = ["pointerdown", "touchend", "keydown"] as const;
  for (const event of events) {
    window.addEventListener(event, prepareOneLocationNotificationSound, { capture: true, passive: true });
  }
  return () => {
    stopOneLocationNotificationSound();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
    for (const event of events) window.removeEventListener(event, prepareOneLocationNotificationSound, true);
    const previous = context;
    context = null;
    if (previous && previous.state !== "closed") void previous.close().catch(() => undefined);
  };
}

/** Never queue a tone in a suspended context: it could ring after Stop/unlock. */
function playTone(shareKind?: string | null, grantId?: string): boolean {
  const emergency = String(shareKind || "").trim().toLowerCase() === "sos";
  // Vibration remains available even when Web Audio is absent or suspended.
  if (emergency && typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    try {
      vibrating = navigator.vibrate([240, 120, 240, 120, 520]);
      vibrationGrant = grantId;
    } catch { /* Device policy. */ }
  }
  prepareOneLocationNotificationSound();
  const audio = context;
  if (!audio || audio.state !== "running") return false;
  try {
    const tone = audio.createOscillator();
    const gain = audio.createGain();
    const start = audio.currentTime;
    tone.type = emergency ? "square" : "sine";
    if (emergency) {
      for (const offset of [0, 0.34, 0.68]) {
        const pulse = start + offset;
        tone.frequency.setValueAtTime(980, pulse);
        tone.frequency.exponentialRampToValueAtTime(620, pulse + 0.2);
        gain.gain.setValueAtTime(0.0001, pulse);
        gain.gain.exponentialRampToValueAtTime(0.1, pulse + 0.025);
        gain.gain.setValueAtTime(0.1, pulse + 0.15);
        gain.gain.exponentialRampToValueAtTime(0.0001, pulse + 0.24);
      }
    } else {
      tone.frequency.setValueAtTime(880, start);
      tone.frequency.exponentialRampToValueAtTime(660, start + 0.12);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.08, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
    }
    tone.connect(gain);
    gain.connect(audio.destination);
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      activeTones.delete(cleanup);
      tone.disconnect();
      gain.disconnect();
      tone.onended = null;
      try { tone.stop(); } catch { /* Already stopped. */ }
    };
    // The wall-clock deadline also disconnects audio interrupted mid-tone.
    const deadline = setTimeout(cleanup, emergency ? 1000 : 300);
    activeTones.set(cleanup, grantId);
    tone.onended = cleanup;
    tone.start(start);
    tone.stop(start + (emergency ? 0.94 : 0.24));
    return true;
  } catch {
    return false;
  }
}

/** Repeat only a live foreground SOS; Stop owns every future pulse as well. */
export function playOneLocationNotificationSound(
  shareKind?: string | null,
  grantId?: string,
  expiresAt?: number,
): boolean {
  const emergency = String(shareKind || "").trim().toLowerCase() === "sos";
  if (!emergency) return playTone(shareKind, grantId);
  if (typeof document === "undefined" || document.visibilityState !== "visible" ||
      (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now()))) return false;
  if (emergencyLoops.has(grantId)) return true;
  const sounded = playTone(shareKind, grantId);
  if (!sounded) return false;
  const timer = setInterval(() => {
    if (document.visibilityState !== "visible" ||
        (expiresAt !== undefined && expiresAt <= Date.now()) ||
        !playTone(shareKind, grantId)) {
      stopOneLocationNotificationSound(grantId);
    }
  }, 1500);
  emergencyLoops.set(grantId, () => clearInterval(timer));
  return true;
}
