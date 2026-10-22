"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { LiveMirrorPreview } from "@/components/profile/live-mirror-preview";
import { ROUTES } from "@/lib/navigation/routes";

/** Explanations around the existing memory and connector permission owners. */
export function OneAccessOverview({ onNavigate, children, expanded = true }: { onNavigate: () => void; children: ReactNode; expanded?: boolean }) {
  return (
    <section aria-label={expanded ? "What One can access" : undefined} className={expanded ? "mb-6 space-y-5 text-sm" : "contents"}>
      {expanded ? <div className="space-y-2">
        <h3 className="font-semibold">What One knows</h3>
        <p className="text-muted-foreground">
          Saved memory is encrypted. When you ask One, your unlocked memory can
          be used to answer. Open Memory to review, edit, or delete what is saved.
        </p>
        <LiveMirrorPreview onNavigate={onNavigate} />
      </div> : null}
      <div className={expanded ? "space-y-2" : "contents"}>
        {expanded ? <h3 className="font-semibold">What One can use</h3> : null}
        {expanded ? <p className="text-muted-foreground">
          Review connected apps and their permissions below. Use Disconnect to
          stop new access. Disconnecting does not delete
          information already saved in Memory or end separate sharing permissions.
        </p> : null}
        {children}
      </div>
      {expanded ? <div className="space-y-2">
        <h3 className="font-semibold">Sharing with others</h3>
        <p className="text-muted-foreground">
          Sharing permissions are separate from connected apps. Review who can
          access your information and stop sharing in Consent.
        </p>
        <Link href={ROUTES.CONSENTS} onClick={onNavigate}
          className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4">
          Review sharing permissions
        </Link>
      </div> : null}
      {expanded ? <div className="space-y-2">
        <h3 className="font-semibold">Your device</h3>
        <p className="text-muted-foreground">
          Microphone access lets you talk to One. Location access supports location
          features, and contacts help you find people. These features ask for
          permission when you use them. Change device permissions in your browser
          or phone settings. Opening this panel requests no device permissions.
        </p>
      </div> : null}
    </section>
  );
}
