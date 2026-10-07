/**
 * Where One's transcript scrolls after a send, and while it follows a reply.
 *
 * The composer is an overlay: it sits `absolute` over the bottom of the
 * transcript, and the transcript reserves that band with padding-bottom.
 * `scrollIntoView({ block: "end" })` aligns a row with the bottom of the
 * scrollport, which is INSIDE that reserved band, so the last row landed
 * behind the composer (measured in Chromium: a 200 px reserve left the end
 * marker 199 px short of the real bottom). After a long prompt that hid the
 * "One is preparing your response" row below the fold.
 *
 * The fix is geometric: measure the composer's top edge and reveal the target
 * above it. Measuring (rather than assuming the reserve) also covers a taller
 * composer and the native keyboard lift, which moves the composer on
 * `translate` without resizing the WebView.
 */

/** Space kept between a revealed row and the composer's top edge. */
export const TRANSCRIPT_REVEAL_GAP_PX = 16;

export type TranscriptRevealGeometry = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Viewport y of the transcript's top edge. */
  viewportTop: number;
  /** Viewport y below which the transcript is covered (the composer's top). */
  visibleBottom: number;
  elementTop: number;
  elementBottom: number;
};

/**
 * The smallest scroll that shows the element fully between the transcript's
 * top and the composer, like `block: "nearest"` with the overlay subtracted.
 * An element taller than that band shows its start. Already visible means no
 * movement, so a reader is never nudged by a row that is on screen.
 */
export function transcriptRevealScrollTop(
  geometry: TranscriptRevealGeometry,
  gap: number = TRANSCRIPT_REVEAL_GAP_PX,
): number {
  const maxScrollTop = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
  const bandTop = geometry.viewportTop + gap;
  const bandBottom = geometry.visibleBottom - gap;
  const elementHeight = geometry.elementBottom - geometry.elementTop;

  let delta = 0;
  if (elementHeight > bandBottom - bandTop) {
    delta = geometry.elementTop - bandTop;
  } else if (geometry.elementBottom > bandBottom) {
    delta = geometry.elementBottom - bandBottom;
  } else if (geometry.elementTop < bandTop) {
    delta = geometry.elementTop - bandTop;
  }
  return Math.min(maxScrollTop, Math.max(0, geometry.scrollTop + delta));
}

/** The assistant turn a send just created: the last row still streaming. */
export function findPendingAssistantTurn(transcript: HTMLElement): HTMLElement | null {
  const rows = transcript.querySelectorAll<HTMLElement>(
    '[data-message-role="assistant"][data-message-status="streaming"]',
  );
  return rows.length ? rows[rows.length - 1]! : null;
}

/**
 * One layout read per element. `overlay` is the composer stack; when it is
 * hidden or absent the transcript's own bottom edge is the limit.
 */
export function measureTranscriptReveal(
  transcript: HTMLElement,
  element: HTMLElement,
  overlay: HTMLElement | null,
): TranscriptRevealGeometry {
  const transcriptRect = transcript.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const overlayRect = overlay?.getBoundingClientRect();
  const overlayTop =
    overlayRect && overlayRect.height > 0 ? overlayRect.top : transcriptRect.bottom;
  return {
    scrollTop: transcript.scrollTop,
    scrollHeight: transcript.scrollHeight,
    clientHeight: transcript.clientHeight,
    viewportTop: transcriptRect.top,
    visibleBottom: Math.max(transcriptRect.top, Math.min(transcriptRect.bottom, overlayTop)),
    elementTop: elementRect.top,
    elementBottom: elementRect.bottom,
  };
}

/** How far the end may sit below the composer band and still be "at the end". */
export const TRANSCRIPT_FOLLOW_SLACK_PX = 48;

export type TranscriptFollowState = {
  /** The reader scrolled away from the latest turn. */
  userScrolled: boolean;
  /** A send or a consent continuation asked to reveal the pending turn. */
  submittedTurn: boolean;
  /** A programmatic scroll is still landing. */
  programmatic: boolean;
  scrollTop: number;
  /** The last follow left the end in view, and the reader has not moved since. */
  stuckToEnd: boolean;
  /** Pixels between the scroll position and the scroll bottom. */
  distanceFromBottom: number;
  /**
   * How far the end marker sits below the composer band (the scroll needed to
   * reveal it above the composer); zero or less when it is already in view.
   */
  endBelowBand: number;
};

/**
 * Whether the transcript keeps following the latest turn as it grows.
 *
 * The follow scroll lands the end ABOVE the composer, which is short of the
 * scroll bottom by however much the reserved padding exceeds the composer
 * (measured 2026-09-28 on a 393x852 phone: 87 px). The old gate compared the
 * raw scroll bottom with a 48 px slack, so after the first reveal every
 * further token was "away from the bottom" and One's answer grew under the
 * composer. Following is sticky instead: once a follow left the end in view,
 * growth keeps it there until the reader scrolls away.
 */
export function transcriptFollowsLatest(state: TranscriptFollowState): boolean {
  if (state.userScrolled) return false;
  return state.submittedTurn || state.programmatic || state.scrollTop <= 2 || state.stuckToEnd
    || state.distanceFromBottom <= TRANSCRIPT_FOLLOW_SLACK_PX
    || state.endBelowBand <= TRANSCRIPT_FOLLOW_SLACK_PX;
}
