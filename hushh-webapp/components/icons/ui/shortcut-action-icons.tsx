"use client";

import { useId, type SVGProps } from "react";
import motion from "./shortcut-icon-motion.module.css";

/** Original Phosphor Download artwork, separated only at its subpath seams. */
export function DownloadAppIcon(props: SVGProps<SVGSVGElement>) {
  const mouthId = useId();
  const revealId = useId();
  return (
    <svg width="24" height="24" viewBox="0 0 256 256" fill="currentColor" data-canonical-icon="true" {...props}>
      <defs>
        <clipPath id={mouthId}><rect width="256" height="136" /></clipPath>
        <mask id={revealId} maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="144">
          <rect className={motion.arrowReveal} width="256" height="144" fill="white" />
        </mask>
      </defs>
      {/* Preserve the canonical compound paths at rest; masks can otherwise
          soften a fractional pixel at the 18/22px sidebar sizes. */}
      <g className={motion.restingArtwork}>
        <path d="M232,136v64a8,8,0,0,1-8,8H32a8,8,0,0,1-8-8V136a8,8,0,0,1,8-8H224A8,8,0,0,1,232,136Z" opacity="0.2" />
        <path d="M240,136v64a16,16,0,0,1-16,16H32a16,16,0,0,1-16-16V136a16,16,0,0,1,16-16H72a8,8,0,0,1,0,16H32v64H224V136H184a8,8,0,0,1,0-16h40A16,16,0,0,1,240,136Zm-117.66-2.34a8,8,0,0,0,11.32,0l48-48a8,8,0,0,0-11.32-11.32L136,108.69V24a8,8,0,0,0-16,0v84.69L85.66,74.34A8,8,0,0,0,74.34,85.66ZM200,168a12,12,0,1,0-12,12A12,12,0,0,0,200,168Z" />
      </g>
      <g className={motion.movingArtwork}>
        <g className={motion.downloadTray}>
          <path d="M232,136v64a8,8,0,0,1-8,8H32a8,8,0,0,1-8-8V136a8,8,0,0,1,8-8H224A8,8,0,0,1,232,136Z" opacity="0.2" />
          <path d="M240,136v64a16,16,0,0,1-16,16H32a16,16,0,0,1-16-16V136a16,16,0,0,1,16-16H72a8,8,0,0,1,0,16H32v64H224V136H184a8,8,0,0,1,0-16h40A16,16,0,0,1,240,136Z" />
        </g>
        <g clipPath={`url(#${mouthId})`}>
          <g mask={`url(#${revealId})`}>
            <g className={motion.downloadArrow} data-shortcut-icon-cycle>
              <path d="M122.34,133.66a8,8,0,0,0,11.32,0l48-48a8,8,0,0,0-11.32-11.32L136,108.69V24a8,8,0,0,0-16,0v84.69L85.66,74.34A8,8,0,0,0,74.34,85.66Z" />
            </g>
          </g>
        </g>
        <path data-shortcut-tray-dot d="M200,168a12,12,0,1,0-12,12A12,12,0,0,0,200,168Z" />
      </g>
    </svg>
  );
}

export function ConnectorsShortcutIcon(props: SVGProps<SVGSVGElement>) {
  const prongMaskId = useId();
  return (
    <svg width="24" height="24" viewBox="0 0 256 256" fill="currentColor" data-canonical-icon="true" {...props}>
      <defs>
        <mask id={prongMaskId} maskUnits="userSpaceOnUse" x="-128" y="-128" width="512" height="512">
          <rect x="-128" y="-128" width="512" height="512" fill="white" />
          <polygon className={motion.prongOccluder} points="-256,-304 512,464 512,-304" fill="black" />
        </mask>
      </defs>
      <g className={motion.restingArtwork}>
        <path d="M76,124l56,56-29,29a24,24,0,0,1-33.94,0L47,186.91A24,24,0,0,1,47,153ZM209,69.09,186.91,47A24,24,0,0,0,153,47L124,76l56,56,29-29A24,24,0,0,0,209,69.09Z" opacity="0.2" />
        <path d="M149.66,138.34a8,8,0,0,0-11.32,0L120,156.69,99.31,136l18.35-18.34a8,8,0,0,0-11.32-11.32L88,124.69,69.66,106.34a8,8,0,0,0-11.32,11.32L64.69,124,41.37,147.31a32,32,0,0,0,0,45.26l5.38,5.37-28.41,28.4a8,8,0,0,0,11.32,11.32l28.4-28.41,5.37,5.38a32,32,0,0,0,45.26,0L132,191.31l6.34,6.35a8,8,0,0,0,11.32-11.32L131.31,168l18.35-18.34A8,8,0,0,0,149.66,138.34Zm-52.29,65a16,16,0,0,1-22.62,0L52.69,181.25a16,16,0,0,1,0-22.62L76,135.31,120.69,180Zm140.29-185a8,8,0,0,0-11.32,0l-28.4,28.41-5.37-5.38a32.05,32.05,0,0,0-45.26,0L124,64.69l-6.34-6.35a8,8,0,0,0-11.32,11.32l80,80a8,8,0,0,0,11.32-11.32L191.31,132l23.32-23.31a32,32,0,0,0,0-45.26l-5.38-5.37,28.41-28.4A8,8,0,0,0,237.66,18.34Zm-34.35,79L180,120.69,135.31,76l23.32-23.31a16,16,0,0,1,22.62,0l22.06,22A16,16,0,0,1,203.31,97.37Z" />
      </g>
      <g className={motion.movingArtwork}>
        <g className={motion.plugLeft} data-shortcut-icon-cycle>
          <g mask={`url(#${prongMaskId})`}>
            <path d="M76,124l56,56-29,29a24,24,0,0,1-33.94,0L47,186.91A24,24,0,0,1,47,153Z" opacity="0.2" />
            <path d="M149.66,138.34a8,8,0,0,0-11.32,0L120,156.69,99.31,136l18.35-18.34a8,8,0,0,0-11.32-11.32L88,124.69,69.66,106.34a8,8,0,0,0-11.32,11.32L64.69,124,41.37,147.31a32,32,0,0,0,0,45.26l5.38,5.37-28.41,28.4a8,8,0,0,0,11.32,11.32l28.4-28.41,5.37,5.38a32,32,0,0,0,45.26,0L132,191.31l6.34,6.35a8,8,0,0,0,11.32-11.32L131.31,168l18.35-18.34A8,8,0,0,0,149.66,138.34Zm-52.29,65a16,16,0,0,1-22.62,0L52.69,181.25a16,16,0,0,1,0-22.62L76,135.31,120.69,180Z" />
          </g>
        </g>
        <g className={motion.plugRight}>
          <path d="M209,69.09,186.91,47A24,24,0,0,0,153,47L124,76l56,56,29-29A24,24,0,0,0,209,69.09Z" opacity="0.2" />
          <path d="M237.66,18.34a8,8,0,0,0-11.32,0l-28.4,28.41-5.37-5.38a32.05,32.05,0,0,0-45.26,0L124,64.69l-6.34-6.35a8,8,0,0,0-11.32,11.32l80,80a8,8,0,0,0,11.32-11.32L191.31,132l23.32-23.31a32,32,0,0,0,0-45.26l-5.38-5.37,28.41-28.4A8,8,0,0,0,237.66,18.34Zm-34.35,79L180,120.69,135.31,76l23.32-23.31a16,16,0,0,1,22.62,0l22.06,22A16,16,0,0,1,203.31,97.37Z" />
        </g>
      </g>
    </svg>
  );
}
