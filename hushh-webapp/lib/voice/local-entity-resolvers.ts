/**
 * Small, privacy-preserving entity resolver ports for local voice turns.
 *
 * These functions operate on application-provided projections. They never
 * fetch contacts, read vault material, or emit the candidate values to
 * telemetry. A production caller can replace the candidate list with a
 * governed service without changing intent resolution.
 */

export type LocalEntityCandidate = { id: string; label: string };

export type LocalEntityResolution =
  | { status: "unique"; value: LocalEntityCandidate; matches: [LocalEntityCandidate] }
  | { status: "ambiguous"; matches: LocalEntityCandidate[] }
  | { status: "not_found"; matches: [] };

export function normalizeEntityText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveLocalEntity(
  spoken: string,
  candidates: readonly LocalEntityCandidate[],
): LocalEntityResolution {
  const query = normalizeEntityText(spoken);
  if (!query) return { status: "not_found", matches: [] };
  const normalized = candidates
    .filter((candidate) => candidate.id.trim() && candidate.label.trim())
    .map((candidate) => ({
      candidate,
      label: normalizeEntityText(candidate.label),
    }))
    .filter((entry) => entry.label === query || entry.label.includes(query));
  const unique = Array.from(
    new Map(normalized.map((entry) => [entry.candidate.id, entry.candidate])).values(),
  );
  if (unique.length === 1) return { status: "unique", value: unique[0]!, matches: [unique[0]!] };
  if (unique.length > 1) return { status: "ambiguous", matches: unique };
  return { status: "not_found", matches: [] };
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  thirty: 30,
  sixty: 60,
};

function numericValue(value: string): number | null {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  return NUMBER_WORDS[value.toLocaleLowerCase()] ?? null;
}

export type LocalDuration = { minutes: number; unit: "minutes" | "hours" | "days" };

export function parseLocalDuration(
  spoken: string,
  options?: { allowedMinutes?: readonly number[]; maxMinutes?: number },
): LocalDuration | null {
  const normalized = normalizeEntityText(spoken);
  const match = normalized.match(
    /\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|thirty|sixty)\s*(minute|minutes|min|hour|hours|hr|day|days)\b/,
  );
  let minutes: number;
  let unit: LocalDuration["unit"];
  if (match) {
    const amount = numericValue(match[1]!);
    if (amount === null || amount <= 0) return null;
    const rawUnit = match[2]!;
    unit = rawUnit.startsWith("day") ? "days" : rawUnit.startsWith("hour") || rawUnit === "hr" ? "hours" : "minutes";
    minutes = unit === "days" ? amount * 24 * 60 : unit === "hours" ? amount * 60 : amount;
  } else if (/\bhalf an hour\b/.test(normalized)) {
    minutes = 30;
    unit = "minutes";
  } else if (/\ba day\b/.test(normalized)) {
    minutes = 24 * 60;
    unit = "days";
  } else {
    return null;
  }
  if (options?.maxMinutes !== undefined && minutes > options.maxMinutes) return null;
  if (
    options?.allowedMinutes &&
    !options.allowedMinutes.some((allowed) => allowed === minutes)
  ) {
    return null;
  }
  return { minutes, unit };
}

export function extractSpokenEntity(
  spoken: string,
  markers: readonly string[],
): string | null {
  const normalized = normalizeEntityText(spoken);
  for (const marker of markers) {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = normalized.match(new RegExp(`\\b${escaped}\\s+(.+?)(?:\\s+(?:for|to|with|now))?$`));
    if (match?.[1]) return match[1].trim().slice(0, 128) || null;
  }
  return null;
}
