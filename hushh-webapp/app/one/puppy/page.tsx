"use client";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { HermesChatPanel } from "@/components/agent/hermes-chat-panel";
import { PuppyMachineSheet } from "@/components/agent/puppy-resource-monitor";

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
          // "Answers are generated on your machine" was an unconditional
          // per-turn claim, and the pill inside the panel can be set to "any
          // model", which lets the gateway resolve one that runs off it. The
          // pin is what makes the promise, so the sentence names the pin.
          description="A personal supercomputer you own. Pin a model to this machine and answers never leave it."
          accent="neutral"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        {/* The readings are one tap away rather than always on: the owner asks
            for them. A broken link to Hussh One is the exception and stays on
            this strip unasked, because nothing else on the page can tell the
            owner that One has stopped seeing the machine. Spaced with a margin
            rather than a flex gap on purpose: this region stays block-level for
            that spacing, and making it a flex column would let the chat panel's
            flex-1 basis collapse to nothing. */}
        <PuppyMachineSheet className="mb-3" />
        {/* The panel carries its OWN bounded height here.
            `AppPageContentRegion` is width-only, so the panel's `flex-1` has
            nothing to divide and it grew to content height: a long
            conversation pushed the composer down the document instead of
            scrolling inside the panel, and the same component behaved
            correctly inside the workspace. Not the workspace's
            `100dvh`-minus-chrome height, because the page header and the strip
            above sit in the same scroll root and a full-viewport panel would
            push the composer back below the fold. The border and radius mirror
            the workspace's wrapper so the two entry points read as one
            component. */}
        <HermesChatPanel className="h-[min(68dvh,42rem)] min-h-[420px] overflow-hidden rounded-2xl border border-border/60 bg-background" />
      </AppPageContentRegion>
    </AppPageShell>
  );
}
