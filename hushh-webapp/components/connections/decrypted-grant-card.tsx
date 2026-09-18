"use client";

import React, { useState } from "react";
import {
  Check,
  Code2,
  Copy,
  Layers,
  Lock,
  MapPin,
  ShieldCheck,
  TrendingUp,
} from "@/components/icons";
import { toast } from "sonner";

import { cn } from "@/lib/utils";

type DecryptedGrantCardProps = {
  grant: {
    scopeRef?: string | null;
    requestId?: string | null;
    label: string;
    domain?: string | null;
    status?: string | null;
    expiresAt?: string | number | null;
  };
  decryptedData?: Record<string, unknown> | null;
  isVaultUnlocked: boolean;
  isDecrypting: boolean;
  onUnlockVault: () => void;
  onRevealManual?: () => void;
};

/**
 * Transforms raw machine/schema labels into human-friendly Apple titles.
 * e.g. "Attr.Developer.Stack.Tooling And Testing. Items"
 *   -> { title: "Tooling & Testing", overline: "DEVELOPER · ENGINEERING STACK" }
 */
function formatHumanTitle(
  rawLabel: string,
  rawDomain?: string | null,
): { title: string; overline: string } {
  const fallbackDomain = (rawDomain || "Personal").toUpperCase();

  let cleaned = rawLabel
    .replace(/^attr\./i, "")
    .replace(/^sources\s+/i, "")
    .trim();

  if (cleaned.includes(".")) {
    const rawParts = cleaned
      .split(".")
      .map((p) => p.trim())
      .filter(Boolean);
    const meaningful = rawParts.filter(
      (p) => !/^items$/i.test(p) && !/^canonical/i.test(p) && !/^v\d+$/i.test(p),
    );

    const domainPart = rawParts[0] || fallbackDomain;
    const leaf = meaningful[meaningful.length - 1] || cleaned;
    const middleParts = meaningful.slice(1, -1);

    const overlineParts = [domainPart.toUpperCase()];
    if (middleParts.length > 0) {
      overlineParts.push(middleParts.join(" · ").toUpperCase());
    }

    // Clean leaf into human title
    let humanTitle = leaf
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\band\b/gi, "&")
      .replace(/_/g, " ");

    return {
      title: humanTitle,
      overline: overlineParts.join(" · "),
    };
  }

  // Handle space-separated schema paths (e.g. "Sources Statement Snapshots Items Canonical V2 Holdings...")
  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => !/^(items|canonical|v\d+|is)$/i.test(t));
  if (tokens.length > 3) {
    return {
      title: tokens.slice(-2).join(" "),
      overline: `${fallbackDomain} · ${tokens.slice(0, 2).join(" ").toUpperCase()}`,
    };
  }

  return {
    title: cleaned.replace(/_/g, " "),
    overline: fallbackDomain,
  };
}

function resolveDomainVisuals(domain?: string | null) {
  const d = String(domain || "").toLowerCase();
  if (d.includes("dev") || d.includes("tech") || d.includes("stack") || d.includes("tool")) {
    return {
      icon: <Code2 className="h-5 w-5 text-sky-500" />,
      gradient: "from-sky-500/15 to-indigo-500/15 border-sky-500/20 text-sky-600 dark:text-sky-400",
    };
  }
  if (d.includes("finan") || d.includes("hold") || d.includes("wealth") || d.includes("invest")) {
    return {
      icon: <TrendingUp className="h-5 w-5 text-emerald-500" />,
      gradient: "from-emerald-500/15 to-teal-500/15 border-emerald-500/20 text-emerald-600 dark:text-emerald-400",
    };
  }
  if (d.includes("loc") || d.includes("place") || d.includes("map")) {
    return {
      icon: <MapPin className="h-5 w-5 text-amber-500" />,
      gradient: "from-amber-500/15 to-orange-500/15 border-amber-500/20 text-amber-600 dark:text-amber-400",
    };
  }
  if (d.includes("ident") || d.includes("prof") || d.includes("kyc")) {
    return {
      icon: <ShieldCheck className="h-5 w-5 text-violet-500" />,
      gradient: "from-violet-500/15 to-purple-500/15 border-violet-500/20 text-violet-600 dark:text-violet-400",
    };
  }
  return {
    icon: <Layers className="h-5 w-5 text-blue-500" />,
    gradient: "from-blue-500/15 to-sky-500/15 border-blue-500/20 text-blue-600 dark:text-blue-400",
  };
}

/**
 * Elegantly presents structured decrypted records without raw JSON dumps or nested boxes.
 */
