"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { CIRCLE_JOIN_CODE_PARAM } from "@/lib/one-location/circle-join-url";

/**
 * Recipient landing for a shared Circle join link (`/circle/join?code=…`).
 * Forwards into the in-app "Join with code" flow with the code pre-filled, so a
 * recipient can tap the link instead of copy-pasting the raw code. A client
 * redirect keeps this working for both the web SSR build and the Capacitor
 * static export.
 */
function CircleJoinRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const code = (searchParams.get(CIRCLE_JOIN_CODE_PARAM) ?? "").trim();
    const query = new URLSearchParams({ action: "join-circle" });
    if (code) query.set(CIRCLE_JOIN_CODE_PARAM, code);
    router.replace(`/one/location?${query.toString()}`);
  }, [router, searchParams]);

  return null;
}

export default function CircleJoinPage() {
  return (
    <Suspense fallback={null}>
      <CircleJoinRedirect />
    </Suspense>
  );
}
