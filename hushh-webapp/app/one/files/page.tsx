"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FilesWorkspace } from "@/components/files/files-workspace";
import { ROUTES } from "@/lib/navigation/routes";

function FilesPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const folder = searchParams?.get("folder") ?? null;
  const doc = searchParams?.get("doc") ?? null;
  const page = searchParams?.get("page") ?? null;

  return (
    <FilesWorkspace
      initialFolder={folder}
      initialDoc={doc}
      initialPage={page}
      onInitialSelectionConsumed={() => {
        router.replace(`${ROUTES.ONE_FILES}?folder=personal-wiki`);
      }}
    />
  );
}

export default function FilesPage() {
  return (
    <Suspense fallback={null}>
      <FilesPageContent />
    </Suspense>
  );
}
