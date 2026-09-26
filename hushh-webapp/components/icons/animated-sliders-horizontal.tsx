import type { SVGProps } from "react";

/** Phosphor SlidersHorizontal duotone geometry, separated into rails and knobs
 * so the knobs can travel without distorting the icon. Hover is owned by the
 * enclosing group/controls; reduced-motion keeps both knobs at rest. */
export function AnimatedSlidersHorizontal({
  surfaceClassName = "fill-background",
  ...props
}: SVGProps<SVGSVGElement> & { surfaceClassName?: string }) {
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden focusable="false" {...props}>
      <path d="M40,88H216a8,8,0,0,0,0-16H40a8,8,0,0,0,0,16ZM40,184H216a8,8,0,0,0,0-16H40a8,8,0,0,0,0,16Z" />
      <g data-slider-knob="first" className="transition-transform duration-300 ease-in-out motion-safe:group-hover/controls:translate-x-[64px] motion-reduce:transition-none">
        <circle cx="104" cy="80" r="32" className={surfaceClassName} />
        <circle cx="104" cy="80" r="24" opacity="0.2" />
        <path fillRule="evenodd" d="M104,48a32,32,0,1,0,0,64a32,32,0,1,0,0-64Zm0,16a16,16,0,1,1,0,32a16,16,0,1,1,0-32Z" />
      </g>
      <g data-slider-knob="second" className="transition-transform duration-300 ease-in-out motion-safe:group-hover/controls:-translate-x-[64px] motion-reduce:transition-none">
        <circle cx="168" cy="176" r="32" className={surfaceClassName} />
        <circle cx="168" cy="176" r="24" opacity="0.2" />
        <path fillRule="evenodd" d="M168,144a32,32,0,1,0,0,64a32,32,0,1,0,0-64Zm0,16a16,16,0,1,1,0,32a16,16,0,1,1,0-32Z" />
      </g>
    </svg>
  );
}
