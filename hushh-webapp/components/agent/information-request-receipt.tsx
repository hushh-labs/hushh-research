"use client";

type ReviewField = { requestId?: string | null; label: string };

/** Preserve request purpose/status without secondary detour links. */
export function InformationRequestReceipt({ purpose, statusText }: {
  purpose: string; statusText: string; submitted?: boolean; fields?: ReviewField[];
}) {
  return <>
      <p className="text-sm leading-6 text-foreground">{purpose}</p>
      <p role="status" className="mt-2 text-xs font-medium text-muted-foreground">{statusText}</p>
  </>;
}
