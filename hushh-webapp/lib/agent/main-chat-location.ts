import { apiJson } from "@/lib/services/api-client";
import { OneLocationService } from "@/lib/one-location/service";
import { isForeignSmsSystemCircle } from "@/lib/one-location/system-circles";
import { settleMainLocationBatch } from "./main-chat-location-batch";
import type {
  OneLocationAccessRequest, OneLocationCircleSummary, OneLocationEncryptedEnvelope, OneLocationGrant, OneLocationState,
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
export type MainLocationChoice = {
  label: string;
  targets: MainLocationTarget[];
  requiresSelection?: boolean;
  /** True only when a complete directory search found exactly one matching full label. */
  exactMatch?: boolean;
  unavailableReason?: string;
};
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
  shareMode?: "live" | "static_pin" | "task_bound" | null;
  precision?: "precise" | "approximate" | "city" | null;
  startsAt?: string | null;
  taskLabel?: string | null;
  calendarEventId?: string | null;
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
    durationHours: proposal.action === "share_pin" || proposal.shareMode === "static_pin" ? undefined : proposal.durationHours,
    durationMode: proposal.action === "share_pin" || proposal.shareMode === "static_pin" ? undefined : proposal.durationMode,
    ...(proposal.shareMode ? { shareMode: proposal.shareMode } : {}),
    ...(proposal.precision ? { precision: proposal.precision } : {}),
    ...(proposal.startsAt ? { startsAt: proposal.startsAt } : {}),
    ...(proposal.endsAt ? { endsAt: proposal.endsAt } : {}),
    ...(proposal.taskLabel ? { taskLabel: proposal.taskLabel } : {}),
  });
}

export function executeMainLocationPlan(token: string, planId: string, envelope?: OneLocationEncryptedEnvelope) {
  return request<MainLocationPlan>(token, `${PATH}/${encodeURIComponent(planId)}/execute`, { envelope });
}

export function inspectMainLocationPlan(token: string, planId: string) {
  return request<MainLocationPlan>(token, `${PATH}/${encodeURIComponent(planId)}`);
}

const normalize = (name: string) => name.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");

function matching<T extends { label: string }>(targets: T[], query: string): T[] {
  const term = normalize(query);
  const exact = targets.filter((target) => normalize(target.label) === term);
  return exact.length ? exact : targets.filter((target) =>
    normalize(target.label).split(" ").some((word) => word === term) ||
    normalize(target.label).startsWith(`${term} `));
}

function audienceChoice(
  name: string,
  targets: MainLocationTarget[],
  complete: boolean,
): MainLocationChoice {
  const matches = [
    ...matching(targets.filter((target) => target.personUserId), name),
    ...matching(targets.filter((target) => target.circleId), name),
  ];
  const only = matches.length === 1 ? matches[0] : undefined;
  // A single given name is enough to offer the full connection name for final
  // confirmation. A surname, partial Circle name or incomplete page stays a choice.
  const label = only && normalize(only.label);
  const term = normalize(name);
  const identified = label === term || (!!only?.personUserId && label?.split(" ")[0] === term);
  const requiresSelection = !complete || !identified;
  const exactMatch = complete && label === term;
  // A masked phone tail disambiguates duplicate names. A unique recipient needs only their name.
  if (only?.personUserId && !requiresSelection) {
    return { label: name, targets: [{ ...only, detail: "Connection" }], requiresSelection, exactMatch };
  }
  return { label: name, targets: matches, requiresSelection, exactMatch };
}

