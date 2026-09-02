import { PersonProfilePage } from "@/components/connections/person-profile-page";

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
  return <PersonProfilePage personRef={personRef} initialProfile={null} />;
}
