import { REACTION_LABELS, type AgentMessageReaction } from "@/lib/agent/agent-message-reaction";
import styles from "./agent-message-reaction.module.css";

export function AgentMessageReactionBadge({ reaction }: { reaction: AgentMessageReaction }) {
  return (
    <span
      role="img"
      aria-label={`Agent One reacted with ${REACTION_LABELS[reaction.emoji]}`}
      className={`${styles.badge} pointer-events-none absolute -bottom-2.5 right-2 inline-flex h-5 min-w-8 select-none items-center justify-center rounded-full border border-border bg-background px-1.5 text-sm leading-none text-foreground shadow-sm`}
    >
      {reaction.emoji}
    </span>
  );
}
