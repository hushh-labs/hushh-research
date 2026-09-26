/**
 * Which cell holds the current voice session: the person's own pod, or the shared hub.
 *
 * Typed turns already carry their cell (`AgentTurnResult.cell`); voice did not, and a
 * person whose chat runs on their pod had no way to know their voice session was held
 * by the hub. The relay-session mint is the one place the backend states it, so the
 * value is recorded there and read by the Agent Bar through `useSyncExternalStore`.
 * No React in this module: the recorder is called from the API layer.
 */
export type VoiceCell = "hub" | "pod";

export type VoiceCellSnapshot = { cell: VoiceCell | null; reason: string | null };

const EMPTY: VoiceCellSnapshot = { cell: null, reason: null };

let snapshot: VoiceCellSnapshot = EMPTY;
const listeners = new Set<() => void>();

export function recordVoiceCell(next: VoiceCellSnapshot): void {
  if (next.cell === snapshot.cell && next.reason === snapshot.reason) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

export function readVoiceCell(): VoiceCellSnapshot {
  return snapshot;
}

export function subscribeVoiceCell(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function voiceCellLabel(cell: VoiceCell | null): string | null {
  if (cell === "pod") return "your pod";
  if (cell === "hub") return "Hussh hub";
  return null;
}
