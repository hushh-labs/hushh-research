import { expect, it, vi } from "vitest";
import {
  prepareCircleManagement,
  verifyCircleManagementReceipt,
} from "@/lib/one-location/command-circle-management";
import type { CircleManagementBinding } from "@/lib/one-location/command-circle-management";
import type {
  OneLocationCircleMember,
  OneLocationCircleOverview,
  OneLocationCircleMemberInvite,
} from "@/lib/one-location/types";

const joinedAt = "2026-09-13T00:00:00.000Z";
const member = (
  userId: string,
  displayName = userId,
  role: "owner" | "member" = "member",
): OneLocationCircleMember => ({
  userId,
  displayName,
  role,
  joinedAt,
  phoneVerified: true,
  secureLocationReady: true,
});
const circle = (id = "goa"): OneLocationCircleOverview => ({
  id,
  name: "Goa",
  role: "owner",
  kind: "other",
  memberCount: 2,
  memberLimit: 100,
  updatedAt: joinedAt,
  viewerCapabilities: {
    canManageCircle: true,
    canDeleteCircle: true,
    canLeaveCircle: false,
    canInviteMembers: true,
    canViewInviteCode: true,
    canRotateInviteCode: true,
    canModerateInvites: true,
  },
});
const invite = (
  id = "invitation",
  circleId = "goa",
): OneLocationCircleMemberInvite => ({
  id,
  circleId,
  circleName: "Goa",
  circleKind: "other",
  inviterUserId: "abdul",
  inviterDisplayName: "Abdul",
  inviteeUserId: "owner",
  status: "pending",
  createdAt: joinedAt,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
});
const base = {
  owner: "owner",
  action: "location.rename_circle" as const,
  slots: { circle: "Goa", name: "Goa trip" },
  circles: async () => [circle()],
  overview: async (id: string) => circle(id),
  members: async (_id: string, page: number) => ({
    items: [member("owner", "Owner", "owner"), member("abdul", "Abdul")],
    page,
    hasMore: false,
    totalCount: 2,
  }),
  invites: async () => [invite()],
};
const choose = (value: object) => `circle-management:${JSON.stringify(value)}`;

it("binds a rename to the freshly read circle and exact new name", async () => {
  expect(await prepareCircleManagement(base)).toMatchObject({
    status: "ready",
    binding: {
      circleId: "goa",
      circleUpdatedAt: joinedAt,
      newName: "Goa trip",
      owner: "owner",
    },
  });
  expect(
    await prepareCircleManagement({
      ...base,
      slots: { ...base.slots, name: " " },
    }),
  ).toMatchObject({ status: "blocked", gate: "input" });
});

it("lets an explicit user choice replace a stale circle reference without silently substituting", async () => {
  const args = {
    ...base,
    resources: { circle: [{ kind: "circle" as const, id: "removed" }] },
  };
  expect(await prepareCircleManagement(args)).toMatchObject({
    status: "blocked",
    choices: [{ id: choose({ circleId: "goa" }) }],
  });
  expect(
    await prepareCircleManagement({
      ...args,
      choice: choose({ circleId: "goa" }),
    }),
  ).toMatchObject({ status: "ready", binding: { circleId: "goa" } });
});

it("retains exact invite references and explains the actual durable relationship", async () => {
  const args = {
    ...base,
    action: "location.accept_circle_invite" as const,
    slots: {},
    resources: { circle: [{ kind: "circle" as const, id: "removed" }] },
  };
  expect(await prepareCircleManagement(args)).toMatchObject({
    status: "blocked",
  });
  expect(
    await prepareCircleManagement({
      ...args,
      choice: choose({ inviteId: "invitation" }),
    }),
  ).toMatchObject({
    status: "ready",
    binding: { circleId: "goa", inviteId: "invitation", inviterId: "abdul" },
    summary: expect.stringContaining("accepting sends no location"),
  });
  expect(
    await prepareCircleManagement({
      ...args,
      resources: undefined,
      invites: async () => [{ ...invite(), inviteeUserId: "other" }],
    }),
  ).toMatchObject({ status: "blocked" });
});

