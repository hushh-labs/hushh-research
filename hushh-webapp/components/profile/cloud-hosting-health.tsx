import { SettingsRow } from "@/components/profile/settings-ui";
import type { HostingInspection } from "@/lib/services/personal-agent-hosting";

/** Evidence-only presentation; repair and deletion keep their own controls. */
export function CloudHostingHealth({
  inspection,
}: {
  inspection: HostingInspection | null;
}) {
  if (!inspection) return null;
  return (
    <>
      {
        <SettingsRow
          title="Cloud health"
          description={
            inspection.status === "connected"
              ? "Your agent’s cloud resources are available."
              : inspection.status === "starting"
                ? "Your agent is starting."
                : inspection.status === "absent"
                  ? "Your cloud reports this agent is missing. Review Hosting recovery before creating another."
                  : inspection.status === "cleanup_pending"
                    ? "Cloud removal is paused or in progress. Resume its reviewed request."
                    : "Your cloud could not be verified. Nothing was changed."
          }
        />
      }
      {inspection?.needsPreviousReview ? (
        <SettingsRow
          title="Previous cloud homes"
          description="An earlier cloud may still hold resources. Review those resources before removing hosting; this check never deletes them automatically."
        />
      ) : null}
    </>
  );
}
