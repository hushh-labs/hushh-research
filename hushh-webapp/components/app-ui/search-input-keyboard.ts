import type { ComponentProps } from "react";

/** Preserve names while typing, and keep search reachable in a phone WebView. */
export const SEARCH_INPUT_KEYBOARD_PROPS = {
  autoCorrect: "off",
  autoCapitalize: "none",
  spellCheck: false,
  enterKeyHint: "search",
  onKeyDown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    }
  },
  onFocus(event) {
    const field = event.currentTarget;
    // Measure after the keyboard animation, without scrolling a dismissed field.
    window.setTimeout(() => {
      if (field.isConnected && field.ownerDocument.activeElement === field) {
        field.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }, 250);
  },
} satisfies Pick<ComponentProps<"input">,
  "autoCorrect" | "autoCapitalize" | "spellCheck" | "enterKeyHint" | "onKeyDown" | "onFocus">;
