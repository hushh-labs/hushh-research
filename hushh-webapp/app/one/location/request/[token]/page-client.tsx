"use client";

import { useEffect, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { publicLocationViewPath } from "@/lib/one-location/public-invite-url";

/**
 * Forwards a legacy `/one/location/request/<token>` link to its new home.
 *
 * `replace`, not `push`: the old path is not a place anyone should be able to
 * go back to, and leaving it in history would make the browser's Back button
 * bounce between the two paths.
 *
 * A token that is missing or empty gets the Location hub rather than
 * `/one/location/view/` with nothing after it — that would resolve to a page
 * whose only possible outcome is "this link is invalid", which is a worse
 * answer than the screen the person can actually act on.
 */
export default function LegacyPublicLocationRequestRedirect() {
  const params = useParams<{ token?: string }>();
  const router = useRouter();
  const token = useMemo(
    () => String(params?.token || "").trim(),
    [params?.token],
  );

  useEffect(() => {
    router.replace(token ? publicLocationViewPath(token) : "/one/location");
  }, [router, token]);

  return <HushhLoader label="Opening shared location..." />;
}