it("requires a choice for duplicate names and honors a selected current membership", async () => {
  const members = [
    member("owner", "Owner", "owner"),
    member("abdul-a", "Abdul"),
    member("abdul-b", "Abdul"),
  ];
  const args = {
    ...base,
    action: "location.remove_from_circle" as const,
    slots: { person: "Abdul" },
    members: async (_id: string, page: number) => ({
      items: members,
      page,
      hasMore: false,
      totalCount: 3,
    }),
  };
  expect(await prepareCircleManagement(args)).toMatchObject({
    status: "blocked",
    choices: [{ label: "Abdul" }, { label: "Abdul" }],
  });
  expect(
    await prepareCircleManagement({
      ...args,
      resources: { person: [{ kind: "person", id: "old-member" }] },
      choice: choose({ circleId: "goa", memberId: "abdul-b" }),
    }),
  ).toMatchObject({
    status: "ready",
    binding: { memberId: "abdul-b", joinedAt },
  });
});

it("reviews every paginated deletion member and rejects changed or truncated rosters", async () => {
  const members = vi.fn(async (_id: string, page: number) => ({
    items: [
      page === 1 ? member("owner", "Owner", "owner") : member("abdul", "Abdul"),
    ],
    page,
    hasMore: page === 1,
    totalCount: 2,
  }));
  expect(
    await prepareCircleManagement({
      ...base,
      action: "location.delete_circle",
      members,
    }),
  ).toMatchObject({
    status: "ready",
    binding: { roster: [{ userId: "abdul" }, { userId: "owner" }] },
    summary: expect.stringContaining("Owner, Abdul"),
  });
  expect(members).toHaveBeenCalledTimes(2);
  await expect(
    prepareCircleManagement({
      ...base,
      action: "location.delete_circle",
      members: async (_id, page) => ({
        items: [member("owner")],
        page,
        hasMore: false,
        totalCount: 2,
      }),
    }),
  ).rejects.toThrow("incomplete");
});

it("preserves role, system-circle and current-membership prerequisites", async () => {
  expect(
    await prepareCircleManagement({
      ...base,
      overview: async () => ({ ...circle(), systemKind: "trusted" }),
    }),
  ).toMatchObject({ status: "blocked" });
  expect(
    await prepareCircleManagement({ ...base, action: "location.leave_circle" }),
  ).toMatchObject({ status: "blocked" });
  const mine = {
    ...circle(),
    role: "member" as const,
    viewerCapabilities: {
      ...circle().viewerCapabilities!,
      canLeaveCircle: true,
    },
  };
  expect(
    await prepareCircleManagement({
      ...base,
      action: "location.leave_circle",
      overview: async () => mine,
      members: async (_id, page) => ({
        items: [member("owner")],
        page,
        hasMore: false,
        totalCount: 1,
      }),
    }),
  ).toMatchObject({
    status: "ready",
    binding: { memberId: "owner", joinedAt },
  });
});

it("never reports success for another operation, action, member or result", () => {
  const binding: CircleManagementBinding = {
    owner: "owner",
    action: "location.remove_from_circle",
    circleId: "goa",
    circleName: "Goa",
    memberId: "abdul",
  };
  const receipt = {
    operation_id: "operation",
    action_id: binding.action,
    circle_id: "goa",
    member_id: "abdul",
    invite_id: null,
    result: "removed",
  };
  expect(() =>
    verifyCircleManagementReceipt(receipt, binding, "operation"),
  ).not.toThrow();
  for (const changed of [
    { operation_id: "other" },
    { action_id: "location.leave_circle" as const },
    { member_id: "other" },
    { result: "pending" },
  ])
    expect(() =>
      verifyCircleManagementReceipt(
        { ...receipt, ...changed },
        binding,
        "operation",
      ),
    ).toThrow("matching receipt");
});
