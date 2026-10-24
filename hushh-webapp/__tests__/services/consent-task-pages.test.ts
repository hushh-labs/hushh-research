import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConsentCenterService, type ConsentCenterPageListResponse } from "@/lib/services/consent-center-service";
import { listConsentTaskPages } from "@/lib/services/consent-task-pages";

vi.mock("@/lib/services/consent-center-service", () => ({ ConsentCenterService: { listEntries: vi.fn() } }));
const page = (number: number, ids: string[], more: boolean) => ({ user_id: "owner", page: number, items: ids.map(id => ({ id })), has_more: more, total: 3 } as ConsentCenterPageListResponse);
const options = { userId: "owner", idToken: "fixture", surface: "pending" as const };
describe("complete consent task discovery", () => {
  beforeEach(() => vi.mocked(ConsentCenterService.listEntries).mockReset());
  it("traverses every page and reconciles duplicate boundary rows", async () => {
    vi.mocked(ConsentCenterService.listEntries).mockResolvedValueOnce(page(1, ["a", "b"], true)).mockResolvedValueOnce(page(2, ["b", "c"], false));
    const result = await listConsentTaskPages(options, () => true);
    expect(result.items.map(row => row.id)).toEqual(["a", "b", "c"]);
    expect(result.has_more).toBe(false);
    expect(ConsentCenterService.listEntries).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, limit: 100 }));
  });
  it("refuses a page belonging to another owner", async () => {
    vi.mocked(ConsentCenterService.listEntries).mockResolvedValue({ ...page(1, ["a"], false), user_id: "other" });
    await expect(listConsentTaskPages(options, () => true)).rejects.toThrow("could not be verified");
  });
  it("does not turn an unreadable next page into an empty success", async () => {
    vi.mocked(ConsentCenterService.listEntries).mockResolvedValueOnce(page(1, ["a"], true)).mockRejectedValueOnce(new Error("Offline"));
    await expect(listConsentTaskPages(options, () => true)).rejects.toThrow("Offline");
  });
  it("stops reading after the owner changes", async () => {
    let current = true;
    vi.mocked(ConsentCenterService.listEntries).mockImplementation(async () => { current = false; return page(1, ["a"], true); });
    await expect(listConsentTaskPages(options, () => current)).rejects.toThrow("Session changed");
    expect(ConsentCenterService.listEntries).toHaveBeenCalledOnce();
  });
});
