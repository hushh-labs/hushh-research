import { CONSENTED_MEMORY_MAX_CHARS, LIVE_MIRROR_PACKET_HEADER } from "@/lib/pkm/live-mirror-agent-facts";
import { liveActivityAgentPacket } from "./live-activity-copy";
import type { LiveActivityEvent } from "./live-activity-types";

const SEPARATOR = "\n\n";

/** Soul.md and its trailing LIVE MIRROR FACTS block, split the way the backend reads them. */
function splitLiveMirror(memory: string): { soul: string; mirror: string } {
  const index = memory.startsWith(LIVE_MIRROR_PACKET_HEADER) ? 0 : memory.lastIndexOf(`\n${LIVE_MIRROR_PACKET_HEADER}`) + 1;
  if (index === 0 && !memory.startsWith(LIVE_MIRROR_PACKET_HEADER)) return { soul: memory, mirror: "" };
  return { soul: memory.slice(0, index).trimEnd(), mirror: memory.slice(index) };
}

/**
 * A chat turn's consented memory field: the save receipt, Soul.md, today's
 * activity, then the LIVE MIRROR FACTS block, which the backend requires to stay
 * last. Activity sits after Soul.md so a head-first clip (Kai finance keeps the
 * start of Soul.md) cuts activity first, and it gets only the room left under
 * the server's limit, so it never pushes the mirror past the clip or the field
 * past the private-agent request limit.
 */
export function composeAgentPkmContext(params: {
  receipt: string;
  memory: string;
  events: readonly LiveActivityEvent[];
  now: number;
}): string | undefined {
  const { soul, mirror } = splitLiveMirror(params.memory);
  const fixed = [params.receipt, soul, mirror].filter(Boolean);
  const room = CONSENTED_MEMORY_MAX_CHARS - fixed.join(SEPARATOR).length - (fixed.length ? SEPARATOR.length : 0);
  const activity = room > 0 ? liveActivityAgentPacket(params.events, params.now, { maxChars: room }) : "";
  return [params.receipt, soul, activity, mirror].filter(Boolean).join(SEPARATOR) || undefined;
}
