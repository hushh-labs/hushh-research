import { beforeEach, describe, expect, it, vi } from "vitest";
const fetcher = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: fetcher,
    getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
  },
}));
import {
  DrivePossibleMatchesService,
  POSSIBLE_MATCH_SEND_LIMIT,
  parsePossibleMatchesPage,
} from "@/lib/services/drive-possible-matches-service";

const REQUEST = "6b4d3c1e-2f5a-4b6c-8d7e-9f0a1b2c3d4e";
const JOB = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const reply = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

function match(position: number, patch: Record<string, unknown> = {}) {
  return {
    matchRef: `${JOB}:${position}`,
    name: `Weekly sync agenda ${position}.pdf`,
    modifiedTime: "2026-09-27T00:00:00Z",
    kind: "content",
    status: "possible",
    ...patch,
  };
}

describe("owner-only possible matches calls", () => {
  beforeEach(() => vi.resetAllMocks());

  it("reads the owner's list with the vault token, never cached", async () => {
    fetcher.mockResolvedValueOnce(
      reply({ requestId: REQUEST, canSend: true, count: 2, matches: [match(3), match(4, { kind: "walk" })] }),
    );
    const page = await DrivePossibleMatchesService.list("vault", REQUEST);
    expect(fetcher.mock.calls[0][0]).toBe(
      `/api/connectors/google_drive/sharing/requests/${REQUEST}/possible-matches`,
    );
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: "GET",
      cache: "no-store",
      headers: { Authorization: "Bearer vault" },
    });
    expect(page).toEqual({
      requestId: REQUEST,
      canSend: true,
      count: 2,
      matches: [
        { ...match(3), kind: "content" },
        { ...match(4), kind: "walk" },
      ],
    });
  });

  it("rejects another request's answer, forged refs and unknown statuses", () => {
    const good = { requestId: REQUEST, canSend: true, count: 1, matches: [match(3)] };
    expect(parsePossibleMatchesPage(good, REQUEST).matches).toHaveLength(1);
    for (const bad of [
      { ...good, requestId: "11111111-1111-4111-8111-111111111111" },
      { ...good, matches: [match(3, { matchRef: "../3" })] },
      { ...good, matches: [match(3, { status: "shared" })] },
      { ...good, matches: [match(3, { name: "x".repeat(301) })] },
      { ...good, count: -1 },
      { ...good, matches: "nope" },
    ]) {
      expect(() => parsePossibleMatchesPage(bad, REQUEST)).toThrow();
    }
    // An unknown reason reads as found by content; canSend is never assumed.
    const page = parsePossibleMatchesPage(
      { requestId: REQUEST, canSend: "yes", count: 0, matches: [match(3, { kind: "magic" })] },
      REQUEST,
    );
    expect(page.canSend).toBe(false);
    expect(page.matches[0].kind).toBe("content");
    expect(page.count).toBe(1);
  });

  it("sends only well-formed, unique refs and maps a closed error code", async () => {
    fetcher.mockResolvedValueOnce(
      reply({ requestId: REQUEST, queued: 1, matches: [{ matchRef: `${JOB}:3`, status: "queued" }] }, 202),
    );
    expect(await DrivePossibleMatchesService.send("vault", REQUEST, [`${JOB}:3`])).toEqual({
      requestId: REQUEST,
      queued: 1,
      matches: [{ matchRef: `${JOB}:3`, status: "queued" }],
    });
    expect(fetcher.mock.calls[0][0]).toBe(
      `/api/connectors/google_drive/sharing/requests/${REQUEST}/possible-matches/send`,
    );
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({ matchRefs: [`${JOB}:3`] }),
    });

    for (const refs of [
      [],
      [`${JOB}:3`, `${JOB}:3`],
      ["../3"],
      Array.from({ length: POSSIBLE_MATCH_SEND_LIMIT + 1 }, (_, index) => `${JOB}:${index + 1}`),
    ]) {
      await expect(DrivePossibleMatchesService.send("vault", REQUEST, refs)).rejects.toMatchObject({
        code: "invalid_argument",
      });
    }
    await expect(DrivePossibleMatchesService.list("vault", "not-a-request")).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    fetcher.mockResolvedValueOnce(
      reply({ detail: { code: "request_changed", message: "Secret file name.pdf" } }, 409),
    );
    await expect(DrivePossibleMatchesService.send("vault", REQUEST, [`${JOB}:3`])).rejects.toMatchObject({
      code: "request_changed",
      status: 409,
    });
  });
});
