"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { PkmNaturalPanel } from "@/components/profile/pkm-natural-panel";
import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";

function LocationMemoryDetail() {
  const searchParams = useSearchParams();
  return <PkmNaturalPanel view="location-detail" locationMemoryId={searchParams.get("memory")} />;
}

export default function LocationMemoryDetailPage() {
  return (
    <PkmSettingsShell title="Location memory detail" titleVisuallyHidden>
      <Suspense fallback={<p role="status">Opening Location memory…</p>}>
        <LocationMemoryDetail />
      </Suspense>
    </PkmSettingsShell>
  );
}
