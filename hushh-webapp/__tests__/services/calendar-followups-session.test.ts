import { beforeEach, expect, it, vi } from "vitest";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { CalendarFollowupsService } from "@/lib/services/calendar-followups-service";
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch } }));
beforeEach(() => {
  apiFetch.mockReset();
  publishValidatedAuthSessionOwner(null);
  publishValidatedAuthSessionOwner("owner");
});
it("uses Firebase without a vault header and fences transport setup", async () => {
  apiFetch.mockResolvedValue(new Response("{}"));
  await CalendarFollowupsService.post("status", { user_id: "owner", account_id: "account-b" }, "firebase");
  const options = apiFetch.mock.calls[0][1];
  expect(options.headers).toEqual({ Authorization: "Bearer firebase", "Content-Type": "application/json" });
  expect(options.isEffectCurrent()).toBe(true);
  publishValidatedAuthSessionOwner(null);
  expect(options.isEffectCurrent()).toBe(false);
});
it("rejects departed or foreign-owner calls before dispatch", async () => {
  await expect(CalendarFollowupsService.post("status", { user_id: "other" }, "firebase")).rejects.toMatchObject({ name: "AbortError" });
  publishValidatedAuthSessionOwner(null);
  await expect(CalendarFollowupsService.post("status", { user_id: "owner" }, "firebase")).rejects.toMatchObject({ name: "AbortError" });
  expect(apiFetch).not.toHaveBeenCalled();
});
it("does not release a response after identity withdrawal", async () => {
  let finish!: (value: Response) => void;
  apiFetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const result = CalendarFollowupsService.post("status", { user_id: "owner" }, "firebase");
  publishValidatedAuthSessionOwner(null);
  finish(new Response("{}"));
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
});
