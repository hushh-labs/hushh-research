import type { MainLocationAction, MainLocationProposal } from "./main-chat-location-contract";
import type { MainLocationChoice, MainLocationPlan, MainLocationTarget } from "./main-chat-location";
import { formatLocationDurationLabel } from "@/lib/one-location/duration-copy";

export type LocationEnableAction = "enable_location" | "enable_device_location";
export type LocationConversationReply = (text: string, displayedQuestion?: string) => boolean;
export type LocationConversationScope = { ownerId: string; vaultEpoch: number; conversationId: string };

export function ownsLocationTranscript(scope: LocationConversationScope | undefined, ownerId: string, vaultEpoch: number, conversationId: string) {
  return scope?.ownerId === ownerId && scope.vaultEpoch === vaultEpoch && scope.conversationId === conversationId;
}

export function usesLocationConversation(action: MainLocationAction) {
  return ["share_options", "share_private", "share_live", "share_pin", "ask", "enable_location", "enable_device_location",
    "setup_location", "resume_updates", "view", "list_shares", "list_requests", "stop", "extend", "set_duration", "ask_extension", "approve", "decline"].includes(action);
}

export function usesLocationChildConversation(action: MainLocationAction) {
  return ["share_public", "manage_links", "enable_auto_approve", "disable_auto_approve", "sos_review", "sos_stop", "sms_contacts"].includes(action);
}

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

// This only authorizes the corresponding model proposal from the same fresh
// composer turn. It cannot route a turn or grant authority to share a position.
export function typedLocationEnableAuthority(text: string): LocationEnableAction | undefined {
  const command = normalize(text).replace(/^please /, "").replace(/(?: please)?[.!]*$/, "");
  if (/^(?:turn on|enable|switch on|activate) (?:my |the )?location(?: sharing)?$/.test(command)) return "enable_location";
  if (/^(?:enable|allow|grant|request|check|turn on) (?:my |the )?(?:device )?location (?:permission|permissions|access)$/.test(command) ||
      /^(?:enable|turn on) (?:my |the )?device location$/.test(command)) return "enable_device_location";
  return undefined;
}

export function locationReviewDecision(text: string) {
  const reply = normalize(text).replace(/[.!]+$/, "");
  if (["yes", "yes please", "confirm", "approve", "share", "share it", "yes share", "yes, share it", "send it", "go ahead"].includes(reply)) return "confirm";
  if (["no", "cancel", "no thanks", "never mind"].includes(reply)) return "cancel";
  return null;
}

export function locationChoiceFromReply(text: string, choices: readonly MainLocationTarget[], visible?: { start: number; end: number }) {
  const reply = normalize(text);
  const number = /^(?:option )?([1-9]\d*)$/.exec(reply);
  if (number) {
    const index = Number(number[1]) - 1;
    return !visible || (index >= visible.start && index < visible.end) ? choices[index] : undefined;
  }
  const matches = choices.filter(({ label, detail }) => [label, detail && `${label} ${detail}`, detail && `${label}, ${detail}`]
    .some((value) => value && normalize(value) === reply));
  return matches.length === 1 ? matches[0] : undefined;
}

export function locationDurationReply(text: string) {
  const match = /^(?:for )?(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h)[.!]?$/.exec(normalize(text));
  if (!match) return undefined;
  const hours = Number(match[1]) / (match[2]!.startsWith("m") ? 60 : 1);
  return hours >= 0.25 && hours <= 24 && Number.isInteger(hours * 60) ? hours : undefined;
}

export type DirectLocationShare = {
  audience: { label: string; circle: boolean; proposedCircle: boolean }[];
  durationHours: number;
  current: () => boolean;
};

const canonicalName = (value: string) => normalize(value.normalize("NFKC"));
const circleName = (value: string) => value.replace(/\s+circle$/u, "");

