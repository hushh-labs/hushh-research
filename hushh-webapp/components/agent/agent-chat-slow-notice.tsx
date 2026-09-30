"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ProgressRowIcon, SyncRowIcon } from "@/components/icons";
import {
  SLOW_NOTICE_TOAST_ID,
  SlowTurnNotice,
  type SlowNoticePort,
  type SlowNoticeState,
} from "@/lib/agent/agent-chat-slow-notice";

export const SLOW_NOTICE_TEST_ID = "agent-chat-slow-notice";

/**
 * Bare duotone registry glyphs, one per concept: waiting (the hourglass) and
 * the connection (the sync arrows). Static, so there is no motion to reduce.
 */
function SlowNoticeGlyph({ state }: { state: SlowNoticeState }) {
  const Glyph = state === "connecting" ? SyncRowIcon : ProgressRowIcon;
  return <Glyph size={16} aria-hidden="true" data-slow-notice-glyph={state} />;
}

/**
 * The notice as one sonner toast under a stable id, so a state change updates
 * it in place and it can never stack. It stays until cleared or closed by the
 * person; the Toaster's polite live region announces each change.
 *
 * `toast.message`, not bare `toast()`: in sonner 2.0.7 the bare call appends a
 * new store entry on every call (measured: three updates, three entries), and
 * only the `create` path behind `toast.message` updates an id in place.
 */
/**
 * Mirror-symmetric on the 8 pt grid, measured from the toast's outer edge: the
 * glyph's centre sits 24 pt in on the left and the close control's centre 24 pt
 * in on the right, and the text column keeps 40 pt clear on both sides. The
 * close control is a 32 pt target centred on the text block, like the glyph.
 * The single title holds the full message in at most two lines.
 * Offsets of 15 and 7 are 16 and 8 from the outer edge, inside the 1 px border.
 *
 * Important modifiers because sonner's own attribute selectors
 * (`[data-sonner-toast][data-styled=true]`, `[data-close-button]`,
 * `[data-icon] svg`, `[data-title]`) outrank a plain utility class: without
 * them the close control hangs off the top-left corner at 20 px, the glyph
 * sits 13 px in, and line heights fall off the grid.
 */
const SLOW_NOTICE_CLASS_NAMES = {
  toast: "p-[15px]! pe-[39px]! gap-2!",
  icon: "m-0! size-4! [&>svg]:m-0!",
  title: "leading-5!",
  closeButton:
    "left-auto! right-[7px]! top-1/2! size-8! -translate-y-1/2! transform-none! rounded-full! border-0! bg-transparent! text-muted-foreground hover:bg-muted! hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
} as const;

export function createSlowNoticeToastPort(onPersonDismiss: () => void): SlowNoticePort {
  return {
    show: (view) => {
      toast.message(view.title, {
        id: SLOW_NOTICE_TOAST_ID,
        duration: Infinity,
        closeButton: true,
        dismissible: true,
        icon: <SlowNoticeGlyph state={view.state} />,
        testId: SLOW_NOTICE_TEST_ID,
        classNames: SLOW_NOTICE_CLASS_NAMES,
        onDismiss: onPersonDismiss,
      });
    },
    clear: () => {
      toast.dismiss(SLOW_NOTICE_TOAST_ID);
    },
  };
}

/** One notice controller per chat surface, taken down when the surface unmounts. */
export function useAgentChatSlowNotice(): SlowTurnNotice {
  const [notice] = useState(() => {
    const controller: SlowTurnNotice = new SlowTurnNotice(
      createSlowNoticeToastPort(() => controller.dismissedByPerson()),
    );
    return controller;
  });
  useEffect(() => () => notice.dispose(), [notice]);
  return notice;
}
