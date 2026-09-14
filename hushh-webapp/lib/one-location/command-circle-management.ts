import type {
  LocalActionPreparation,
  LocalActionResources,
} from "@/lib/agent/local-onboarding-actions";
import type {
  OneLocationCircleSummary,
  OneLocationCircleOverview,
  OneLocationCircleMemberPage,
  OneLocationCircleMemberInvite,
} from "./types";
import { readAllCommandPeople } from "./command-preparation";

export type CircleManagementAction =
  | "location.rename_circle"
  | "location.remove_from_circle"
  | "location.leave_circle"
  | "location.delete_circle"
  | "location.accept_circle_invite"
  | "location.decline_circle_invite";
export type CircleManagementBinding = Record<string, unknown> & {
  owner: string;
  action: CircleManagementAction;
  circleId: string;
  circleName: string;
  circleUpdatedAt?: string;
  newName?: string;
  memberId?: string;
  memberName?: string;
  joinedAt?: string;
  roster?: Array<{ userId: string; role: string; joinedAt: string }>;
  inviteId?: string;
  inviterId?: string;
  inviteCreatedAt?: string;
  inviteExpiresAt?: string;
};
export type CircleManagementReceipt = {
  operation_id: string;
  action_id: CircleManagementAction;
  circle_id: string;
  member_id: string | null;
  invite_id: string | null;
  result: string;
};
type Choice = { circleId?: string; memberId?: string; inviteId?: string };
const encoded = (choice: Choice) =>
  `circle-management:${JSON.stringify(choice)}`;
function decoded(value?: string): Choice {
  if (!value?.startsWith("circle-management:")) return {};
  try {
    const choice = JSON.parse(value.slice("circle-management:".length));
    if (
      choice &&
      typeof choice === "object" &&
      !Array.isArray(choice) &&
      Object.keys(choice).every(
        (key) =>
          ["circleId", "memberId", "inviteId"].includes(key) &&
          typeof choice[key] === "string",
      )
    )
      return choice;
  } catch {
    /* Only owning-service records can turn a choice into a binding. */
  }
  return {};
}
const sameName = (a: string, b: string) =>
  a.trim().normalize("NFC").toLocaleLowerCase() ===
  b.trim().normalize("NFC").toLocaleLowerCase();
const hasTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

