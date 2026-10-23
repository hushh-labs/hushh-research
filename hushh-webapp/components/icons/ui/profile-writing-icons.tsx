"use client";

import { useId } from "react";
import { ChatCircleText, TextAa, TextAlignLeft, Translate, UserCircle, type Icon } from "@phosphor-icons/react";
import type { AgentIconProps } from "../agents/agent-icons";

/** Paint an existing detail in the official glyph; preserve its full geometry. */
function profileWritingIcon(Glyph: Icon, accent: { x: number; y: number; width: number; height: number }, name: string) {
  function ProfileWritingIcon({ size = "1em", className, style, ...props }: AgentIconProps) {
    const paintId = useId();
    return <Glyph {...props} size={size} weight="regular" aria-hidden="true"
      className={className} style={{ ...style, color: "var(--ios-account-label)" }} fill={`url(#${paintId})`}>
      <defs>
        <pattern id={paintId} patternUnits="userSpaceOnUse" width="256" height="256">
          <rect width="256" height="256" fill="currentColor" />
          <rect {...accent} className="profile-pane-icon-accent-fill" fill="var(--ios-account-accent)" />
        </pattern>
      </defs>
    </Glyph>;
  }
  ProfileWritingIcon.displayName = name;
  return ProfileWritingIcon;
}

// The head, speech lines, first text line, translated A, and lowercase a carry
// Profile's selected accent; the remaining outline follows its semantic ink.
export const PreferredNameRowIcon = profileWritingIcon(UserCircle, { x: 80, y: 72, width: 96, height: 96 }, "PreferredNameRowIcon");
export const ToneRowIcon = profileWritingIcon(ChatCircleText, { x: 88, y: 104, width: 80, height: 48 }, "ToneRowIcon");
export const ReplyLengthRowIcon = profileWritingIcon(TextAlignLeft, { x: 32, y: 56, width: 192, height: 16 }, "ReplyLengthRowIcon");
export const LanguageRowIcon = profileWritingIcon(Translate, { x: 120, y: 96, width: 136, height: 136 }, "LanguageRowIcon");
export const PunctuationRowIcon = profileWritingIcon(TextAa, { x: 160, y: 96, width: 88, height: 104 }, "PunctuationRowIcon");
