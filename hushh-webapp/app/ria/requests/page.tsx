import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

export default function RiaRequestsCompatibilityPage() {
  redirect(ROUTES.CONSENTS);
}
