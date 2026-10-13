import type { SVGProps } from "react";
import motion from "./shortcut-icon-motion.module.css";

const outline = {
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function DownloadAppIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...outline} {...props}>
      <path d="M8 13H4a1 1 0 0 0-1 1v6h18v-6a1 1 0 0 0-1-1h-4" />
      <g className={motion.downloadArrow}>
        <path d="M12 3v12M7 10l5 5 5-5" />
      </g>
      <circle className={motion.downloadDot} cx="12" cy="18" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ConnectorsShortcutIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="24" height="24" viewBox="0 0 256 256" fill="currentColor" {...props}>
      <g className={motion.plugLeft}>
        <path d="M149.66,138.34a8,8,0,0,0-11.32,0L120,156.69,99.31,136l18.35-18.34a8,8,0,0,0-11.32-11.32L88,124.69,69.66,106.34a8,8,0,0,0-11.32,11.32L64.69,124,41.37,147.31a32,32,0,0,0,0,45.26l5.38,5.37-28.41,28.4a8,8,0,0,0,11.32,11.32l28.4-28.41,5.37,5.38a32,32,0,0,0,45.26,0L132,191.31l6.34,6.35a8,8,0,0,0,11.32-11.32L131.31,168l18.35-18.34A8,8,0,0,0,149.66,138.34Zm-52.29,65a16,16,0,0,1-22.62,0L52.69,181.25a16,16,0,0,1,0-22.62L76,135.31,120.69,180Z" />
      </g>
      <g className={motion.plugRight}>
        <path d="M237.66,18.34a8,8,0,0,0-11.32,0l-28.4,28.41-5.37-5.38a32.05,32.05,0,0,0-45.26,0L124,64.69l-6.34-6.35a8,8,0,0,0-11.32,11.32l80,80a8,8,0,0,0,11.32-11.32L191.31,132l23.32-23.31a32,32,0,0,0,0-45.26l-5.38-5.37,28.41-28.4A8,8,0,0,0,237.66,18.34Zm-34.35,79L180,120.69,135.31,76l23.32-23.31a16,16,0,0,1,22.62,0l22.06,22A16,16,0,0,1,203.31,97.37Z" />
      </g>
      <path className={motion.connectionPulse} d="m112 64 8-16m72 96 16-8" fill="none" stroke="currentColor" strokeWidth="12" strokeLinecap="round" />
    </svg>
  );
}