// A literal consent witness for the model's proposal. Any unconsumed text,
// missing term, alternate mode or edited recipient keeps the review step.
export function directLocationShareTerms(text: string, proposal: MainLocationProposal): Omit<DirectLocationShare, "current"> | null {
  if (!proposal.conversation || proposal.action !== "share_live" || proposal.durationMode === "until_stopped" ||
      proposal.direction || proposal.attemptId || /[\p{Cc}\p{Cf}]/u.test(text)) return null;
  const command = /^(?:please )?share my (?:live )?location (?:privately )?with (.+?) for ((?:\d+(?:\.\d+)?|one|an?)\s*(?:minutes?|mins?|hours?|hrs?))(?: please)?[.!]?$/u.exec(canonicalName(text));
  if (!command) return null;
  const hours = locationDurationReply(command[2]!.replace(/^(?:one|an?)\s+/u, "1 "));
  if (!hours || hours !== proposal.durationHours) return null;
  const audience = command[1]!.split(/,\s*(?:and\s+)?|\s+and\s+/u).map(label => ({ label: label.trim(), circle: /\s+circle$/u.test(label.trim()) }));
  if (!audience.length || audience.length > 20 || audience.some(({ label }) => !/^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .'’_-]{0,119}$/u.test(label)) ||
      new Set(audience.map(item => circleName(item.label))).size !== audience.length) return null;
  const proposed = [...proposal.people ?? [], ...proposal.circles ?? []].map(canonicalName);
  if (proposed.length !== audience.length || audience.some(({ label, circle }) =>
    proposed.filter(value => value === label || (circle && value === circleName(label))).length !== 1)) return null;
  const proposedCircles = (proposal.circles ?? []).map(canonicalName);
  return { audience: audience.map(item => ({ ...item, proposedCircle: proposedCircles.some(label =>
    label === item.label || item.circle && label === circleName(item.label)) })), durationHours: hours };
}

export function exactDirectShareTargets(share: DirectLocationShare, choices: MainLocationChoice[]) {
  if (choices.length !== share.audience.length) return null;
  const targets: MainLocationTarget[] = [];
  for (const { label, circle, proposedCircle } of share.audience) {
    const matches = choices.filter(choice => choice.exactMatch && !choice.requiresSelection && choice.targets.length === 1)
      .flatMap(choice => choice.targets).filter(target => {
        const name = canonicalName(target.label);
        if (proposedCircle && (!target.circleId || target.personUserId)) return false;
        return (circle ? Boolean(target.circleId && !target.personUserId) && (name === label || name === circleName(label)) : name === label);
      });
    if (matches.length !== 1 || !matches[0] || (!matches[0].personUserId && !matches[0].circleId)) return null;
    targets.push(matches[0]);
  }
  return targets;
}

export function literalShareProposal(proposal: MainLocationProposal, share: DirectLocationShare): MainLocationProposal {
  return { ...proposal, people: share.audience.filter(item => !item.circle).map(item => item.label),
    circles: share.audience.filter(item => item.circle).map(item => item.label) };
}

export function sameDirectShareRecipients(left: MainLocationTarget[], right: MainLocationTarget[]) {
  const keys = (targets: MainLocationTarget[]) => targets.map(target => JSON.stringify([target.circleId ?? null, target.personUserId ?? null])).sort();
  const a = keys(left), b = keys(right);
  return a.length > 0 && a.length === b.length && new Set(a).size === a.length && a.every((key, index) => key === b[index]);
}

export function exactDirectSharePlans(share: DirectLocationShare, targets: MainLocationTarget[], plans: MainLocationPlan[]) {
  const now = Date.now();
  const requestedEnd = now + share.durationHours * 3_600_000;
  return plans.length > 0 && plans.every(plan => plan.action === "share_live" && plan.status === "pending" &&
    plan.personDisplayLabel && targets.some(target => target.personUserId === plan.personUserId && canonicalName(target.label) === canonicalName(plan.personDisplayLabel!)) &&
    plan.durationMode === "timed" && plan.durationHours === share.durationHours && plan.personUserId && plan.recipientKey?.keyId &&
    plan.recipientKey.publicKeyJwk && plan.planId && plan.expiresAt && Date.parse(plan.expiresAt) > now && plan.nextExpiresAt &&
    Math.abs(Date.parse(plan.nextExpiresAt) - requestedEnd) < 60_000) &&
    new Set(plans.map(plan => plan.planId)).size === plans.length &&
    new Set(targets.map(target => target.personUserId)).size === targets.length &&
    sameDirectShareRecipients(targets, plans.map(plan => ({ label: "", personUserId: plan.personUserId ?? undefined, circleId: plan.circleId ?? undefined })));
}

const managementVerbs: Partial<Record<MainLocationPlan["action"], readonly [string, string]>> = {
  stop: ["Stop sharing your location with", "Stopped sharing your location with"],
  extend: ["Extend your location share with", "Extended your location share with"],
  set_duration: ["Change the end time of your location share with", "Changed the end time of your location share with"],
  ask_extension: ["Request extra location sharing time from", "Requested extra location sharing time from"],
  approve: ["Approve the location request from", "Approved the location request from"],
  decline: ["Decline the location request from", "Declined the location request from"],
};

const PAGE_SIZE = 5;

export function locationTextPage<T>(items: readonly T[], page: number, describe: (item: T, index: number) => string) {
  const start = Math.max(0, Math.min(page, Math.ceil(items.length / PAGE_SIZE) - 1)) * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, items.length);
  const lines = items.slice(start, end).map((item, index) => describe(item, start + index));
  if (items.length > PAGE_SIZE) lines.push([`${start + 1}–${end} of ${items.length}.`,
    end < items.length ? 'Type “more” for the next page.' : "", start ? 'Type “previous” to go back.' : ""].filter(Boolean).join(" "));
  return { text: lines.join("\n"), start, end, total: items.length, hasPages: items.length > PAGE_SIZE };
}

