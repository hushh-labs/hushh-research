/** Consent-export policy for encrypted PKM source-artifact branches. */

const PRIVATE_ARTIFACT_PARTS = new Set([
  "agent_votes",
  "debate_transcript",
  "raw_card",
  "stream_diagnostics",
  "transcript",
]);

export function isPrivatePkmExportScope(scope: string): boolean {
  const parts = scope
    .split(".")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts[0] !== "attr" || parts[1] !== "financial") return false;
  const path = parts.slice(2).filter((part) => part !== "*");
  if (path.length === 0) return true;
  if (path[0] === "analysis_history") return true;
  return path.some((part) => PRIVATE_ARTIFACT_PARTS.has(part));
}