export async function prepareCircleManagement(input: {
  owner: string | null;
  action: CircleManagementAction;
  slots: Record<string, unknown>;
  choice?: string;
  resources?: LocalActionResources;
  circles(): Promise<OneLocationCircleSummary[]>;
  overview(id: string): Promise<OneLocationCircleOverview>;
  members(id: string, page: number): Promise<OneLocationCircleMemberPage>;
  invites(): Promise<OneLocationCircleMemberInvite[]>;
}): Promise<LocalActionPreparation> {
  if (!input.owner)
    return {
      status: "blocked",
      gate: "input",
      summary: "Unlock One to review your circles.",
    };
  const choice = decoded(input.choice),
    requestedName = String(input.slots.circle || "").trim();
  const sources = input.resources?.circle;
  if (sources && (sources.length !== 1 || sources[0]?.kind !== "circle"))
    return {
      status: "blocked",
      gate: "input",
      summary: "Choose one circle for this change.",
    };
  if (
    input.action === "location.accept_circle_invite" ||
    input.action === "location.decline_circle_invite"
  ) {
    const invites = (await input.invites()).filter(
      (invite) =>
        invite.inviteeUserId === input.owner &&
        invite.status === "pending" &&
        hasTimestamp(invite.expiresAt) &&
        Date.parse(invite.expiresAt) > Date.now(),
    );
    const matches = choice.inviteId
      ? invites.filter((invite) => invite.id === choice.inviteId)
      : sources?.[0]?.id
        ? invites.filter((invite) => invite.circleId === sources[0]!.id)
        : requestedName
          ? invites.filter((invite) =>
              sameName(invite.circleName, requestedName),
            )
          : invites;
    if (matches.length !== 1)
      return {
        status: "blocked",
        gate: "input",
        summary: matches.length
          ? "Which circle invitation do you mean?"
          : "That pending invitation was not found. Choose a current invitation.",
        choices: (matches.length ? matches : invites).map((invite) => ({
          id: encoded({ inviteId: invite.id }),
          label: invite.circleName,
          detail: `From ${invite.inviterDisplayName}`,
        })),
      };
    const invite = matches[0]!;
    if (!hasTimestamp(invite.createdAt) || !hasTimestamp(invite.expiresAt))
      return {
        status: "simulate",
        summary:
          "People opened. Review the invitation there; its current terms could not be verified.",
      };
    return {
      status: "ready",
      binding: {
        owner: input.owner,
        action: input.action,
        circleId: invite.circleId,
        circleName: invite.circleName,
        inviteId: invite.id,
        inviterId: invite.inviterUserId,
        inviteCreatedAt: invite.createdAt,
        inviteExpiresAt: invite.expiresAt,
      },
      summary:
        input.action === "location.accept_circle_invite"
          ? `Accept ${invite.inviterDisplayName}'s invitation to ${invite.circleName}? You remain connected with ${invite.inviterDisplayName} after leaving this circle. Location sharing is separate; accepting sends no location.`
          : `Decline ${invite.inviterDisplayName}'s invitation to ${invite.circleName}?`,
    };
  }
  const requestedId = choice.circleId || sources?.[0]?.id;
  const circles = await input.circles();
  const matches = requestedId
    ? circles.filter((circle) => circle.id === requestedId)
    : requestedName
      ? circles.filter((circle) => sameName(circle.name, requestedName))
      : circles;
  if (matches.length !== 1)
    return {
      status: "blocked",
      gate: "input",
      summary: matches.length
        ? "Which circle do you mean?"
        : "That circle is no longer available. Choose a current circle.",
      choices: (matches.length ? matches : circles).map((circle) => ({
        id: encoded({ circleId: circle.id }),
        label: circle.name,
      })),
    };
  const circle = await input.overview(matches[0]!.id);
  if (circle.id !== matches[0]!.id || !hasTimestamp(circle.updatedAt))
    return {
      status: "simulate",
      summary:
        "People opened. Review the circle there; its current state could not be verified.",
    };
  if (circle.systemKind === "trusted")
    return {
      status: "blocked",
      gate: "input",
      summary:
        "Trusted follows your accepted connections. Change those connections in Connect.",
    };
  const caps = circle.viewerCapabilities;
  if (
    input.action === "location.leave_circle"
      ? !caps?.canLeaveCircle
      : input.action === "location.delete_circle"
        ? !caps?.canDeleteCircle
        : !caps?.canManageCircle
  )
    return {
      status: "blocked",
      gate: "input",
      summary: `Your current role does not allow this change to ${circle.name}.`,
    };
  const binding: CircleManagementBinding = {
    owner: input.owner,
    action: input.action,
    circleId: circle.id,
    circleName: circle.name,
    circleUpdatedAt: circle.updatedAt,
  };
  if (input.action === "location.rename_circle") {
    const name = String(input.slots.name || "")
      .trim()
      .split(/\s+/u)
      .join(" ");
    if (!name || name.length > 80)
      return {
        status: "blocked",
        gate: "input",
        summary: "What should the circle be called? Choose 1 to 80 characters.",
      };
    if (
      circles.some((item) => item.id !== circle.id && sameName(item.name, name))
    )
      return {
        status: "blocked",
        gate: "input",
        summary:
          "Another circle already has that name. Choose a different name.",
      };
    return {
      status: "ready",
      binding: { ...binding, newName: name },
      summary: `Rename ${circle.name} to ${name}?`,
    };
  }
  const members = await readAllCommandPeople((page) =>
    input.members(circle.id, page),
  );
  if (input.action === "location.delete_circle") {
    if (
      !members.length ||
      members.length !== circle.memberCount ||
      members.some((member) => !hasTimestamp(member.joinedAt))
    )
      return {
        status: "blocked",
        gate: "input",
        summary:
          "The full circle membership changed while loading. Refresh it before deleting.",
      };
    return {
      status: "ready",
      binding: {
        ...binding,
        roster: members
          .map((member) => ({
            userId: member.userId,
            role: member.role,
            joinedAt: member.joinedAt!,
          }))
          .sort((a, b) => a.userId.localeCompare(b.userId)),
      },
      summary: `Delete ${circle.name} for all ${members.length} members (${members.map((member) => member.displayName).join(", ")})? Circle invitations and location access through it will end. Direct shares keep their existing access.`,
    };
  }
  const references = input.resources?.person;
  if (
    references &&
    (references.length !== 1 || references[0]?.kind !== "person")
  )
    return {
      status: "blocked",
      gate: "input",
      summary: "Remove one member at a time. Nobody has been removed.",
    };
  const memberId =
    input.action === "location.leave_circle"
      ? input.owner
      : choice.memberId || references?.[0]?.id;
  const personName = String(input.slots.person || "").trim();
  const selected = memberId
    ? members.filter((member) => member.userId === memberId)
    : personName
      ? members.filter((member) => sameName(member.displayName, personName))
      : [];
  if (selected.length !== 1)
    return {
      status: "blocked",
      gate: "input",
      summary: "Which current member should be removed?",
      choices: (selected.length
        ? selected
        : members.filter((member) => member.role !== "owner")
      ).map((member) => ({
        id: encoded({ circleId: circle.id, memberId: member.userId }),
        label: member.displayName,
      })),
    };
  const member = selected[0]!;
  if (member.role === "owner" || !hasTimestamp(member.joinedAt))
    return {
      status: "blocked",
      gate: "input",
      summary:
        "The circle owner cannot leave or be removed. Review the current membership.",
    };
  return {
    status: "ready",
    binding: {
      ...binding,
      memberId: member.userId,
      memberName: member.displayName,
      joinedAt: member.joinedAt,
    },
    summary:
      input.action === "location.leave_circle"
        ? `Leave ${circle.name}? Location access through this circle will end.`
        : `Remove ${member.displayName} from ${circle.name}? Location access through this circle will end; direct shares keep their existing access.`,
  };
}

