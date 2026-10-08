import { updateProgressStage, type AgentUpdateStatus } from "@/lib/feed/agent-update-status";

const STAGES = [
  "Scheduled",
  "Finishing current work",
  "Installing",
  "Restarting and verifying",
] as const;

/** A milestone bar: segment length does not imply elapsed time or an ETA. */
export function AgentUpdateProgress({ update }: { update: AgentUpdateStatus }) {
  const stage = updateProgressStage(update);
  if (stage === null) return null;

  const label = stage === STAGES.length ? "Installation verified" : STAGES[stage];
  return (
    <span className="block space-y-2" role="status" aria-label={`Software update: ${label}`}>
      <span className="grid grid-cols-4 gap-1" aria-hidden="true">
        {STAGES.map((name, index) => (
          <span
            key={name}
            className={`h-1.5 rounded-full ${index < stage
              ? "bg-[var(--app-success)]"
              : index === stage
                ? "bg-[var(--app-accent)] motion-safe:animate-pulse"
                : "bg-foreground/15"}`}
          />
        ))}
      </span>
      <span className="block text-xs text-muted-foreground">{label}</span>
    </span>
  );
}
