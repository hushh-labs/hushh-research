/** Human ETA label from seconds. Shared by the in-app and public viewers. */
export function driveEtaText(etaSeconds: number | null): string {
  if (etaSeconds == null || !Number.isFinite(etaSeconds)) return "ETA unavailable";
  if (etaSeconds < 60) return "Arriving now";
  const totalMinutes = Math.round(etaSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `~${hours} hr ${minutes} min away`;
  return `~${minutes} min away`;
}
