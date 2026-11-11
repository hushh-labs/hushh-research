let context: AudioContext | null = null;
const activeTones = new Map<() => void, string | undefined>();
const emergencyGrants = new Set<string | undefined>();
let emergencyLoop: ReturnType<typeof setInterval> | undefined;
let emergencySounded = false;
let vibrationGrant: string | undefined;
let vibrating = false;

export function stopOneLocationNotificationSound(grantId?: string): void {
  if (grantId) emergencyGrants.delete(grantId);
  else emergencyGrants.clear();
  if (emergencyGrants.size === 0 && emergencyLoop !== undefined) {
    clearInterval(emergencyLoop);
    emergencyLoop = undefined;
    emergencySounded = false;
  }
  for (const [stop, owner] of activeTones) {
    if (!grantId || owner === grantId || (owner === undefined && emergencyGrants.size === 0)) stop();
  }
  if (vibrating && (!grantId || vibrationGrant === grantId || emergencyGrants.size === 0)) {
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
  // Hiding a tab is not acknowledgement. Browsers may suspend audio/timers;
  // retain the loop so it resumes when execution is available again.
  const onVisibility = () => {
    if (document.visibilityState === "visible") prepareOneLocationNotificationSound();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pageshow", onVisibility);
  const events = ["pointerdown", "touchend", "keydown"] as const;
  for (const event of events) {
    window.addEventListener(event, prepareOneLocationNotificationSound, { capture: true, passive: true });
  }
  return () => {
    stopOneLocationNotificationSound();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pageshow", onVisibility);
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

/** Admission checks freshness once. Only acknowledgement/disposal ends the loop. */
export function playOneLocationNotificationSound(
  shareKind?: string | null,
  grantId?: string,
  expiresAt?: number,
): boolean {
  const emergency = String(shareKind || "").trim().toLowerCase() === "sos";
  if (!emergency) return playTone(shareKind, grantId);
  if (typeof document === "undefined" ||
      (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now()))) return false;
  emergencyGrants.add(grantId);
  if (emergencyLoop !== undefined) return emergencySounded && context?.state === "running";
  // Multiple pending grants share one siren; acknowledging one cannot silence
  // the remaining grants or multiply the volume with overlapping oscillators.
  emergencySounded = playTone(shareKind);
  emergencyLoop = setInterval(() => {
    // A temporarily suspended AudioContext must not discard an unacknowledged
    // alert. A later user gesture/foreground transition can unlock it again.
    emergencySounded = playTone(shareKind);
  }, 1500);
  return emergencySounded;
}