function DecryptedRecordContent({ data }: { data: Record<string, unknown> }) {
  // Extract summary/headline if present
  const summary = typeof data.summary === "string" ? data.summary : null;
  const description = typeof data.description === "string" ? data.description : null;
  const headline = summary || description;

  // Collect array pills or nested values
  const tagSections: { label: string; tags: string[] }[] = [];
  const kvPairs: { key: string; val: string }[] = [];

  const inspectLevel = (obj: Record<string, unknown>, prefix = "") => {
    for (const [key, val] of Object.entries(obj)) {
      if (key === "summary" || key === "description") continue;
      const displayKey = prefix ? `${prefix} · ${key}` : key;

      if (Array.isArray(val)) {
        const stringTags = val.map(String).filter(Boolean);
        if (stringTags.length > 0) {
          tagSections.push({
            label: displayKey.replace(/_/g, " "),
            tags: stringTags,
          });
        }
      } else if (typeof val === "object" && val !== null) {
        inspectLevel(val as Record<string, unknown>, displayKey);
      } else if (val !== null && val !== undefined) {
        kvPairs.push({
          key: displayKey.replace(/_/g, " "),
          val: String(val),
        });
      }
    }
  };

  inspectLevel(data);

  return (
    <div className="space-y-4" data-testid="person-profile-grant-value">
      {/* Headline / Summary */}
      {headline ? (
        <div className="space-y-1">
          <p className="text-base sm:text-lg font-semibold tracking-tight text-foreground/95">
            {headline}
          </p>
        </div>
      ) : null}

      {/* Tag Collections (e.g. skills, tech stack, interests) */}
      {tagSections.map((sec, idx) => (
        <div key={idx} className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
            {sec.label}
          </p>
          <div className="flex flex-wrap gap-2">
            {sec.tags.map((tag, tIdx) => (
              <span
                key={tIdx}
                className="inline-flex items-center rounded-full border border-black/[0.07] bg-black/[0.03] px-3.5 py-1 text-xs font-medium text-foreground transition-[background-color,border-color] duration-150 hover:bg-black/[0.06] dark:border-white/[0.1] dark:bg-white/[0.06] dark:hover:bg-white/[0.1]"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      ))}

      {/* Key-Value Attributes */}
      {kvPairs.length > 0 ? (
        <div className="grid gap-2.5 sm:grid-cols-2 pt-1">
          {kvPairs.map((item, idx) => (
            <div
              key={idx}
              className="flex items-center justify-between rounded-xl bg-muted/40 px-3 py-2 text-xs"
            >
              <span className="text-muted-foreground capitalize font-medium">
                {item.key}
              </span>
              <span className="font-semibold text-foreground">{item.val}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function DecryptedGrantCard({
  grant,
  decryptedData,
  isVaultUnlocked,
  isDecrypting,
  onUnlockVault,
  onRevealManual,
}: DecryptedGrantCardProps) {
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  const { title, overline } = formatHumanTitle(grant.label, grant.domain);
  const visuals = resolveDomainVisuals(grant.domain);

  const handleCopy = () => {
    if (!decryptedData) return;
    void navigator.clipboard.writeText(JSON.stringify(decryptedData, null, 2));
    setCopied(true);
    toast.success("Record copied to clipboard.");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <article
      className="group relative flex flex-col justify-between overflow-hidden rounded-2xl sm:rounded-3xl border border-black/[0.08] bg-card/80 p-5 sm:p-6 shadow-[0_2px_16px_rgba(0,0,0,0.03)] backdrop-blur-xl transition-[border-color,box-shadow] duration-150 ease-out hover:border-black/[0.14] hover:shadow-[0_6px_28px_rgba(0,0,0,0.06)] dark:border-white/[0.08] dark:bg-card/50 dark:hover:border-white/[0.15]"
      data-testid={`grant-card-${grant.requestId || grant.scopeRef}`}
    >
      <div>
        {/* Top Header: Cupertino Squircle Icon, Human Title & Overline, Living Status Badge */}
        <div className="flex items-start justify-between gap-4 pb-4">
          <div className="flex items-center gap-3.5 min-w-0">
            <div
              className={cn(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border shadow-2xs transition-transform duration-150 ease-out group-hover:scale-105",
                visuals.gradient,
              )}
            >
              {visuals.icon}
            </div>

            <div className="min-w-0">
              <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                {overline}
              </span>
              <h3 className="truncate text-base sm:text-lg font-bold tracking-tight text-foreground">
                {title}
              </h3>
            </div>
          </div>

          {/* Living Breathing Status Indicator */}
          <div className="shrink-0">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <span>Active grant</span>
            </div>
          </div>
        </div>

        {/* Body Content */}
        <div className="py-2">
          {decryptedData ? (
            showRaw ? (
              <pre
                className="max-h-64 overflow-auto rounded-2xl bg-muted/50 p-4 font-mono text-xs text-foreground/90 leading-relaxed"
                data-testid="person-profile-grant-value"
              >
                {JSON.stringify(decryptedData, null, 2)}
              </pre>
            ) : (
              <DecryptedRecordContent data={decryptedData} />
            )
          ) : isDecrypting ? (
            <div className="flex items-center gap-3 py-4 text-xs font-medium text-muted-foreground">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span>Opening zero-knowledge envelope…</span>
            </div>
          ) : isVaultUnlocked ? (
            <div className="flex items-center justify-between py-3">
              <span className="text-xs text-muted-foreground">
                Encrypted record ready.
              </span>
              {onRevealManual ? (
                <button
                  type="button"
                  onClick={onRevealManual}
                  data-testid="person-profile-grant-reveal"
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
                >
                  Decrypt record
                </button>
              ) : null}
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-2xl bg-muted/40 p-3.5">
              <div className="flex items-center gap-2.5 text-xs font-medium text-muted-foreground">
                <Lock className="h-4 w-4 text-amber-500" />
                <span>Encrypted under your private BYOK key</span>
              </div>
              <button
                type="button"
                onClick={onUnlockVault}
                className="rounded-full bg-primary px-3.5 py-1 text-xs font-semibold text-primary-foreground shadow-xs hover:bg-primary/90"
              >
                Unlock
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Hairline Footer with Discreet Utilities */}
      {decryptedData ? (
        <div className="mt-4 flex items-center justify-between border-t border-border/40 pt-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
            <span>Zero-knowledge verified</span>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowRaw(!showRaw)}
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium text-muted-foreground/80 transition-[background-color,color] duration-150 hover:bg-muted hover:text-foreground"
              title={showRaw ? "Show formatted view" : "View raw JSON payload"}
            >
              <Code2 className="h-3.5 w-3.5" />
              <span>{showRaw ? "Formatted" : "JSON"}</span>
            </button>

            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium text-muted-foreground/80 transition-[background-color,color] duration-150 hover:bg-muted hover:text-foreground"
              title="Copy to clipboard"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
