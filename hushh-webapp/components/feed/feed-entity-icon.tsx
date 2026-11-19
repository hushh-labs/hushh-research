"use client";

import type { ComponentType } from "react";
import { getCompanyLogoUrl, SymbolAvatar } from "@/components/kai/shared/symbol-avatar";

/** Feed uses bundled brand art without disclosing viewed tickers to a logo provider. */
export function FeedEntityIcon({ icon: Icon, symbol }: {
  icon: ComponentType<{ className?: string; color?: string }>;
  symbol?: string;
}) {
  const hasBrand = symbol && getCompanyLogoUrl({ symbol, localOnly: true });
  return (
    <span data-slot="feed-domain-icon" aria-hidden="true" className="grid size-[22px] shrink-0 place-items-center text-[color:var(--app-label)] [&_svg]:size-[22px]">
      {symbol && hasBrand ? (
        <SymbolAvatar symbol={symbol} localOnly size="sm" className="size-[22px] [&_img]:size-4" />
      ) : (
        <Icon className="size-[22px]" />
      )}
    </span>
  );
}
