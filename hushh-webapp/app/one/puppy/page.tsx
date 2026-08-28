"use client";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { HermesChatPanel } from "@/components/agent/hermes-chat-panel";

/**
 * Puppy One: the agent running on the owner's own machine.
 *
 * Its own surface rather than a mode of the One chat, because it is a
 * different agent -- a different model, a different memory, and work done on
 * hardware the owner owns. Sharing One's transcript would make that transcript
 * lie about where each answer came from.
 */
export default function PuppyOnePage() {
  // No nativeTest marker: this surface is classified excluded-web-only because
  // it reaches an agent over loopback on the owner's Mac, which the iOS and
  // Android shells cannot do. Claiming native coverage here would be a lie.
  return (
    <AppPageShell as="main" width="reading">
      <AppPageHeaderRegion>
        <PageHeader
          title="Puppy One"
          description="A personal supercomputer you own. Answers are generated on your machine."
          accent="neutral"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <HermesChatPanel />
      </AppPageContentRegion>
    </AppPageShell>
  );
}
