import { apiJson } from "@/lib/services/api-client";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationAccessRequest, OneLocationEncryptedEnvelope, OneLocationGrant, OneLocationState,
} from "@/lib/one-location/types";

export const MAIN_CHAT_LOCATION_ENABLED = process.env.NEXT_PUBLIC_ONE_MAIN_CHAT_LOCATION_ENABLED === "true";
const PATH = "/api/one/location/chat-plans";
const actions = [
  "share_options", "share_private", "share_public",
  "share_live", "share_pin", "ask", "view", "list_shares", "list_requests", "stop", "set_duration",
  "extend", "ask_extension", "approve", "decline",
] as const;
export type MainLocationAction = typeof actions[number];
export type MainLocationProposal = {
  id: string;
  attemptId?: string;
  action: MainLocationAction;
  people?: string[];
  circles?: string[];
  durationHours?: number;
  durationMode?: "timed" | "until_stopped";
  direction?: "incoming" | "outgoing" | "all";
};
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
export type MainLocationContinuation = {
  step: "visibility" | "audience" | "duration" | "review" | "receipt";
  action: MainLocationAction;
  people: string[];
  circles: string[];
  durationHours?: number;
};
export type MainLocationPlan = {
  planId: string;
  attemptId?: string | null;
  action: Exclude<MainLocationAction, "list_shares" | "list_requests" | "share_options" | "share_private" | "share_public">;
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

const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

export function parseMainLocationProposal(value: unknown): MainLocationProposal | null {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (input.proposal && typeof input.proposal === "object") return parseMainLocationProposal(input.proposal);
  if (input.type !== "location.chat_action" || typeof input.id !== "string" ||
      !UUID.test(input.id) || !actions.some((action) => action === input.action)) return null;
  const names = (items: unknown, limit: number) => {
    if (items === undefined || items === null) return undefined;
    if (!Array.isArray(items) || items.length > limit ||
        items.some((name) => typeof name !== "string" || !name.trim() || name.length > 160)) return null;
    return [...new Set((items as string[]).map((name) => name.trim()))];
  };
  const people = names(input.people, 20);
  const circles = names(input.circles, 5);
  if (people === null || circles === null) return null;
  return {
    id: input.id, action: input.action as MainLocationAction, people, circles,
    ...(typeof input.durationHours === "number" && Number.isFinite(input.durationHours) && input.durationHours > 0
      ? { durationHours: input.durationHours } : {}),
    ...(input.durationMode === "timed" || input.durationMode === "until_stopped" ? { durationMode: input.durationMode } : {}),
    ...(input.direction === "incoming" || input.direction === "outgoing" || input.direction === "all" ? { direction: input.direction } : {}),
  };
}

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
  const result = await request<{ plans: MainLocationPlan[] }>(token, `${PATH}/origin/${encodeURIComponent(originId)}`);
  return result.plans ?? [];
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
  const circles = proposal.action === "ask" ? [] : proposal.circles ?? [];
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
