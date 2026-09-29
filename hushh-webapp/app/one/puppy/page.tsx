"use client";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { PuppyOneSurface } from "@/components/agent/puppy-one-surface";

/**
 * Puppy One: the agent running on the owner's own machine.
 *
 * Its own surface rather than a mode of the One chat, because it is a
 * different agent -- a different model, a different memory, and work done on
 * hardware the owner owns. Sharing One's transcript would make that transcript
 * lie about where each answer came from.
 */
export default function PuppyOnePage() {
  // The surface selects the loopback panel only on the Mac's local origin.
  // A deployed browser uses the owner's admitted pod and trusted-device relay.
  return (
    // One's chat measure (`agent`, 880px) and a column exactly as tall as the
    // visible scroll area, so the conversation fills the screen the way One's
    // does instead of sitting in a fixed 68dvh card at the 720px reading
    // width. The height is the scroll root's own visible area: the top spacer
    // it renders (`--app-top-content-offset`) and the bottom clearance it pads
    // (`--app-scroll-bottom-pad`, else `--app-bottom-content-clearance`, which
    // already includes the safe area). This page inherits both from that same
    // scroll root, so the two cannot disagree. The shell's own 24px reading gap
    // is inside the height (border-box). `min-h` keeps a short viewport, or a
    // phone in landscape, scrolling rather than crushing the transcript.
    <AppPageShell
      as="main"
      width="agent"
      className="flex h-[calc(100dvh-var(--app-top-content-offset,0px)-var(--app-scroll-bottom-pad,var(--app-bottom-content-clearance,0px)))] min-h-[560px] flex-col"
    >
      <AppPageHeaderRegion className="shrink-0">
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
      {/* A flex column now that the shell above has a definite height: the
          panel's `flex-1` divides what the header and the strip leave, so a
          long conversation scrolls inside the panel and the composer stays at
          the bottom of the screen. (Before the shell had a height, a flex
          column here let that `flex-1` basis collapse to nothing, which is
          why the panel used to carry a fixed height of its own.) The readings
          stay one tap away on the strip; a broken link to Hussh One is the
          exception and stays on it unasked. */}
      <AppPageContentRegion className="flex min-h-0 flex-1 flex-col">
        <PuppyOneSurface className="px-0 pt-0 sm:px-0" />
      </AppPageContentRegion>
    </AppPageShell>
  );
}
