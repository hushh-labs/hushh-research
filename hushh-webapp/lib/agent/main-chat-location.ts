import { apiJson } from "@/lib/services/api-client";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationAccessRequest, OneLocationEncryptedEnvelope, OneLocationGrant, OneLocationState,
} from "@/lib/one-location/types";

import type { LocationRecoveryAction, LocationSafetyAction, LocationWorkspaceAction, MainLocationAction, MainLocationProposal } from "./main-chat-location-contract";

export type { MainLocationAction, MainLocationContinuation, MainLocationProposal } from "./main-chat-location-contract";

const PATH = "/api/one/location/chat-plans";
export type MainLocationTarget = {
  label: string;
  detail?: string;
  personUserId?: string;
  grantId?: string;
  requestId?: string;
  circleId?: string;
  grant?: OneLocationGrant;
  request?: OneLocationAccessRequest;
};
export type MainLocationChoice = { label: string; targets: MainLocationTarget[]; requiresSelection?: boolean };
export type MainLocationPlan = {
  planId: string;
  attemptId?: string | null;
  action: Exclude<MainLocationAction, LocationRecoveryAction | LocationSafetyAction | LocationWorkspaceAction | "list_shares" | "list_requests" | "share_options" | "share_private" | "share_public">;
  personUserId?: string | null;
  personDisplayLabel?: string | null;
  grantId?: string | null;
  requestId?: string | null;
  circleId?: string | null;
  currentExpiresAt?: string | null;
  nextExpiresAt?: string | null;
  durationHours?: number | null;
  durationMode?: "timed" | "until_stopped" | null;
  expiresAt?: string | null;
  recipientKey?: { keyId: string; publicKeyJwk: JsonWebKey } | null;
  status: "pending" | "executed";
  receipt?: { grantId?: string | null; requestId?: string | null; envelopeId?: string | null; status?: string | null };
};

export function mainLocationIntentPayload(proposal: MainLocationProposal) {
  return { ...proposal, type: "location.chat_action", status: "proposal_ready" };
}

