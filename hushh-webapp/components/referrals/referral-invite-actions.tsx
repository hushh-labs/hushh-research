"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ShellActionSurface, SHELL_ICON_BUTTON_CLASSNAME } from "@/components/app-ui/shell-action-surface";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ArrowRightIcon, GiftIcon, MoreHorizontal } from "@/components/icons";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";

type ReferralInviteActionsProps = {
  active: boolean;
  link: string;
  onShare: () => void;
};

export function ReferralInviteActions({ active, link, onShare }: ReferralInviteActionsProps) {
  const [expanded, setExpanded] = useState(false);
  const open = active && expanded;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setExpanded(false);
    if (active) triggerRef.current?.focus({ preventScroll: true });
    return true;
  }, [active]);
  useBackLayer(ROUTES.ONE_REFERRALS, open ? 1 : 0, close);

  // SwipeViews keeps inactive panes mounted; their menu must not own Back or focus.
  useEffect(() => {
    if (!active) setExpanded(false);
  }, [active]);

  // This is an inline disclosure: it belongs to the hero's scroll and clipping
  // context, rather than a viewport-positioned popover that can flip on scroll.
  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !actionsRef.current?.contains(event.target)) {
        setExpanded(false);
      }
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, [open]);

  return (
    <div
      ref={actionsRef}
      className="referral-invite-actions"
      role="group"
      aria-label="Share your invite link"
      onKeyDown={(event) => {
        if (open && event.key === "Escape") { event.preventDefault(); close(); }
      }}
    >
      <Collapsible open={open} onOpenChange={setExpanded}>
        <CollapsibleTrigger asChild>
          <ShellActionSurface
            ref={triggerRef}
            variant="pill"
            className="referral-share-toggle !h-11"
            contentClassName="referral-share-content"
            aria-label={open ? "Close share options" : "Invite & earn $"}
            aria-expanded={open}
            rippleEffect="fill"
          >
            <span className="referral-share-gift" aria-hidden="true">
              <GiftIcon size={18} weight="duotone" />
            </span>
            <span className="referral-share-label">Invite &amp; earn $</span>
            <span className="referral-share-arrow-surface" aria-hidden="true">
              <ArrowRightIcon className="referral-share-arrow size-4" weight="bold" />
            </span>
          </ShellActionSurface>
        </CollapsibleTrigger>
        <CollapsibleContent
          className="referral-invite-bubbles"
          role="group"
          aria-label="Choose how to invite a friend"
          aria-hidden={!open || undefined}
          inert={!open || undefined}
        >
          <div className="referral-invite-bubble">
            <a
              className={`${SHELL_ICON_BUTTON_CLASSNAME} referral-bubble-action !h-11 !w-11`}
              aria-label="Share on WhatsApp"
              title="WhatsApp"
              href={`https://wa.me/?text=${encodeURIComponent(`Join me on Hushh One for the weekly referral challenge: ${link}`)}`}
              target="_blank"
              rel="noopener"
              onClick={close}
            >
              <Image src="/referrals/whatsapp-ios.jpg" alt="" width={30} height={30} className="referral-bubble-logo" unoptimized />
              <MaterialRipple variant="blue" effect="fill" />
            </a>
            <span className="referral-bubble-label">WhatsApp</span>
          </div>
          <div className="referral-invite-bubble">
            <a
              className={`${SHELL_ICON_BUTTON_CLASSNAME} referral-bubble-action !h-11 !w-11`}
              aria-label="Share by SMS"
              title="SMS"
              href={`sms:?&body=${encodeURIComponent(`Join me on Hushh One: ${link}`)}`}
              onClick={close}
            >
              <Image src="/referrals/messages-ios.jpg" alt="" width={30} height={30} className="referral-bubble-logo" unoptimized />
              <MaterialRipple variant="blue" effect="fill" />
            </a>
            <span className="referral-bubble-label">SMS</span>
          </div>
          <div className="referral-invite-bubble">
            <ShellActionSurface
              className="referral-bubble-action !h-11 !w-11"
              onClick={() => { onShare(); close(); }}
              aria-label="More share options"
              title="More"
              rippleEffect="fill"
            >
              <MoreHorizontal className="size-6" weight="bold" aria-hidden="true" />
            </ShellActionSurface>
            <span className="referral-bubble-label">More</span>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
