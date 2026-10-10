import type { CircleMembershipEvent } from "@/lib/services/circle-chat-service";

export function CircleMembershipEventPill({ event }: { event: CircleMembershipEvent }) {
  const subject = event.subjectName;
  const actor = event.actorName;
  const label = event.kind === "member_joined"
    ? actor && actor !== subject ? `${actor} added ${subject}` : `${subject} joined`
    : event.kind === "member_left" ? `${subject} left`
      : actor && actor !== subject ? `${actor} removed ${subject}` : `${subject} was removed`;
  return <li data-circle-membership-event={event.id} className="my-4 flex justify-center px-2">
    <time dateTime={event.createdAt} title={new Date(event.createdAt).toLocaleString()}
      className="max-w-full rounded-full bg-[color:var(--chat-incoming,var(--card))] px-3 py-1 text-center text-[11px] leading-4 text-[color:var(--chat-muted,var(--muted-foreground))]">
      {label}
    </time>
  </li>;
}