function request<T>(token: string, path: string, body?: object) {
  return apiJson<T>(path, {
    method: body ? "POST" : "GET",
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

export async function restoreMainLocationPlans(token: string, originId: string): Promise<MainLocationPlan[]> {
  const plans: MainLocationPlan[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const path = `${PATH}/origin/${encodeURIComponent(originId)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
    const result = await request<{ plans: MainLocationPlan[]; nextCursor?: string | null }>(token, path);
    plans.push(...result.plans ?? []);
    cursor = result.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("The Location review could not be fully restored. Try again.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return [...new Map(plans.map((plan) => [plan.planId, plan])).values()];
}

export function prepareMainLocationPlan(token: string, proposal: MainLocationProposal, target: MainLocationTarget) {
  return request<MainLocationPlan>(token, `${PATH}/prepare`, {
    originId: proposal.id,
    attemptId: proposal.attemptId,
    action: proposal.action,
    personUserId: target.personUserId,
    grantId: target.grantId,
    requestId: target.requestId,
    circleId: target.circleId,
    durationHours: proposal.action === "share_pin" ? undefined : proposal.durationHours,
    durationMode: proposal.action === "share_pin" ? undefined : proposal.durationMode,
  });
}

export function executeMainLocationPlan(token: string, planId: string, envelope?: OneLocationEncryptedEnvelope) {
  return request<MainLocationPlan>(token, `${PATH}/${encodeURIComponent(planId)}/execute`, { envelope });
}

const normalize = (name: string) => name.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");

function matching<T extends { label: string }>(targets: T[], query: string): T[] {
  const term = normalize(query);
  const exact = targets.filter((target) => normalize(target.label) === term);
  return exact.length ? exact : targets.filter((target) =>
    normalize(target.label).split(" ").some((word) => word === term) ||
    normalize(target.label).startsWith(`${term} `));
}

function active(grant: OneLocationGrant) {
  return grant.status === "active" && (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now());
}

function isPending(request: OneLocationAccessRequest) {
  return request.status === "pending" && (!request.expiresAt || Date.parse(request.expiresAt) > Date.now());
}

function grantTargets(grants: OneLocationGrant[], incoming: boolean): MainLocationTarget[] {
  return grants.filter(active).map((grant) => ({
    label: (incoming ? grant.ownerDisplayName : grant.recipientDisplayName) || "Location share",
    detail: grant.expiresAt ? `Until ${new Date(grant.expiresAt).toLocaleString()}` : "Until stopped",
    grantId: grant.id, grant,
    personUserId: incoming ? grant.ownerUserId : grant.recipientUserId,
    circleId: grant.sourceCircleId ?? undefined,
  }));
}

function requestTargets(requests: OneLocationAccessRequest[], ownerId: string, filterPending: boolean) {
  return requests.filter((row) => !filterPending || isPending(row)).map((row) => {
    const incoming = row.ownerUserId === ownerId;
    return {
      label: (incoming ? row.requesterDisplayName : row.ownerDisplayName) || "Location request",
      personUserId: incoming ? row.requesterUserId : row.ownerUserId,
      detail: row.isExtension ? "Extra time requested" : "Location requested",
      requestId: row.id, request: row,
    } satisfies MainLocationTarget;
  });
}

export async function resolveMainLocationChoices(params: {
  token: string; ownerId: string; proposal: MainLocationProposal; loadState: () => Promise<OneLocationState>;
}): Promise<MainLocationChoice[]> {
  const { proposal, loadState, token, ownerId } = params;
  const names = proposal.people ?? [];
  const circles = proposal.circles ?? [];
  if (["share_live", "share_pin", "ask"].includes(proposal.action)) {
    const lookup = async (name?: string) => {
      const result = await OneLocationService.listRecipientsPage({ vaultOwnerToken: token, page: 1, limit: 50, query: name });
      const found = result.items.filter((item) => item.userId !== ownerId).map((item) => ({
        label: item.displayName, personUserId: item.userId,
        ...(item.maskedPhone ? { detail: item.maskedPhone } : {}),
      }));
      if (!name) return { label: "Who would you like to choose?", targets: found, requiresSelection: true };
      const exact = matching(found, name);
      return { label: name, targets: exact.length ? exact : found,
        requiresSelection: exact.length !== 1 || normalize(exact[0]?.label ?? "") !== normalize(name) };
    };
    const people = names.length ? await Promise.all(names.map(lookup)) : [];
    if (!circles.length) return people.length ? people : [await lookup()];
    const allCircles = await OneLocationService.listCircles(token);
    const circleChoices = circles.map((name) => ({
      label: name,
      targets: (() => {
        const available = allCircles.map((circle) => ({ label: circle.name, circleId: circle.id }));
        const exact = matching(available, name);
        return exact.length ? exact : matching(available, name.replace(/\s+circle$/i, ""));
      })(),
    }));
    return [...people, ...circleChoices];
  }
  const state = await loadState();
  const incoming = grantTargets(state.receivedGrants ?? [], true);
  const outgoing = grantTargets(state.ownerGrants ?? [], false);
  const requestRows = state.requests ?? [];
  let targets: MainLocationTarget[];
  switch (proposal.action) {
    case "view":
      targets = incoming;
      break;
    case "ask_extension":
      targets = incoming.filter((item) => item.grant?.shareKind !== "pin" && Boolean(item.grant?.expiresAt));
      break;
    case "set_duration":
    case "extend":
      targets = outgoing.filter((item) => item.grant?.shareKind !== "pin" &&
        (proposal.action !== "extend" || Boolean(item.grant?.expiresAt)));
      break;
    case "list_shares":
      targets = proposal.direction === "incoming" ? incoming
        : proposal.direction === "outgoing" ? outgoing : [...outgoing, ...incoming];
      break;
    case "approve":
    case "decline":
      targets = requestTargets(requestRows.filter((row) => row.ownerUserId === ownerId), ownerId, true);
      break;
    case "list_requests":
      targets = requestTargets(requestRows.filter((row) => proposal.direction === "incoming" ? row.ownerUserId === ownerId
        : proposal.direction === "outgoing" ? row.requesterUserId === ownerId : true), ownerId, false);
      break;
    default:
      targets = outgoing;
  }
  if (proposal.action === "list_shares" || proposal.action === "list_requests") {
    return [{ label: "Location", targets: names.length ? targets.filter((target) => names.some((name) => matching([target], name).length)) : targets }];
  }
  if (!names.length && !circles.length) return [{ label: "Choose the Location activity", targets, requiresSelection: true }];
  const namedCircle = circles[0];
  if (namedCircle) {
    const circleMatches = matching((state.circles ?? []).map((circle) => ({ label: circle.name, circleId: circle.id })), namedCircle);
    const circle = circleMatches.length === 1 ? circleMatches[0] : undefined;
    if (circle) return [{
      label: circle.label,
      targets: targets.filter((target) => target.circleId === circle.circleId),
    }];
    if (!names.length) return [{ label: namedCircle, targets: [] }];
  }
  return names.map((name) => ({ label: name, targets: matching(targets, name) }));
}

export async function expandMainLocationTarget(token: string, ownerId: string, target: MainLocationTarget) {
  if (!target.circleId || target.personUserId || target.grantId) return [target];
  const result: MainLocationTarget[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const members = await OneLocationService.listCircleMembersPage({ vaultOwnerToken: token, circleId: target.circleId, page, limit: 50 });
    result.push(...members.items.filter((item) => item.userId !== ownerId).map((item) => ({
      label: item.displayName, personUserId: item.userId, circleId: target.circleId,
    })));
    if (!members.hasMore) return result;
  }
  throw new Error("This Circle is too large to review in one action.");
}
