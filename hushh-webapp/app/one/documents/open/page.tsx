import { Suspense } from "react";
import { HostedDocumentsPage } from "@/components/consent/hosted-documents-page";
import { RouteSuspenseFallback } from "@/components/system/route-suspense-fallback";
export default function ProtectedDocumentsPage() {
  return <Suspense fallback={<RouteSuspenseFallback label="Loading protected documents…" />}><HostedDocumentsPage /></Suspense>;
}
