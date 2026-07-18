import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

type LegacyConsentSearchParams = Record<string, string | string[] | undefined>;

/** Preserve legacy deep links while keeping the access manager inside One. */
export default async function LegacyConsentsPage({
  searchParams,
}: {
  searchParams: Promise<LegacyConsentSearchParams>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, item);
    } else if (value) {
      query.set(key, value);
    }
  }

  const serialized = query.toString();
  redirect(serialized ? `${ROUTES.CONSENTS}?${serialized}` : ROUTES.CONSENTS);
}
