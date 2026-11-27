import { formatLocationDurationLabel } from "@/lib/one-location/duration-copy";
import { LocationAgentIcon, PeopleRowIcon } from "@/components/icons/agents";
import { buildOneLocationNotificationHref, buildOneLocationWorkflowHref } from "@/lib/one-location/notifications";
import type { FeedItem } from "@/lib/services/feed-service";
import type { FeedItemPresentation } from "./feed-item-renderers";

type Context = { who: string; amount: string; requested: string; added: string };
const text = (item: FeedItem, key: string) => typeof item.metadata[key] === "string" ? item.metadata[key] as string : "";

export function locationRequestFeedLine(who:string, hours:number|string|null|undefined, mode:string|null|undefined, extension:boolean):string {
  const amount = mode === "until_stopped" ? "until you stop" : formatLocationDurationLabel(hours);
  if (!extension) return `${who} asked to see your location${amount ? mode === "until_stopped" ? ` ${amount}` : ` for ${amount}` : ""}`;
  const value=Number(hours);
  const extra = Number.isFinite(value) && value>0
    ? Number.isInteger(value) ? `${value} more ${value===1?"hour":"hours"}`
      : Number.isInteger(value*60) && value<1 ? `${value*60} more ${value*60===1?"minute":"minutes"}` : `${amount} more`
    : "more time";
  return `${who} asked for ${extra}`;
}

