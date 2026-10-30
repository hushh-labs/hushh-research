"use client";

import { useSearchParams } from "next/navigation";

import { KaiAnalysisPreviewView } from "@/components/kai/views/kai-analysis-preview-view";
import { KaiConnectPreviewView } from "@/components/kai/views/kai-connect-preview-view";
import { KaiMarketPreviewView } from "@/components/kai/views/kai-market-preview-view";

export function KaiPreviewRouter() {
  const searchParams = useSearchParams();
  const preview = searchParams.get("preview");

  if (preview === "analysis") {
    return <KaiAnalysisPreviewView />;
  }

  if (preview === "connect") {
    return <KaiConnectPreviewView />;
  }

  return <KaiMarketPreviewView />;
}
