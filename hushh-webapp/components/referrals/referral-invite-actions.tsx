"use client";

import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";

type ReferralInviteActionsProps = { onShare: () => void };

export function ReferralInviteActions({ onShare }: ReferralInviteActionsProps) {
  return (
    <div className="referral-invite-actions" role="group" aria-label="Share your invite link">
      <ShellActionSurface
        variant="pill"
        className="referral-share-toggle"
        contentClassName="referral-share-content"
        onClick={onShare}
        rippleEffect="fill"
      >
        <span className="referral-share-label">Invite</span>
      </ShellActionSurface>
    </div>
  );
}
