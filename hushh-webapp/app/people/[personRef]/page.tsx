import { notFound } from "next/navigation";

import { PersonProfilePage } from "@/components/connections/person-profile-page";
import { fetchPythonApi } from "@/app/api/_utils/backend";
import type { PublicPersonProfile } from "@/lib/services/person-profile-service";

const nativeStaticPersonRef =
  process.env.ONE_PERSON_PROFILE_NATIVE_TEST_REF ||
  "00000000-0000-4000-8000-000000000001";

export function generateStaticParams(): Array<{ personRef: string }> {
  return process.env.CAPACITOR_BUILD === "true"
    ? [{ personRef: nativeStaticPersonRef }]
    : [];
}

export default async function PublicPersonProfileRoute({
  params,
}: {
  params: Promise<{ personRef: string }>;
}) {
  const { personRef } = await params;
  if (process.env.CAPACITOR_BUILD === "true") {
    return <PersonProfilePage personRef={personRef} initialProfile={null} />;
  }
  const response = await fetchPythonApi(
    `/api/public/people/${encodeURIComponent(personRef)}`,
    { cache: "no-store", signal: AbortSignal.timeout(15_000) },
  ).catch(() => null);
  if (!response || response.status === 404) notFound();
  if (!response.ok) throw new Error("Person profile is unavailable.");
  const profile = (await response.json()) as PublicPersonProfile;
  return <PersonProfilePage personRef={personRef} initialProfile={profile} />;
}
