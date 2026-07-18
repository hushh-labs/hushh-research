"use client";

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { SwipeViews } from "@/components/app-ui/swipe-views";
import { DeveloperDocsHub } from "@/components/developers/developer-docs-hub";
import { BlogIndex } from "@/components/research/blog-index";
import { ResearchLanding } from "@/components/research/research-landing";
import {
  buildPublicKnowledgeRoute,
  resolveRegisteredTopShellTabValue,
  TOP_SHELL_TAB_REGISTRY,
  type PublicKnowledgeTab,
} from "@/lib/navigation/top-shell-tabs";

/**
 * The public knowledge pages share the same route-backed swipe contract as
 * Finance and Location. Standalone paths redirect here so a swipe, a top-tab
 * click, and a bookmark always converge on one URL shape.
 */
export function PublicKnowledgeWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const definition = TOP_SHELL_TAB_REGISTRY.public;
  const activeTab = resolveRegisteredTopShellTabValue(
    definition,
    searchParams.get("tab"),
  ) as PublicKnowledgeTab;

  const setActiveTab = useCallback(
    (next: PublicKnowledgeTab) => {
      if (next === activeTab) return;
      router.replace(buildPublicKnowledgeRoute(next), { scroll: false });
    },
    [activeTab, router],
  );

  return (
    <SwipeViews
      tabSetId={definition.id}
      activeValue={activeTab}
      options={definition.tabs}
      onChildSwiped={(value) => setActiveTab(value as PublicKnowledgeTab)}
    >
      <ResearchLanding />
      <BlogIndex />
      <DeveloperDocsHub />
    </SwipeViews>
  );
}
