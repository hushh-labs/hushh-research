"use client";

import { useId, type SVGProps } from "react";
import motion from "./shortcut-icon-motion.module.css";

/** Stacked notes matching the To-do shortcut artwork. */
export function TodoListIcon(props: SVGProps<SVGSVGElement>) {
  const maskId = useId();
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--ios-account-label)"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="-2" y="-2" width="28" height="28">
          <rect x="-2" y="-2" width="28" height="28" fill="white" stroke="none" />
          <g className={motion.frontPaper}>
            <rect x="7" y="2" width="14" height="20" rx="2.5" fill="black" stroke="black" />
          </g>
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        <rect className={motion.underPage} x="3" y="2" width="14" height="20" rx="2.5" />
      </g>
      <path className={motion.backPage} d="M7 7H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h12" />
      <g className={motion.frontPaper} data-shortcut-icon-cycle>
        <rect x="7" y="2" width="14" height="20" rx="2.5" />
      </g>
      <rect className={motion.paperCurl} x="7" y="18" width="14" height="4" rx="2" />
      <path stroke="var(--ios-account-accent)" className={motion.firstLine} d="M11 7h6" />
      <path stroke="var(--ios-account-accent)" className={motion.secondLine} d="M11 11h4" />
    </svg>
  );
}
