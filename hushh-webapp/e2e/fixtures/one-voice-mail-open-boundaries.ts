/**
 * The one boundary the mail-open fixture replaces: the API transport.
 *
 * `lib/one-voice/mail-open.ts` runs for real -- its request guards, its typed
 * reason mapping and its refusal to believe a message-less 200 are the things
 * under test. Only `ApiService` is stood in for, so the call is a real `fetch`
 * that Playwright can answer, without dragging Firebase into the bundle.
 */

export const ApiService = {
  async apiFetch(path: string, init?: RequestInit): Promise<Response> {
    // eslint-disable-next-line no-restricted-syntax -- Synthetic browser transport; intercepted by Playwright.
    return fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  },
  getAuthHeaders(vaultOwnerToken: string): Record<string, string> {
    return { Authorization: `Bearer ${vaultOwnerToken}` };
  },
};
