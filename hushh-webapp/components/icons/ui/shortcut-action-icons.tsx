"use client";

import { useId, type SVGProps } from "react";
import motion from "./shortcut-icon-motion.module.css";

/** Original Phosphor Download artwork, separated only at its subpath seams. */
export function DownloadAppIcon(props: SVGProps<SVGSVGElement>) {
  const mouthId = useId();
  const revealId = useId();
  return (
    <svg width="24" height="24" viewBox="0 0 256 256" fill="var(--ios-account-label)" data-canonical-icon="true" {...props}>
      <defs>
        <clipPath id={mouthId}><rect width="256" height="136" /></clipPath>
        <mask id={revealId} maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="144">
          <rect className={motion.arrowReveal} width="256" height="144" fill="white" />
        </mask>
      </defs>
      {/* Preserve the canonical subpaths at rest; masks can otherwise
          soften a fractional pixel at the 18/22px sidebar sizes. */}
      <g className={motion.restingArtwork}>
        <path d="M240,136v64a16,16,0,0,1-16,16H32a16,16,0,0,1-16-16V136a16,16,0,0,1,16-16H72a8,8,0,0,1,0,16H32v64H224V136H184a8,8,0,0,1,0-16h40A16,16,0,0,1,240,136Z" />
        <path fill="var(--ios-account-accent)" d="M122.34,133.66a8,8,0,0,0,11.32,0l48-48a8,8,0,0,0-11.32-11.32L136,108.69V24a8,8,0,0,0-16,0v84.69L85.66,74.34A8,8,0,0,0,74.34,85.66Z" />
        <path fill="var(--ios-account-accent)" d="M200,168a12,12,0,1,0-12,12A12,12,0,0,0,200,168Z" />
      </g>
      <g className={motion.movingArtwork}>
        <g className={motion.downloadTray}>
          <path d="M240,136v64a16,16,0,0,1-16,16H32a16,16,0,0,1-16-16V136a16,16,0,0,1,16-16H72a8,8,0,0,1,0,16H32v64H224V136H184a8,8,0,0,1,0-16h40A16,16,0,0,1,240,136Z" />
        </g>
        <g clipPath={`url(#${mouthId})`}>
          <g mask={`url(#${revealId})`}>
            <g fill="var(--ios-account-accent)" className={motion.downloadArrow} data-shortcut-icon-cycle>
              <path d="M122.34,133.66a8,8,0,0,0,11.32,0l48-48a8,8,0,0,0-11.32-11.32L136,108.69V24a8,8,0,0,0-16,0v84.69L85.66,74.34A8,8,0,0,0,74.34,85.66Z" />
            </g>
          </g>
        </g>
        <path fill="var(--ios-account-accent)" data-shortcut-tray-dot d="M200,168a12,12,0,1,0-12,12A12,12,0,0,0,200,168Z" />
      </g>
    </svg>
  );
}

export { ConnectorsShortcutIcon } from "./weave-connector-icon";
