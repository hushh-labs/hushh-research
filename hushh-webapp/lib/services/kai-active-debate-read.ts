export type ActiveKaiDebateRequest = {
  userId: string;
  debateSessionId: string;
  vaultOwnerToken: string;
  signal?: AbortSignal;
};

export function readActiveKaiDebateRun(
  request: (path: string, options: RequestInit) => Promise<Response>,
  { userId, debateSessionId, vaultOwnerToken, signal }: ActiveKaiDebateRequest,
): Promise<Response> {
  const query = new URLSearchParams({ user_id: userId, debate_session_id: debateSessionId });
  return request(`/api/kai/analyze/run/active?${query}`, {
    method: "GET",
    signal,
    headers: { Authorization: `Bearer ${vaultOwnerToken}` },
  });
}
