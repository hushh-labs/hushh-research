"use client";

import Link from "next/link";
import { ArrowUpRight, LockKeyhole, UserRound } from "lucide-react";

import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import type {
  AgentStructuredExperience,
  ScopeDiscoveryExperience,
} from "@/lib/agent/agui-structured-experiences";

export function AgentStructuredExperienceView({
  experience,
}: {
  experience: AgentStructuredExperience;
}) {
  switch (experience.type) {
    case "one.scope_discovery.v1":
      return <ScopeDiscoveryView experience={experience} />;
  }
}

function sensitivityLabel(
  sensitivity: ScopeDiscoveryExperience["scopes"][number]["sensitivity"],
): string | null {
  if (sensitivity === "restricted") return "Highly sensitive";
  if (sensitivity === "sensitive") return "Sensitive";
  return null;
}

function ScopeDiscoveryView({
  experience,
}: {
  experience: ScopeDiscoveryExperience;
}) {
  const groups = experience.scopes.reduce<
    Array<{ domain: string; scopes: ScopeDiscoveryExperience["scopes"] }>
  >((current, scope) => {
    const existing = current.find((group) => group.domain === scope.domain);
    if (existing) {
      existing.scopes.push(scope);
      return current;
    }
    current.push({ domain: scope.domain, scopes: [scope] });
    return current;
  }, []);

  return (
    <section
      aria-label={`Information available from ${experience.person.displayName}`}
      className="space-y-4 border-y border-border/55 py-4"
    >
      <header className="flex items-start gap-3 px-1">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-accent-surface text-accent-strong">
          <UserRound className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">
            Available from {experience.person.displayName}
          </h3>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {experience.scopes.length === 0
              ? "No information is currently available to request."
              : `${experience.scopes.length} ${experience.scopes.length === 1 ? "field" : "fields"} can be reviewed before asking for access.`}
          </p>
        </div>
      </header>

      {groups.length > 0 ? (
        <div className="space-y-4 px-1">
          {groups.map((group) => (
            <section key={group.domain} aria-label={group.domain}>
              <h4 className="ui-text-section-label pb-1.5 text-muted-foreground">
                {group.domain}
              </h4>
              <ul className="divide-y divide-border/50 border-y border-border/50">
                {group.scopes.map((scope) => {
                  const sensitivity = sensitivityLabel(scope.sensitivity);
                  return (
                    <li key={scope.scopeRef} className="py-2.5 first:pt-2 last:pb-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground">
                            {scope.label}
                          </p>
                          {scope.description ? (
                            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                              {scope.description}
                            </p>
                          ) : null}
                        </div>
                        {sensitivity ? (
                          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-muted-foreground">
                            <LockKeyhole className="h-3 w-3" aria-hidden="true" />
                            {sensitivity}
                          </span>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      ) : null}

      <div className="flex justify-start px-1">
        <MorphyButton asChild size="sm">
          <Link href={experience.person.profilePath}>
            Review information
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </MorphyButton>
      </div>
    </section>
  );
}
