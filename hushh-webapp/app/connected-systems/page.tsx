import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

export default function LegacyConnectedSystemsPage() {
  redirect(ROUTES.CONNECTED_SYSTEMS);
}