export function nextLocationTextPage(text: string, page: { start: number; end: number; total: number }) {
  const value = normalize(text);
  if (["more", "next"].includes(value) && page.end < page.total) return page.start / PAGE_SIZE + 1;
  if (["previous", "back"].includes(value) && page.start > 0) return page.start / PAGE_SIZE - 1;
  return null;
}

export function locationPlanGroups(plans: readonly MainLocationPlan[]) {
  const groups = new Map<string, MainLocationPlan[]>();
  for (const plan of plans) {
    const key = JSON.stringify([plan.action, plan.durationHours, plan.durationMode,
      managementVerbs[plan.action] ? plan.nextExpiresAt : null]);
    const group = groups.get(key);
    if (group) group.push(plan); else groups.set(key, [plan]);
  }
  return [...groups.values()];
}

export function locationPlanSentence(plans: readonly MainLocationPlan[], targets: readonly MainLocationTarget[], completed: boolean, includeDecision = true) {
  const first = plans[0];
  if (!first) return "";
  const names = plans.map(plan => {
    const target = targets.find(target => target.personUserId && target.personUserId === plan.personUserId);
    const name = plan.personDisplayLabel || target?.label;
    return !completed && name && target?.detail?.startsWith("Connection") && target.detail !== "Connection"
      ? `${name} (${target.detail})` : name;
  })
    .filter((label): label is string => Boolean(label));
  if (names.length !== plans.length) return "";
  let audience = names.join(", ");
  if (plans.length > PAGE_SIZE) {
    const scopes: string[] = [];
    const counted = new Set<string>();
    for (const target of targets) {
      if (!target.circleId || target.personUserId || counted.has(target.circleId)) continue;
      const group = plans.filter(plan => plan.circleId === target.circleId);
      if (!group.length || group.some(plan => !plan.personUserId) || new Set(group.map(plan => plan.personUserId)).size !== group.length) continue;
      counted.add(target.circleId);
      const circle = /\bcircle$/i.test(target.label) ? target.label : `the ${target.label} circle`;
      scopes.push(`${group.length} member${group.length === 1 ? "" : "s"} of ${circle}`);
    }
    const others = names.filter((_, i) => !counted.has(plans[i]?.circleId ?? ""));
    scopes.push(...(completed && others.length > PAGE_SIZE ? [`${others.length} recipients`] : others));
    audience = new Intl.ListFormat("en").format(scopes);
  }
  const duration = formatLocationDurationLabel(first.durationHours);
  const term = first.durationMode === "until_stopped" ? " until you stop" : duration ? ` for ${duration}` : "";
  if (first.action === "view") return `${audience} already shares their location with you.`;
  const action = managementVerbs[first.action];
  if (action) {
    const end = first.nextExpiresAt ? new Date(first.nextExpiresAt).toLocaleString() : "";
    const terms = first.action === "stop" || first.action === "decline" ? "" :
      first.durationMode === "until_stopped" ? " until you stop" : end ? ` until ${end}` : term;
    return `${action[completed ? 1 : 0]} ${audience}${terms}${completed || !includeDecision ? "." : "? Reply yes to confirm or no to cancel."}`;
  }
  if (first.action === "ask") return completed ? `Sent your location request to ${audience}${term}.`
    : `Ask ${audience} to share their location${term}${includeDecision ? "? Reply yes to send or no to cancel." : "."}`;
  const pin = first.action === "share_pin";
  return completed ? pin ? `Sent your current location to ${audience}.` : `Shared your live location with ${audience}${term}.`
    : `Share your ${pin ? "current" : "live"} location with ${audience}${term}${includeDecision ? "? Reply yes to share or no to cancel." : "."}`;
}

export function locationReviewText(plans: readonly MainLocationPlan[], targets: readonly MainLocationTarget[]) {
  const groups = locationPlanGroups(plans);
  if (groups.length < 2) return locationPlanSentence(plans, targets, false);
  const terms = groups.map(group => locationPlanSentence(group, targets, false, false));
  return terms.every(Boolean) ? [...terms, "Reply yes to confirm or no to cancel."].join("\n") : "";
}
