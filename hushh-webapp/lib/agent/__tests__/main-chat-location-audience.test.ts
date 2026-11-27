import { beforeEach, expect, it, vi } from "vitest";
import { resolveMainLocationChoices } from "../main-chat-location";

const directory = vi.hoisted(() => ({ listRecipientsPage: vi.fn(), listCircles: vi.fn(), listCircleMembersPage: vi.fn() }));
vi.mock("@/lib/one-location/service", () => ({ OneLocationService: directory }));

function resolve(people: string[], circles: string[] = []) {
  return resolveMainLocationChoices({
    ownerId: "me", token: "token", loadState: vi.fn(),
    proposal: { id: "chat-turn", action: "share_live", people, circles },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  directory.listCircles.mockResolvedValue([{ id: "family", name: "Family", role: "owner" }]);
  directory.listRecipientsPage.mockResolvedValue({ items: [], hasMore: false });
});

it("resolves a bare Circle name and an explicitly qualified Circle without guessing a connection", async () => {
  const target = { label: "Family", circleId: "family", detail: "Circle" };
  expect(await resolve(["Family"])).toEqual([{ label: "Family", targets: [target], requiresSelection: false, exactMatch: true }]);
  expect(await resolve([], ["Family Circle"])).toEqual([{ label: "Family Circle", targets: [target], requiresSelection: false, exactMatch: true }]);
  expect(directory.listRecipientsPage).toHaveBeenCalledTimes(1);
});

it("asks which audience was intended when a Circle and a connection share a name", async () => {
  directory.listRecipientsPage.mockResolvedValue({ items: [
    { userId: "person", displayName: "Family Adams", maskedPhone: "••1234" },
  ], hasMore: false });
  const [choice] = await resolve(["Family"]);
  expect(choice).toEqual({ label: "Family", requiresSelection: true, exactMatch: false, targets: [
    { label: "Family Adams", personUserId: "person", detail: "Connection · ••1234" },
    { label: "Family", circleId: "family", detail: "Circle" },
  ] });
});

it("uses a unique first name for review only when the directory search is complete", async () => {
  const items = [{ userId: "person", displayName: "Kushal Trivedi" }];
  directory.listRecipientsPage.mockResolvedValueOnce({ items, hasMore: false }).mockResolvedValueOnce({ items, hasMore: true });
  expect((await resolve(["Kushal"]))[0]).toMatchObject({ requiresSelection: false, exactMatch: false, targets: [{ label: "Kushal Trivedi" }] });
  expect((await resolve(["Kushal"]))[0]).toMatchObject({ requiresSelection: true, exactMatch: false });
});

it("recognizes either stored Circle name and asks when the qualified spelling could mean both", async () => {
  const nm = { id: "nm", name: "NM", role: "owner" };
  const full = { ...nm, id: "nm-circle", name: "NM Circle" };
  for (const circle of [nm, full]) {
    directory.listCircles.mockResolvedValueOnce([circle]);
    expect((await resolve([], ["NM circle"]))[0]).toMatchObject({
      requiresSelection: false, exactMatch: true, targets: [{ label: circle.name, circleId: circle.id }],
    });
  }
  directory.listCircles.mockResolvedValueOnce([nm, full]);
  expect((await resolve([], ["NM circle"]))[0]).toMatchObject({ requiresSelection: true, exactMatch: false,
    targets: [{ circleId: nm.id }, { circleId: full.id }] });
});

it("uses recognizable members for identically named Circles and withholds options if they still look identical", async () => {
  const nm = { id: "first", name: "NM", role: "owner", memberCount: 2 };
  directory.listCircles.mockResolvedValue([nm, { ...nm, id: "second" }]);
  const page = (displayName: string) => ({ items: [{ userId: "member", displayName }], hasMore: false });
  directory.listCircleMembersPage.mockResolvedValueOnce(page("Maya")).mockResolvedValueOnce(page("Ravi"));
  expect((await resolve([], ["NM"]))[0]).toMatchObject({ requiresSelection: true, exactMatch: false,
    targets: [{ detail: expect.stringContaining("includes Maya") }, { detail: expect.stringContaining("includes Ravi") }] });
  directory.listCircleMembersPage.mockResolvedValue(page("Maya"));
  expect((await resolve([], ["NM"]))[0]).toMatchObject({ requiresSelection: true, exactMatch: false,
    targets: [], unavailableReason: expect.stringContaining("Which connection or differently named Circle") });
});
