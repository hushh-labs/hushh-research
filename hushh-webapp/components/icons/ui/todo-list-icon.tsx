import type { SVGProps } from "react";
import motion from "./shortcut-icon-motion.module.css";

/** Stacked notes matching the To-do shortcut artwork. */
export function TodoListIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path className={motion.backPage} d="M7 7H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h12" />
      <rect x="7" y="2" width="14" height="20" rx="2.5" />
      <path className={motion.firstLine} d="M11 7h6" />
      <path className={motion.secondLine} d="M11 11h4" />
    </svg>
  );
}
