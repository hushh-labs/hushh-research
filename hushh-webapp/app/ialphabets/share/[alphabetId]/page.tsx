"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { ROUTES } from "@/lib/navigation/routes";
import type { Metadata } from "next";

export default function ShareAlphabetPage({
  params,
}: {
  params: Promise<{ alphabetId: string }>;
}) {
  const { alphabetId } = use(params);
  const router = useRouter();

  const ogImageUrl = `/api/og/ialphabets/alphabet/${alphabetId}`;

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md text-center">
        <h1 className="mb-4 text-2xl font-bold">My Alphabet</h1>

        {/* Preview of the share card */}
        <div className="mb-6 overflow-hidden rounded-xl border shadow-lg">
          <img
            src={ogImageUrl}
            alt="My iAlphabets picks"
            className="w-full"
          />
        </div>

        {/* Share actions */}
        <div className="flex justify-center gap-3">
          <button
            onClick={() => {
              if (typeof navigator !== "undefined" && navigator.share) {
                navigator.share({
                  title: "My iAlphabets picks",
                  text: "Check out my A-Z stock picks!",
                  url: window.location.href,
                });
              } else {
                navigator.clipboard.writeText(window.location.href);
              }
            }}
            className="rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
          >
            Share
          </button>
          <button
            onClick={() => router.push(ROUTES.IALPHABETS_HOME)}
            className="rounded-lg border px-6 py-2.5 text-sm font-medium transition hover:bg-muted"
          >
            Back
          </button>
        </div>
      </div>
    </div>
  );
}
