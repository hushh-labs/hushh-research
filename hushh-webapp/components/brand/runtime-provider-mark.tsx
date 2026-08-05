import Image from "next/image";

import { GeminiLogo } from "@/components/brand/gemini-logo";
import type { RuntimeProviderCatalogEntry } from "@/lib/connections/runtime-provider-catalog";
import { cn } from "@/lib/utils";

const PROVIDER_MARKS: Record<
  Exclude<RuntimeProviderCatalogEntry["id"], "gemini">,
  { src: string; className?: string }
> = {
  openai: { src: "/brand/providers/openai.svg", className: "dark:invert" },
  anthropic: { src: "/brand/providers/claude.svg" },
  grok: { src: "/brand/providers/grok.svg", className: "dark:invert" },
  meta_muse_spark: { src: "/brand/providers/meta.svg" },
};

/**
 * A fixed, accessible provider mark for presentation-only catalog surfaces.
 *
 * Provider artwork is deliberately separate from runtime configuration. Every
 * mark is an unmodified source asset recorded in the provider brand inventory;
 * it never grants access or changes runtime routing.
 */
export function RuntimeProviderMark({
  provider,
  className,
}: {
  provider: RuntimeProviderCatalogEntry;
  className?: string;
}) {
  if (provider.id === "gemini") {
    return <GeminiLogo title={provider.name} className={className} />;
  }

  const mark = PROVIDER_MARKS[provider.id];
  return (
    <span
      aria-label={provider.name}
      role="img"
      className={cn(
        "inline-flex h-12 w-12 shrink-0 items-center justify-center",
        className,
      )}
    >
      <Image
        src={mark.src}
        alt=""
        aria-hidden="true"
        width={48}
        height={48}
        className={cn("max-h-full max-w-full object-contain", mark.className)}
      />
    </span>
  );
}
