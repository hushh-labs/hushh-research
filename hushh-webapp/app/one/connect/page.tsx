import { Suspense } from "react";

import ConnectPageClient from "@/app/connect/page-client";

export default function ConnectPage() {
  return (
    <Suspense fallback={null}>
      <ConnectPageClient />
    </Suspense>
  );
}
