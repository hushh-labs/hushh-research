/** UI dismissal only. No Drive content, identity, credentials, or job state is stored. */
const STORAGE_KEY = "hushh:drive-sharing-dismissals:v1";
const MAX_DISMISSALS = 40;
type Dismissal = { digest: string; expiresAt: number };

function read(): Dismissal[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is Dismissal =>
      !!item && typeof item === "object" && /^[a-f0-9]{64}$/.test(item.digest) &&
      Number.isFinite(item.expiresAt) && item.expiresAt > Date.now(),
    ).slice(-MAX_DISMISSALS);
  } catch { return []; }
}

async function digest(ownerId: string, shareId: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
    JSON.stringify([STORAGE_KEY, ownerId, shareId]),
  ));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function isDriveSharingCardDismissed(ownerId: string, shareId: string): Promise<boolean> {
  try { const key = await digest(ownerId, shareId); return read().some(item => item.digest === key); }
  catch { return false; }
}

export async function dismissDriveSharingCard(ownerId: string, shareId: string, expiresAt: string,
  isCurrent: () => boolean): Promise<void> {
  try {
    const key = await digest(ownerId, shareId);
    if (!isCurrent()) return;
    const expiry = Math.min(Date.parse(expiresAt), Date.now() + 7 * 86_400_000);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) return;
    const entries = [...read().filter(item => item.digest !== key), { digest: key, expiresAt: expiry }];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_DISMISSALS)));
  } catch { /* Closing still works in React when browser storage is disabled. */ }
}
