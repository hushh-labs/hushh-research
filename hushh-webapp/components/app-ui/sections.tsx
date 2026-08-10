// components/app-ui/sections.tsx
// Shared long-form content section kit for public/marketing-style pages
// (Research, Blog, Developers). Modeled on hushh-search-console's
// src/components/one/sections.tsx (Hero/Band/CardGrid/CtaBand/Figure/Stat/
// Steps/Faq composition pattern), re-skinned onto THIS app's own design
// tokens (--app-accent, --app-card-radius-feature, foundation-*) instead of
// search-console's Summer26 palette. Plain server-renderable functions, no
// client state — pages compose them declaratively by stacking JSX.

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { cn } from "@/lib/utils";

export type SectionCta = { label: string; href: string; external?: boolean };

function CtaLink({ cta, primary }: { cta: SectionCta; primary?: boolean }) {
  const className = cn(
    "press-scale inline-flex items-center gap-1.5 rounded-full px-5 py-2.5 text-sm font-semibold transition-colors duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)]",
    primary
      ? "bg-[var(--app-accent)] text-[var(--app-accent-fg)] hover:bg-[var(--app-accent-hover)]"
      : "border border-border/60 bg-transparent text-foreground hover:bg-muted/50",
  );
  if (cta.external) {
    return (
      <a
        href={cta.href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        {cta.label}
      </a>
    );
  }
  return (
    <Link href={cta.href} className={className}>
      {cta.label}
    </Link>
  );
}

/** Top-of-page hero: kicker + title + lede + optional CTAs and side media. */
export function Hero({
  kicker,
  title,
  lede,
  ctas = [],
  media,
  compact = false,
  className,
}: {
  kicker: string;
  title: ReactNode;
  lede: string;
  ctas?: SectionCta[];
  media?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  const head = (
    <>
      <div className="font-[family-name:var(--font-app-body)] text-[15px] font-medium leading-[20px] tracking-[-0.01em] text-[#6E6E73]">
        {kicker}
      </div>
      <h1
        className={cn(
          "mt-3 font-[family-name:var(--font-app-display)] font-semibold leading-[1.08] tracking-tight text-foreground",
          compact
            ? "text-[26px] sm:text-[32px]"
            : media
              ? "text-[28px] sm:text-[36px]"
              : "text-[32px] sm:text-[44px]",
        )}
      >
        {title}
      </h1>
      <p
        className={cn(
          "mt-3 max-w-xl text-[15px] text-foreground/80",
          compact ? "leading-6" : "leading-7",
        )}
      >
        {lede}
      </p>
      {ctas.length > 0 ? (
        <div className="mt-6 flex flex-wrap gap-3">
          {ctas.map((c, i) => (
            <CtaLink key={c.label} cta={c} primary={i === 0} />
          ))}
        </div>
      ) : null}
    </>
  );

  return (
    <div
      className={cn(
        compact
          ? "relative overflow-hidden rounded-[var(--app-card-radius-standard)] border border-border/60 px-4 py-4 sm:px-5 sm:py-5"
          : "relative overflow-hidden rounded-[var(--app-card-radius-feature)] border border-border/60 px-5 py-7 sm:px-8 sm:py-10",
        className,
      )}
    >
      {media ? (
        <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-12">
          <div>{head}</div>
          <div className="mx-auto w-full max-w-sm lg:order-last lg:max-w-none">
            {media}
          </div>
        </div>
      ) : (
        head
      )}
    </div>
  );
}

/** Generic full-width content section: kicker/title/lede + children, optional side media. */
export function Band({
  kicker,
  title,
  lede,
  children,
  media,
  mediaSide = "right",
  id,
  className,
}: {
  kicker?: string;
  title?: ReactNode;
  lede?: string;
  children?: ReactNode;
  media?: ReactNode;
  mediaSide?: "left" | "right";
  id?: string;
  className?: string;
}) {
  const head = (
    <>
      {kicker ? (
        <div className="font-[family-name:var(--font-app-body)] text-[15px] font-medium leading-[20px] tracking-[-0.01em] text-[#6E6E73]">
          {kicker}
        </div>
      ) : null}
      {title ? (
        <h2 className="mt-2 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
          {title}
        </h2>
      ) : null}
      {lede ? (
        <p className="mt-3 max-w-2xl text-[15px] leading-7 text-muted-foreground">
          {lede}
        </p>
      ) : null}
    </>
  );

  return (
    <section id={id} className={cn("scroll-mt-24", className)}>
      {media ? (
        <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-12">
          <div className={mediaSide === "left" ? "lg:order-last" : undefined}>
            {head}
          </div>
          <div className={mediaSide === "left" ? "lg:order-first" : undefined}>
            {media}
          </div>
        </div>
      ) : (
        head
      )}
      {children}
    </section>
  );
}

/** Responsive card grid: 2/3/4 columns. */
export function CardGrid({
  cols = 3,
  children,
  className,
}: {
  cols?: 2 | 3 | 4;
  children: ReactNode;
  className?: string;
}) {
  const colsClassName =
    cols === 4
      ? "sm:grid-cols-2 lg:grid-cols-4"
      : cols === 2
        ? "sm:grid-cols-2"
        : "sm:grid-cols-2 lg:grid-cols-3";
  return (
    <div
      className={cn("mt-6 grid grid-cols-1 gap-4", colsClassName, className)}
    >
      {children}
    </div>
  );
}

/** A single card inside a CardGrid; optionally a link. */
export function Card({
  eyebrow,
  icon,
  title,
  body,
  href,
  cta,
  className,
}: {
  eyebrow?: string;
  icon?: ReactNode;
  title: string;
  body: string;
  href?: string;
  cta?: string;
  className?: string;
}) {
  const content = (
    <>
      {icon ? (
        <div className="mb-3 flex w-11 items-center justify-center rounded-[var(--app-card-radius-feature)] border border-[color:var(--app-accent-border)] bg-[color:var(--app-accent-tint)] p-2.5 text-[color:var(--app-accent-deep)]">
          {icon}
        </div>
      ) : null}
      {eyebrow ? (
        <div className="font-[family-name:var(--font-app-body)] text-[15px] font-medium leading-[20px] tracking-[-0.01em] text-[#6E6E73]">
          {eyebrow}
        </div>
      ) : null}
      <h3 className="mt-1 text-lg font-semibold text-foreground">{title}</h3>
      <p className="mt-1.5 flex-1 text-sm leading-6 text-muted-foreground">
        {body}
      </p>
      {href && cta ? (
        <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-[color:var(--app-accent-deep)]">
          {cta}
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </span>
      ) : null}
    </>
  );

  const shellClassName = cn(
    "group flex flex-col rounded-[var(--app-card-radius-feature)] border border-border/60 bg-card p-5",
    href && "transition-all hover:-translate-y-0.5 hover:shadow-lg",
    className,
  );

  if (href) {
    return (
      <Link href={href} className={shellClassName}>
        {content}
      </Link>
    );
  }
  return <div className={shellClassName}>{content}</div>;
}

/** Centered closing call-to-action band. */
export function CtaBand({
  title,
  lede,
  ctas,
  note,
  className,
}: {
  title: string;
  lede: string;
  ctas: SectionCta[];
  note?: string;
  className?: string;
}) {
  return (
    <section className={cn("py-10 text-center sm:py-14", className)}>
      <div className="mx-auto max-w-2xl">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {title}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-[15px] leading-7 text-muted-foreground">
          {lede}
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          {ctas.map((c, i) => (
            <CtaLink key={c.label} cta={c} primary={i === 0} />
          ))}
        </div>
        {note ? (
          <p className="mx-auto mt-8 max-w-xl text-xs leading-relaxed text-muted-foreground/70">
            {note}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** Framed panel for diagrams/art, with optional caption. */
export function Figure({
  children,
  caption,
  plain = false,
  className,
}: {
  children: ReactNode;
  caption?: ReactNode;
  plain?: boolean;
  className?: string;
}) {
  return (
    <figure className={className}>
      {plain ? (
        children
      ) : (
        <div className="overflow-hidden rounded-[var(--app-card-radius-feature)] border border-border/60 bg-muted/20 p-5 sm:p-7">
          {children}
        </div>
      )}
      {caption ? (
        <figcaption className="mt-3 px-1 text-[13px] leading-relaxed text-muted-foreground">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

/** Metric grid: 2/3/4 columns of Stat. */
export function StatGrid({
  cols = 4,
  children,
  className,
}: {
  cols?: 2 | 3 | 4;
  children: ReactNode;
  className?: string;
}) {
  const colsClassName =
    cols === 4
      ? "grid-cols-2 lg:grid-cols-4"
      : cols === 3
        ? "grid-cols-1 sm:grid-cols-3"
        : "grid-cols-2";
  return (
    <div className={cn("mt-6 grid gap-px", colsClassName, className)}>
      {children}
    </div>
  );
}

export function Stat({
  value,
  label,
  sub,
}: {
  value: ReactNode;
  label: string;
  sub?: string;
}) {
  return (
    <div className="px-2 py-4">
      <div className="text-[32px] font-semibold leading-none tracking-tight text-foreground sm:text-[40px]">
        {value}
      </div>
      <div className="mt-2.5 font-[family-name:var(--font-app-body)] text-[15px] font-medium leading-[20px] tracking-[-0.01em] text-[#6E6E73]">
        {label}
      </div>
      {sub ? (
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {sub}
        </p>
      ) : null}
    </div>
  );
}

/** Numbered step list (01/02/03…). */
export function Steps({
  items,
  className,
}: {
  items: { title: string; body: string }[];
  className?: string;
}) {
  return (
    <div className={cn("mt-6 divide-y divide-border/60", className)}>
      {items.map((step, index) => (
        <div key={step.title} className="flex items-start gap-4 py-5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30 text-sm font-semibold text-foreground">
            {String(index + 1).padStart(2, "0")}
          </div>
          <div>
            <h3 className="text-base font-medium tracking-tight text-foreground">
              {step.title}
            </h3>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              {step.body}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Lightweight FAQ list using native <details> (pair with JSON-LD elsewhere). */
export function Faq({
  items,
  className,
}: {
  items: { question: string; answer: string }[];
  className?: string;
}) {
  return (
    <div className={cn("mt-6 divide-y divide-border/60", className)}>
      {items.map((item) => (
        <details key={item.question} className="group py-4">
          <summary className="-mx-3 -my-1 flex cursor-pointer items-start justify-between gap-4 rounded-2xl px-3 py-1 text-base font-medium tracking-tight text-foreground marker:content-none">
            <span>{item.question}</span>
            <span
              aria-hidden="true"
              className="mt-0.5 shrink-0 text-[color:var(--app-accent-deep)] transition-transform group-open:rotate-45"
            >
              +
            </span>
          </summary>
          <p className="mt-2.5 max-w-2xl text-sm leading-6 text-muted-foreground">
            {item.answer}
          </p>
        </details>
      ))}
    </div>
  );
}
