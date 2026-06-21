import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { OneAgentRoster } from "@/components/dashboard/one-agent-roster";
import { type CapabilityStatus } from "@/lib/services/capability-setup-state-service";

function ModeSection({
  title,
  description,
  icon,
  accent,
  modes,
  gridClassName,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  accent: "neutral" | "kai" | "consent";
  modes: OneDashboardMode[];
  gridClassName: string;
}) {
  if (modes.length === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby={`one-section-${title.toLowerCase()}`}
      className="space-y-2"
    >
      <SectionHeader
        id={`one-section-${title.toLowerCase()}`}
        title={title}
        description={description}
        icon={icon}
        accent={accent}
        className="px-0"
        testId={`one-${title.toLowerCase()}-section`}
      />
      <div className={cn("grid gap-2 sm:gap-2.5", gridClassName)}>
        {modes.map((mode) => (
          <ModeTile key={mode.id} mode={mode} />
        ))}
      </div>
    </section>
  );
}

export function OneDashboardPage({
  capabilityStatusById = {},
  displayName,
  userId,
}: {
  displayName?: string | null;
  capabilityStatusById?: Record<string, CapabilityStatus>;
  userId?: string | null;
}) {
  return (
    <AppPageShell
      as="main"
      width="reading"
      fitContent
      className="relative isolate bg-[color:var(--one-launcher-background)]"
      data-one-launcher-root="true"
      nativeTest={{
        routeId: "/one",
        marker: "native-route-one-home",
        authState: "authenticated",
        dataState: "loaded",
      }}
    >
      <AppPageContentRegion>
        <OneAgentRoster
          capabilityStatusById={capabilityStatusById}
          displayName={displayName}
          userId={userId}
        />
      </AppPageContentRegion>
    </AppPageShell>
  );
}
