import type { ReactNode } from "react";
import type { AgentStructuredExperience } from "@/lib/agent/agui-structured-experiences";

export function ExperienceShell({
  experienceType,
  label,
  title,
  summary,
  icon,
  children,
}: {
  experienceType: AgentStructuredExperience["type"];
  label: string;
  title: string;
  summary: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  const isConsentReview = ["one.information_request_review.v1", "one.document_request_review.v1", "one.drive_share_review.v1", "one.drive_bulk_share_review.v1"].includes(experienceType);
  return (
    <section data-experience-type={experienceType} className={`${isConsentReview ? "consent-presentation-surface " : ""}overflow-hidden rounded-[24px] border border-black/[0.08] bg-[color:var(--app-surface)] shadow-[0_14px_38px_-28px_rgba(15,23,42,0.16)] dark:border-white/[0.10]`}>
      <header className="flex items-start gap-3 px-4 pb-4 pt-4 sm:px-5 sm:pt-5">
        {/* /one iconography: a bare duotone glyph on a transparent well. A
            registry capability glyph keeps its own colour; a utility glyph
            takes the accent. Never a filled tile with a white glyph. */}
        <span data-slot="card-header-icon" className="inline-flex h-10 w-10 shrink-0 items-center justify-center text-accent-strong">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="ui-text-section-label text-muted-foreground">{label}</p>
          <h3 data-consent-role="row-title" className="mt-1 text-base font-semibold tracking-[-0.015em] text-foreground">{title}</h3>
          {summary ? <p data-consent-role="body" className="mt-1 text-sm leading-5 text-muted-foreground">{summary}</p> : null}
        </div>
      </header>
      <div className="border-t border-black/[0.06] bg-background/80 px-4 py-4 backdrop-blur-xl dark:border-white/[0.08] sm:px-5">{children}</div>
    </section>
  );
}
