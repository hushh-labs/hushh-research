"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  FileCheck2,
  FolderLock,
  Link2,
  LockKeyhole,
  ShieldCheck,
  UserRound,
} from "lucide-react";

import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import type {
  AgentStructuredExperience,
  EvidenceBriefExperience,
  InformationRequestReviewExperience,
  KycReadinessExperience,
  MemoryImportReviewExperience,
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
    case "one.information_request_review.v1":
      return <InformationRequestReviewView experience={experience} />;
    case "one.kyc_readiness.v1":
      return <KycReadinessView experience={experience} />;
    case "one.memory_import_review.v1":
      return <MemoryImportReviewView experience={experience} />;
    case "one.evidence_brief.v1":
      return <EvidenceBriefView experience={experience} />;
  }
}

function ExperienceShell({
  label,
  title,
  summary,
  icon,
  children,
}: {
  label: string;
  title: string;
  summary: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[24px] bg-[linear-gradient(145deg,var(--app-accent-surface),color-mix(in_srgb,var(--background)_94%,var(--app-accent-soft)))] shadow-[0_18px_55px_-38px_var(--app-accent-deep)]">
      <header className="flex items-start gap-3 px-4 pb-4 pt-4 sm:px-5 sm:pt-5">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-accent-strong text-white shadow-sm">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="ui-text-section-label text-accent-strong">{label}</p>
          <h3 className="mt-1 text-base font-semibold tracking-[-0.015em] text-foreground">{title}</h3>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">{summary}</p>
        </div>
      </header>
      <div className="bg-background/72 px-4 py-4 backdrop-blur-xl sm:px-5">{children}</div>
    </section>
  );
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
      className="space-y-4"
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
              <ul className="divide-y divide-border/35">
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

function InformationRequestReviewView({ experience }: { experience: InformationRequestReviewExperience }) {
  return (
    <ExperienceShell
      label="Consent review"
      title={`Request from ${experience.personName}`}
      summary={`${experience.fields.length} fields · ${experience.durationLabel}`}
      icon={<ShieldCheck className="h-5 w-5" aria-hidden="true" />}
    >
      <p className="text-sm leading-6 text-foreground">{experience.purpose}</p>
      <ul className="mt-3 divide-y divide-border/35">
        {experience.fields.map((field) => (
          <li key={`${field.domain}:${field.label}`} className="flex items-center justify-between gap-3 py-2.5">
            <span><span className="text-sm font-medium text-foreground">{field.label}</span><span className="ml-2 text-xs text-muted-foreground">{field.domain}</span></span>
            <span className="text-xs font-medium text-accent-strong">{sensitivityLabel(field.sensitivity) || "Standard"}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs font-medium text-muted-foreground">{experience.status.replace(/_/g, " ")}</p>
    </ExperienceShell>
  );
}

const KYC_STATUS_LABEL: Record<KycReadinessExperience["items"][number]["status"], string> = {
  available: "Available",
  ask_first: "Ask first",
  verify: "Verify",
  not_available: "Not available",
};

function KycReadinessView({ experience }: { experience: KycReadinessExperience }) {
  return (
    <ExperienceShell label="Readiness" title={experience.workflowName} summary={experience.summary} icon={<FileCheck2 className="h-5 w-5" aria-hidden="true" />}>
      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">For {experience.subjectName}</p>
      <ul className="divide-y divide-border/35">
        {experience.items.map((item) => (
          <li key={`${item.domain}:${item.label}`} className="flex items-center justify-between gap-3 py-2.5">
            <div><p className="text-sm font-medium text-foreground">{item.label}</p><p className="text-xs text-muted-foreground">{item.domain}</p></div>
            <span className={item.status === "available" ? "text-xs font-semibold text-emerald-600" : "text-xs font-semibold text-accent-strong"}>{KYC_STATUS_LABEL[item.status]}</span>
          </li>
        ))}
      </ul>
      {experience.legalReviewRequired ? <p className="mt-3 flex gap-2 text-xs leading-5 text-muted-foreground"><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />Employment authorization and visa eligibility require qualified human review.</p> : null}
    </ExperienceShell>
  );
}

function MemoryImportReviewView({ experience }: { experience: MemoryImportReviewExperience }) {
  const complete = experience.sourceBlockCount === experience.accountedBlockCount;
  const total = experience.groups.reduce((count, group) => count + group.candidates.length, 0);
  return (
    <ExperienceShell label="Memory review" title={`${total} memories ready to review`} summary={`${experience.accountedBlockCount} of ${experience.sourceBlockCount} source sections accounted for`} icon={<FolderLock className="h-5 w-5" aria-hidden="true" />}>
      <p className={complete ? "mb-3 flex items-center gap-2 text-xs font-semibold text-emerald-600" : "mb-3 flex items-center gap-2 text-xs font-semibold text-destructive"}>{complete ? <Check className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}{complete ? "Complete coverage" : "Review required before saving"}</p>
      <div className="space-y-4">
        {experience.groups.map((group) => <section key={group.domain}><h4 className="ui-text-section-label text-muted-foreground">{group.domain}</h4><ul className="mt-1 divide-y divide-border/35">{group.candidates.map((candidate) => <li key={candidate.candidateRef} className="py-2.5"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium text-foreground">{candidate.label}</p><p className="mt-0.5 text-xs leading-5 text-muted-foreground">{candidate.preview}</p></div><span className="shrink-0 text-[11px] font-semibold text-accent-strong">{candidate.sharingPosture.replace("_", " ")}</span></div></li>)}</ul></section>)}
      </div>
    </ExperienceShell>
  );
}

function EvidenceBriefView({ experience }: { experience: EvidenceBriefExperience }) {
  return (
    <ExperienceShell label={`${experience.confidence} confidence`} title={experience.title} summary={experience.summary} icon={<Link2 className="h-5 w-5" aria-hidden="true" />}>
      <ul className="space-y-3">{experience.findings.map((finding) => <li key={finding.label}><p className="text-sm font-semibold text-foreground">{finding.label}</p><p className="mt-0.5 text-sm leading-5 text-muted-foreground">{finding.detail}</p></li>)}</ul>
      {experience.sources.length ? <div className="mt-4 flex flex-wrap gap-2">{experience.sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full bg-accent-surface px-3 py-1.5 text-xs font-semibold text-accent-strong hover:bg-accent-soft">{source.label}<ArrowUpRight className="h-3 w-3" /></a>)}</div> : null}
      {experience.unresolved.length ? <div className="mt-4"><p className="ui-text-section-label text-muted-foreground">Still unresolved</p><ul className="mt-1 space-y-1 text-xs leading-5 text-muted-foreground">{experience.unresolved.map((item) => <li key={item}>• {item}</li>)}</ul></div> : null}
    </ExperienceShell>
  );
}
