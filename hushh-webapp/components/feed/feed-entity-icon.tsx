"use client";
import { useState, type ComponentType } from "react";
import Image from "next/image";
/** Brand art is local to Feed; all other rows keep their meaningful source icon. */
export function FeedEntityIcon({ icon: Icon, symbol }: { icon: ComponentType<{ className?: string; color?: string }>; symbol?: string }) {
  const [failed, setFailed] = useState(false);
  return <span data-slot="feed-domain-icon" aria-hidden="true" className="grid size-[22px] shrink-0 place-items-center text-[color:var(--app-label)] [&_svg]:size-[22px]">
    {symbol?.toUpperCase() === "AAPL" && !failed ? <Image src="/feed/apple.svg" alt="" width={20} height={20} onError={() => setFailed(true)} /> : <Icon className="size-[22px]" />}
  </span>;
}
