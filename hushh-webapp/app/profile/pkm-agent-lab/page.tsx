import dynamic from "next/dynamic";
import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

const LocalPkmAgentLabPage =
  process.env.NODE_ENV === "development"
    ? dynamic(() => import("./local-page-client"))
    : null;

export default function PkmAgentLabPage() {
  if (!LocalPkmAgentLabPage) {
    redirect(ROUTES.PKM);
  }

  return <LocalPkmAgentLabPage />;
}
