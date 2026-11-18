export type FileScheduleProposal = { runAt: number | null };

/** Only a current typed tool result can offer the review. It cannot supply a file or authorize work. */
export function readFileScheduleProposal(toolName: unknown, value: unknown): FileScheduleProposal | null {
  if (toolName !== "propose_file_schedule") return null;
  if (typeof value === "string" && value.length <= 512) {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (result.status !== "proposal_ready" || result.type !== "files.schedule_organization") return null;
  if (result.run_at === null) return { runAt: null };
  if (typeof result.run_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/.test(result.run_at)) return null;
  const instant = Date.parse(result.run_at);
  return Number.isFinite(instant) ? { runAt: instant } : null;
}

export function localScheduleInput(runAt: number | null): string {
  if (runAt === null) return "";
  if (runAt % 60_000 !== 0) return "";
  const date = new Date(runAt);
  const wall = new Date(runAt - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  // An ambiguous local time must be chosen explicitly in the review.
  return Date.parse(wall) === runAt ? wall : "";
}
