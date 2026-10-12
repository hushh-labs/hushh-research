"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import Image from "next/image";
import { ShellActionSurface, SHELL_ICON_BUTTON_CLASSNAME } from "@/components/app-ui/shell-action-surface";
import { Copy, Upload, X } from "@/components/icons";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";

type ReferralInviteActionsProps = {
  active: boolean;
  link: string;
  onCopy: () => void;
  onShare: () => void;
};

export function ReferralInviteActions({ active, link, onCopy, onShare }: ReferralInviteActionsProps) {
  const [expanded, setExpanded] = useState(false);
  const open = active && expanded;
  const optionsId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const previousWidth = useRef(0);

  const close = useCallback(() => {
    previousWidth.current = barRef.current?.getBoundingClientRect().width ?? 0;
    setExpanded(false);
    triggerRef.current?.focus({ preventScroll: true });
    return true;
  }, []);
  useBackLayer(ROUTES.ONE_REFERRALS, open ? 1 : 0, close);

  // SwipeViews keeps inactive panes mounted; their disclosure must not own Back.
  useEffect(() => {
    if (!active) setExpanded(false);
  }, [active]);

  useLayoutEffect(() => {
    const bar = barRef.current;
    const track = trackRef.current;
    if (!bar || !track) return;
    const width = bar.getBoundingClientRect().width;
    const from = previousWidth.current;
    previousWidth.current = 0;
    if (!active || !from || !width || from === width || typeof track.animate !== "function"
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Layout settles once; only the decorative track scales during the spread.
    const styles = getComputedStyle(bar);
    const animation = track.animate(
      [{ transform: `scaleX(${from / width})` }, { transform: "scaleX(1)" }],
      {
        duration: parseFloat(styles.getPropertyValue("--motion-duration-xl")),
        easing: styles.getPropertyValue("--motion-ease-emphasized").trim(),
      },
    );
    return () => animation.cancel();
  }, [active, open]);

  return (
    <div
      ref={barRef}
      className="referral-invite-actions"
      role="group"
      aria-label="Share your invite link"
      data-expanded={open}
      onKeyDown={(event) => {
        if (!open || event.defaultPrevented || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <span ref={trackRef} className="referral-share-track" aria-hidden="true" />
      <ShellActionSurface
        ref={triggerRef}
        variant={open ? "icon" : "pill"}
        className={`referral-share-toggle !h-11 ${open ? "referral-share-button !w-11" : "referral-copy-button !text-xs"}`}
        onClick={() => {
          if (open) { close(); return; }
          previousWidth.current = barRef.current?.getBoundingClientRect().width ?? 0;
          setExpanded(true);
        }}
        aria-label={open ? "Close share options" : "Share"}
        aria-expanded={open}
        aria-controls={optionsId}
        rippleEffect="fill"
        style={open ? undefined : { background: "var(--app-accent)", color: "#fff" }}
      >
        {open ? <X className="size-4" aria-hidden="true" /> : <><Upload className="size-4" aria-hidden="true" /><span>Share</span></>}
      </ShellActionSurface>
      <div id={optionsId} className="referral-share-options motion-step-enter" hidden={!open} inert={!open}>
        <ShellActionSurface
          variant="pill"
          className="referral-copy-button !h-11 !text-xs"
          onClick={onCopy}
          aria-label="Copy invite link"
          title="Copy invite link"
          rippleEffect="fill"
          style={{ background: "var(--app-accent)", color: "#fff" }}
        >
          <Copy className="size-4" aria-hidden="true" />
          <span className="referral-copy-label">Copy link</span>
        </ShellActionSurface>
        <a
          className={`${SHELL_ICON_BUTTON_CLASSNAME} referral-share-button referral-share-app-button !h-11 !w-11 hover:!bg-transparent`}
          aria-label="Share on WhatsApp"
          title="WhatsApp"
          href={`https://wa.me/?text=${encodeURIComponent(`Join me on Hushh One for the weekly referral challenge: ${link}`)}`}
          target="_blank"
          rel="noopener"
        >
          <span className="referral-share-app-art">
            <Image src="/referrals/whatsapp-ios.jpg" alt="" width={32} height={32} className="referral-share-app-icon" unoptimized />
            <MaterialRipple variant="blue" effect="fill" />
          </span>
        </a>
        <a
          className={`${SHELL_ICON_BUTTON_CLASSNAME} referral-share-button referral-share-app-button !h-11 !w-11 hover:!bg-transparent`}
          aria-label="Share by SMS"
          title="SMS"
          href={`sms:?&body=${encodeURIComponent(`Join me on Hushh One: ${link}`)}`}
        >
          <span className="referral-share-app-art">
            <Image src="/referrals/messages-ios.jpg" alt="" width={32} height={32} className="referral-share-app-icon" unoptimized />
            <MaterialRipple variant="blue" effect="fill" />
          </span>
        </a>
        <ShellActionSurface
          onClick={onShare}
          className="referral-share-button referral-share-more !h-11 !w-11"
          rippleEffect="fill"
          aria-label="More share options"
          title="More share options"
        >
          <Upload className="size-5" aria-hidden="true" />
        </ShellActionSurface>
      </div>
    </div>
  );
}