const RESULTS: Record<CircleManagementAction, string> = {
  "location.rename_circle": "renamed",
  "location.remove_from_circle": "removed",
  "location.leave_circle": "left",
  "location.delete_circle": "deleted",
  "location.accept_circle_invite": "accepted",
  "location.decline_circle_invite": "declined",
};
export function verifyCircleManagementReceipt(
  receipt: CircleManagementReceipt | undefined,
  binding: CircleManagementBinding,
  operation: string,
): void {
  if (
    !receipt ||
    receipt.operation_id !== operation ||
    receipt.action_id !== binding.action ||
    receipt.circle_id !== binding.circleId ||
    receipt.member_id !== (binding.memberId || null) ||
    receipt.invite_id !== (binding.inviteId || null) ||
    receipt.result !== RESULTS[binding.action]
  )
    throw Error(
      "The circle operation has no matching receipt. Review People before retrying.",
    );
}
export function circleManagementResult(
  binding: CircleManagementBinding,
): string {
  switch (binding.action) {
    case "location.rename_circle":
      return `${binding.circleName} was renamed to ${binding.newName}.`;
    case "location.remove_from_circle":
      return `${binding.memberName} was removed from ${binding.circleName}.`;
    case "location.leave_circle":
      return `You left ${binding.circleName}.`;
    case "location.delete_circle":
      return `${binding.circleName} was deleted.`;
    case "location.accept_circle_invite":
      return `The invitation to ${binding.circleName} was accepted.`;
    case "location.decline_circle_invite":
      return `The invitation to ${binding.circleName} was declined.`;
  }
}
