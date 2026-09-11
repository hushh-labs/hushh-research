export const PROFILE_PANE_OPEN_EVENT = "hushh:profile-pane-open";

export type ProfilePaneOpenSource = "tap" | "native_swipe";

export type ProfilePaneOpenDetail = {
  source: ProfilePaneOpenSource;
};

/**
 * Ask the app shell to present Profile as a transient pane. The shell owns the
 * pane lifecycle so the top bar, native edge gesture, and future entry points
 * share one surface without adding another navigation stack.
 */
export function requestProfilePaneOpen(
  source: ProfilePaneOpenSource = "tap",
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ProfilePaneOpenDetail>(PROFILE_PANE_OPEN_EVENT, {
      detail: { source },
    }),
  );
}