/** Closed Location event facts; never infer an actor or arrival from a name or place. */
export function locationFeedPresentation(item: FeedItem, context: Context): FeedItemPresentation | null {
  if (item.source_domain !== "location") return null;
  if (item.event_type === "location_one_network_joined") return {icon:PeopleRowIcon,domainLabel:"Connect",label:`You connected with ${context.who}`,description:"",href:null};
  const { who, amount, added } = context;
  const recipient = ["recipient","requester"].includes(text(item, "feed_audience")) || text(item, "viewer_role") === "requester";
  const grant = text(item, "grant_id");
  const request = text(item, "request_id");
  const status = item.activity_group_id ? text(item, "current_location_status") : "";
  const checkIn = text(item, "share_kind") === "check_in";
  const emergency = text(item, "share_kind") === "sos";
  const reason = text(item, "reason");
  const base: FeedItemPresentation = { icon: LocationAgentIcon, domainLabel: "Location", label: "", description: "", href: null };
  const share = (label: string): FeedItemPresentation => ({ ...base, label,
    description: [text(item,"approval_mode") === "automatic" ? "Automatically" : "", amount ? (item.metadata.duration_mode === "until_stopped" ? "Until stopped" : amount) : ""].filter(Boolean).join(" · "),
    ...(grant && status === "active" ? { href: recipient ? buildOneLocationNotificationHref(grant) : `/one/location?action=active-shares&grantId=${encodeURIComponent(grant)}`, exactDestination: "share" as const } : {}) });
  const circleName = text(item,"circle_name") || "the Circle";
  const circleResult = (label:string):FeedItemPresentation => ({...base,label,
    ...(text(item,"circle_id") && item.metadata.current_circle_available === true
      ? {href:`/one/location?action=circle-detail&circleId=${encodeURIComponent(text(item,"circle_id"))}`,exactDestination:"circle" as const} : {})});
  if (item.event_type === "circle_member_left") return circleResult(`${who} left ${circleName}`);
  if (item.event_type === "circle_membership_ended") return circleResult(`Your membership in ${circleName} ended`);
  if (item.event_type === "circle_deleted") return {...base,label:`${circleName} was deleted`};
  if (["location_circle_member_invite_accepted","location_circle_code_joined"].includes(item.event_type)) return circleResult(`${who} joined ${circleName}`);
  if (item.event_type === "circle_member_added") return circleResult(`${who} added you to ${circleName}`);
  if (item.event_type === "circle_invite_declined") return {...base,label:`${who} declined your invitation to ${circleName}`};
  if (item.event_type === "circle_invite_cancelled") return {...base,label:`Invitation to ${circleName} withdrawn`};
  if (["location_share_created", "location_access_approved"].includes(item.event_type)) {
    if (status === "expired") return { ...base, label: `${checkIn ? "Check-In" : "Location sharing"} with ${who} expired` };
    if (status === "revoked") return { ...base, label: `${checkIn ? "Check-In" : "Location sharing"} with ${who} ended` };
    if (emergency) return share(recipient ? `Emergency alert from ${who}` : "You sent an emergency alert");
    if (item.event_type === "location_access_approved" && item.metadata.is_extension === true) {
      if (item.metadata.duration_mode === "until_stopped") return share(recipient ? `${who} is sharing until they stop` : `You’re sharing with ${who} until you stop`);
      return share(`${recipient ? who : "You"} extended location sharing${added ? ` by ${added}` : ""}`);
    }
    if (checkIn && !recipient && text(item, "check_in_operation_id")) return { ...base, label: "Check-In shared" };
    if (checkIn) return share(recipient ? `${who} sent you a Check-In` : `You sent a Check-In to ${who}`);
    return share(status === "active" ? recipient ? `${who} is sharing their location with you` : `You’re sharing your location with ${who}`
      : recipient ? `${who} shared their location with you` : `You shared your location with ${who}`);
  }
  if (item.event_type === "location_access_request") {
    if (status === "expired") return { ...base, label: "Request expired" };
    if (recipient) return { ...base, label: `You asked ${who} to share their location` };
    return { ...base, label: locationRequestFeedLine(who,item.metadata.requested_duration_hours as number|string|null,item.metadata.requested_duration_mode as string|null,item.metadata.is_extension===true),
      ...(request && status === "pending" ? { href: buildOneLocationWorkflowHref({requestId:request,section:"approvals"}), exactDestination:"request" as const } : {}) };
  }
  if (item.event_type === "location_access_denied") return { ...base, label: item.metadata.is_extension === true
    ? recipient ? `${who} declined your request for more time` : `You declined ${who}’s request for more time`
    : recipient ? `${who} declined your location request` : `You declined ${who}’s location request` };
  if (item.event_type === "location_access_request_withdrawn") return { ...base, label: recipient ? `You withdrew your request to ${who}` : `${who} withdrew their request` };
  if (item.event_type === "location_share_expired") return { ...base, label: emergency ? recipient ? `Emergency alert from ${who} ended` : "Your emergency alert ended" : `${checkIn ? "Check-In" : "Location sharing"} with ${who} expired` };
  if (item.event_type === "location_share_revoked") {
    const noun = checkIn ? "Check-In" : "location sharing";
    const label = emergency ? recipient ? `Emergency alert from ${who} ended` : "Your emergency alert ended" : reason === "owner_revoke"
      ? recipient ? `${who} stopped sharing their location with you` : `You stopped sharing your location with ${who}`
      : reason === "recipient_revoke" ? recipient ? `You ended ${noun} with ${who}` : `${who} ended ${noun} with you`
      : `${checkIn ? "Check-In" : "Location sharing"} with ${who} ended`;
    return { ...base, label, description: ["circle_membership_ended","circle_deleted","connection_disconnected"].includes(reason) && text(item,"action_actor_label") ? `${item.metadata.actor_is_self === true ? "You" : text(item,"action_actor_label")} changed access` : "" };
  }
  if (["location_share_duration_changed","location_share_shortened"].includes(item.event_type)) {
    const extended = text(item,"direction") === "extended";
    const self = item.metadata.actor_is_self === true || (!recipient && reason === "owner_shorten");
    return share(`${self ? "You" : who} ${extended ? "extended" : "shortened"} location sharing${added ? ` by ${added}` : amount ? ` to ${amount}` : ""}`);
  }
  if (["location_sms_contact_added","location_sms_contact_removed"].includes(item.event_type)) {
    const removed = item.event_type === "location_sms_contact_removed";
    return { ...base, label: recipient ? `You ${removed ? "no longer receive" : "can receive"} ${who}’s emergency alerts` : `${who} ${removed ? "no longer receives" : "can receive"} your emergency alerts`,
      ...(text(item,"circle_id") && item.metadata.current_circle_available === true ? {href:`/one/location?action=circle-detail&circleId=${encodeURIComponent(text(item,"circle_id"))}`,exactDestination:"circle" as const}: {}) };
  }
  return null;
}
