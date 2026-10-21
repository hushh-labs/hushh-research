import type { CircleMembershipEvent } from "@/lib/services/circle-chat-service";
import { connectPersonName } from "@/lib/connections/person-label";

export function groupCircleMembershipEvents(events: CircleMembershipEvent[]): CircleMembershipEvent[][] {
  const groups: CircleMembershipEvent[][] = [];
  for (const event of events) {
    const previous = groups.at(-1);
    if (
      event.kind === "member_joined" &&
      event.batchId &&
      previous?.[0]?.kind === "member_joined" &&
      previous[0].batchId === event.batchId
    ) {
      previous.push(event);
      continue;
    }
    groups.push([event]);
  }
  return groups;
}

function listNames(names: string[]): string {
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function CircleMembershipEventPill({ events }: { events: CircleMembershipEvent[] }) {
  const event = events[0]!;
  const subject = connectPersonName({ displayName: event.subjectName });
  const actor = connectPersonName({ displayName: event.actorName });
  const isOtherActor = event.actorName && event.actorName !== event.subjectName;
  const label = events.length > 1
    ? `${listNames(events.map((item) => connectPersonName({ displayName: item.subjectName })))} were added`
    : event.kind === "member_joined"
    ? isOtherActor ? `${actor} added ${subject}` : `${subject} joined`
    : event.kind === "member_left" ? `${subject} left`
      : isOtherActor ? `${actor} removed ${subject}` : `${subject} was removed`;
  return <li data-circle-membership-event={event.id} className="my-4 flex justify-center px-2">
    <time dateTime={event.createdAt} title={new Date(event.createdAt).toLocaleString()} dir="auto"
      className="max-w-full rounded-full bg-[color:var(--chat-incoming,var(--card))] px-3 py-1 text-center text-[11px] leading-4 text-[color:var(--chat-muted,var(--muted-foreground))]">
      {label}
    </time>
  </li>;
}