async function distinguishDuplicateCircles(choices: MainLocationChoice[], circles: OneLocationCircleSummary[], token: string, ownerId: string) {
  const summaries = new Map(circles.map(circle => [circle.id, circle]));
  const duplicates = new Map<string, OneLocationCircleSummary>();
  for (const { targets } of choices) {
    const seen = new Map<string, OneLocationCircleSummary>();
    for (const target of targets) {
      const circle = target.circleId && summaries.get(target.circleId);
      if (!circle) continue;
      const name = normalize(circle.name);
      const prior = seen.get(name);
      if (prior && prior.id !== circle.id) { duplicates.set(prior.id, prior); duplicates.set(circle.id, circle); }
      else seen.set(name, circle);
    }
  }
  if (!duplicates.size) return choices;
  const descriptions = new Map<string, string>();
  for (const circle of duplicates.values()) {
    const count = Number.isInteger(circle.memberCount) ? `${circle.memberCount} member${circle.memberCount === 1 ? "" : "s"}` : "";
    descriptions.set(circle.id, ["Circle", circle.role === "owner" ? "you own it" : "", count, circle.customTypeLabel].filter(Boolean).join(" · "));
  }
  const identical = [...duplicates.values()].filter(circle => [...duplicates.values()].some(other =>
    other.id !== circle.id && normalize(other.name) === normalize(circle.name) && descriptions.get(other.id) === descriptions.get(circle.id)));
  // Read only a small named group; large or indistinguishable lists must be
  // renamed by the owner before a numbered reply can identify an audience.
  if (identical.length <= 10) await settleMainLocationBatch(identical, async circle => {
    const page = await OneLocationService.listCircleMembersPage({ vaultOwnerToken: token, circleId: circle.id, page: 1, limit: 5 });
    const names = page.items.filter(member => member.userId !== ownerId && member.displayName.trim())
      .map(member => member.displayName.trim()).sort().slice(0, 3);
    if (names.length) descriptions.set(circle.id, `${descriptions.get(circle.id)} · includes ${names.join(", ")}`);
  });
  return choices.map(choice => {
    const known = new Set<string>();
    const targets = choice.targets.map(target => target.circleId && descriptions.has(target.circleId)
      ? { ...target, detail: descriptions.get(target.circleId) } : target);
    for (const item of targets) {
      if (!item.circleId) continue;
      const display = JSON.stringify([normalize(item.label), normalize(item.detail ?? "")]);
      if (known.has(display)) return { ...choice, targets: [], requiresSelection: true, exactMatch: false,
        unavailableReason: `I found several Circles named ${item.label} with the same visible details. Which connection or differently named Circle did you mean?` };
      known.add(display);
    }
    return { ...choice, targets };
  });
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
    const queries = names.length || circles.length ? names : [undefined];
    const [allCircles, pages] = await Promise.all([
      OneLocationService.listCircles(token),
      Promise.all(queries.map((query) =>
        OneLocationService.listRecipientsPage({ vaultOwnerToken: token, page: 1, limit: 50, query }))),
    ]);
    const circleTargets: MainLocationTarget[] = allCircles.filter((circle) => !isForeignSmsSystemCircle(circle))
      .map((circle) => ({ label: circle.name, circleId: circle.id, detail: "Circle" }));
    const choices = pages.map((page, index) => {
      const query = queries[index];
      const people = page.items.filter((item) => item.userId !== ownerId).map((item) => ({
        label: item.displayName, personUserId: item.userId,
        detail: item.maskedPhone ? `Connection · ${item.maskedPhone}` : "Connection",
      }));
      const targets = [...people, ...circleTargets];
      if (!query) return { label: "Who would you like to choose?", targets, requiresSelection: true };
      // Bare names from Chat can name either a connection or a Circle.
      const choice = audienceChoice(query, targets, !page.hasMore);
      if (!choice.targets.length) choice.targets = people;
      return choice;
    });
    for (const name of circles) {
      const qualified = name.replace(/\s+circle$/i, "");
      const exact = circleTargets.filter(target => normalize(target.label) === normalize(name) || normalize(target.label) === normalize(qualified));
      if (exact.length > 1) choices.push({ label: name, targets: exact, requiresSelection: true, exactMatch: false });
      else choices.push({ ...audienceChoice(exact[0]?.label || qualified, circleTargets, true), label: name });
    }
    return distinguishDuplicateCircles(choices, allCircles, token, ownerId);
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
