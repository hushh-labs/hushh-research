import { Suspense } from "react";
import { redirect } from "next/navigation";

import { legacyProfileRouteRedirectHref } from "@/lib/navigation/profile-pane";

import { ProfileRouteClientRedirect } from "./profile-route-client-redirect";

type ProfilePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ProfilePage({ searchParams }: ProfilePageProps) {
  // Search parameters are request state on the web but browser state in the
  // serverless Capacitor bundle: awaiting them during the static export fails
  // the build, and there is no server to redirect from. Inside the bundle the
  // client reads the query and performs the same redirect.
  if (process.env.CAPACITOR_BUILD === "true") {
    return (
      <Suspense fallback={null}>
        <ProfileRouteClientRedirect />
      </Suspense>
    );
  }
  const query = (await searchParams) ?? {};
  redirect(legacyProfileRouteRedirectHref(query));
}
