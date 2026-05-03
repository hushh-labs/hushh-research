/**
 * iAlphabets Service — client-side API wrapper for the A-Z trading game.
 *
 * Mirrors the pattern in kai-service.ts. All methods proxy through
 * /api/ialphabets/... which forwards to the Python backend.
 */

const BASE = "/api/ialphabets";

let _token: string | null = null;

export function setIalphabetsVaultOwnerToken(token: string | null) {
  _token = token;
}

function authHeaders(): HeadersInit {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (_token) h["Authorization"] = `Bearer ${_token}`;
  return h;
}

async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `API error ${res.status}`);
  }
  return res.json();
}

async function apiPost<T = unknown>(
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `API error ${res.status}`);
  }
  return res.json();
}

async function apiPut<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `API error ${res.status}`);
  }
  return res.json();
}

async function apiDelete<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `API error ${res.status}`);
  }
  return res.json();
}

// ── Seasons ─────────────────────────────────────────────────

export function getActiveSeason() {
  return apiGet("/seasons/active");
}

// ── Leagues ─────────────────────────────────────────────────

export function createLeague(body: {
  name: string;
  privacy?: string;
  max_members?: number;
}) {
  return apiPost("/leagues", body);
}

export function getLeague(leagueId: string) {
  return apiGet(`/leagues/${leagueId}`);
}

export function listMyLeagues() {
  return apiGet<{ leagues: unknown[] }>("/leagues/mine");
}

export function listPublicLeagues(limit = 20, cursor?: string) {
  const qs = cursor ? `?limit=${limit}&cursor=${cursor}` : `?limit=${limit}`;
  return apiGet(`/leagues/public${qs}`);
}

export function closeLeague(leagueId: string) {
  return apiDelete(`/leagues/${leagueId}`);
}

// ── Alphabets / Draft ───────────────────────────────────────

export function ensureDraft(leagueId: string) {
  return apiPost(`/leagues/${leagueId}/alphabet/draft`);
}

export function upsertPick(
  leagueId: string,
  body: { letter: string; ticker: string; company_name?: string }
) {
  return apiPut(`/leagues/${leagueId}/alphabet/pick`, body);
}

export function finalizeAlphabet(leagueId: string) {
  return apiPost(`/leagues/${leagueId}/alphabet/finalize`);
}

export function swapPick(
  leagueId: string,
  body: { letter: string; new_ticker: string; new_company_name?: string }
) {
  return apiPost(`/leagues/${leagueId}/alphabet/swap`, body);
}

export function getMyAlphabet(leagueId: string) {
  return apiGet(`/leagues/${leagueId}/alphabet`);
}

// ── Ticker Search ───────────────────────────────────────────

export function searchTickersByLetter(
  letter: string,
  q = "",
  limit = 25
) {
  return apiGet<{ tickers: unknown[] }>(
    `/tickers/by-letter/${letter}?q=${encodeURIComponent(q)}&limit=${limit}`
  );
}

// ── Leaderboard ─────────────────────────────────────────────

export function getLeaderboard(leagueId: string) {
  return apiGet(`/leagues/${leagueId}/leaderboard`);
}

export function getLeaderboardHistory(leagueId: string) {
  return apiGet(`/leagues/${leagueId}/leaderboard/history`);
}

// ── Invites ─────────────────────────────────────────────────

export function createInvite(body: {
  league_id?: string;
  kind?: string;
}) {
  return apiPost("/invites", body);
}

export function getInvitePreview(code: string) {
  return apiGet(`/invites/${code}`);
}

export function redeemInvite(code: string) {
  return apiPost(`/invites/${code}/redeem`);
}
