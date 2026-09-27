import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: {
  apiFetch: api.fetch, getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
} }));
import { DriveSearchService } from "@/lib/services/drive-search-service";
const jobId = "11111111-1111-4111-8111-111111111111";
const status = { jobId, status: "running", revision: 1, matched: 1, pagesScanned: 1,
  incompleteSearch: false, canStop: true, createdAt: "2026-09-27T00:00:00Z",
  expiresAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-27T00:00:02Z", errorCode: null };
const page = { jobId, revision: 1, matched: 1, nextCursor: "opaque+/=",
  files: [{ position: 1, id: "file-one", name: "Explain For Product", mimeType: "application/vnd.google-apps.document",
    modifiedTime: null, openUrl: "https://docs.google.com/document/d/file-one/edit" }] };
beforeEach(() => { vi.resetAllMocks(); });
describe("owner Drive search API boundary", () => {
  it("sends explicit search-only consent, preserving literal query and opaque pagination", async () => {
    api.fetch.mockResolvedValueOnce(Response.json(status));
    await DriveSearchService.create("owner", "Find L'été \\ notes", jobId, () => undefined);
    const [path, options] = api.fetch.mock.calls[0];
    expect(path).toBe("/api/connectors/google_drive/searches");
    expect(options.cache).toBe("no-store");
    expect(JSON.parse(options.body)).toEqual({ clientRequestId: jobId, query: "Find L'été \\ notes", backgroundConsent: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    api.fetch.mockResolvedValueOnce(Response.json(page));
    await expect(DriveSearchService.results("owner", jobId, () => undefined, "opaque+/=")).resolves.toMatchObject(page);
    expect(api.fetch.mock.calls[1][0]).toBe(`/api/connectors/google_drive/searches/${jobId}/results?cursor=opaque%2B%2F%3D`);
  });
  it("fails closed for another job, unsafe URLs, duplicate files and overlarge result pages", async () => {
    for (const value of [
      { ...page, jobId: "22222222-2222-4222-8222-222222222222" },
      { ...page, files: [{ ...page.files[0], openUrl: "https://evil.invalid/drive" }] },
      { ...page, files: [{ ...page.files[0], openUrl: "javascript:alert(1)" }] },
      { ...page, files: [page.files[0], page.files[0]] },
      { ...page, files: [{ ...page.files[0], position: 0 }] },
      { ...page, files: [{ ...page.files[0], position: 10_001 }] },
      { ...page, files: Array.from({ length: 26 }, (_, index) => ({ ...page.files[0], id: String(index) })) },
    ]) {
      api.fetch.mockResolvedValueOnce(Response.json(value));
      await expect(DriveSearchService.results("owner", jobId, () => undefined)).rejects.toMatchObject({ code: "invalid_response" });
    }
  });
  it("rechecks owner authority after response decoding and never publishes provider messages", async () => {
    let current = true;
    const guard = () => { if (!current) throw new Error("session_changed"); };
    api.fetch.mockResolvedValueOnce({ ok: true, text: async () => { current = false; return JSON.stringify(page); } });
    await expect(DriveSearchService.results("owner", jobId, guard)).rejects.toThrow("session_changed");
    api.fetch.mockResolvedValueOnce(Response.json({ detail: { code: "search_unavailable", message: "PRIVATE PROVIDER TEXT" } }, { status: 503 }));
    await expect(DriveSearchService.get("owner", jobId, () => undefined)).rejects.toMatchObject({
      code: "search_unavailable", message: "Drive search could not finish.",
    });
  });
});
