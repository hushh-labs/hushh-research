/**
 * The optional "Find meeting requests and reminders in my email" choice made
 * when a Calendar account is connected. Mail access is a separate Google
 * permission that is requested right after Calendar, so the choice is remembered
 * just long enough to carry it to the new account's Follow-ups card. It is
 * scoped to the owner and to accounts that did not exist when it was made, so
 * it can never switch monitoring on for an account that was already connected.
 */
const KEY = "hushh.calendar.mailChoice.v1";
const TTL_MS = 60 * 60 * 1000;

type Choice = { ownerId: string; knownAccountIds: string[]; at: number };

function read(): Choice | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object") return null;
    const choice = value as Partial<Choice>;
    if (typeof choice.ownerId !== "string" || !Array.isArray(choice.knownAccountIds) || typeof choice.at !== "number") return null;
    return Date.now() - choice.at <= TTL_MS ? (choice as Choice) : null;
  } catch { return null; }
}

export function rememberMailChoice(ownerId: string, knownAccountIds: string[]): void {
  try { window.localStorage.setItem(KEY, JSON.stringify({ ownerId, knownAccountIds, at: Date.now() } satisfies Choice)); } catch { /* optional convenience */ }
}

export function clearMailChoice(): void {
  try { window.localStorage.removeItem(KEY); } catch { /* optional convenience */ }
}

/** True when this owner asked for email follow-ups for a newly connected account. */
export function hasMailChoice(ownerId: string, accountId: string): boolean {
  const choice = read();
  return Boolean(choice && choice.ownerId === ownerId && !choice.knownAccountIds.includes(accountId));
}
