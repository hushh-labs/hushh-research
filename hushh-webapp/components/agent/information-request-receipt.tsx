"use client";
import Link from "next/link";
/** Preserve request purpose/status alongside human sharing review links. */
export function InformationRequestReceipt({ purpose, statusText, submitted, fields }: {
  purpose: string; statusText: string; submitted: boolean; fields: Array<{ requestId?: string | null; label: string }>;
}) {
  return <>
      <p className="text-sm leading-6 text-foreground">{purpose}</p>
      <p role="status" className="mt-2 text-xs font-medium text-muted-foreground">{statusText}</p>
      {submitted ? <div className="mt-2 flex flex-wrap gap-3">{fields.filter(field => field.requestId && /^[A-Za-z0-9_-]{1,128}$/.test(field.requestId)).map(field => <Link key={field.requestId} href={`/one/consent?commerceRequestId=${encodeURIComponent(field.requestId!)}`} className="inline-flex min-h-11 items-center text-sm underline">Review request for {field.label}</Link>)}</div> : null}
  </>;
}
