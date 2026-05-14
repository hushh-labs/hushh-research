"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import MarketplaceRiaProfilePageClient from "./page-client";

function RiaProfileContent() {
  const searchParams = useSearchParams();
  const riaId = (searchParams.get("riaId") || "").trim();
  
  return <MarketplaceRiaProfilePageClient riaId={riaId} />;
}

export default function MarketplaceRiaProfilePage() {
  return (
    <Suspense fallback={<div>Loading RIA profile...</div>}>
      <RiaProfileContent />
    </Suspense>
  );
}
