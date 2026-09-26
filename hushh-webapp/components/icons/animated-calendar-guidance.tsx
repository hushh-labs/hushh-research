import type { SVGProps } from "react";

// Official Phosphor duotone paths, split only at their existing subpaths to
// animate the detail while preserving the silhouette and native viewBox.
export function AnimatedClock(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden focusable="false" {...props}>
      <path d="M224,128a96,96,0,1,1-96-96A96,96,0,0,1,224,128Z" opacity="0.2" />
      <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Z" />
      <path d="M120,128V72a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Z" />
      <path data-clock-hands d="M128,120h56a8,8,0,0,1,0,16H128a8,8,0,0,1,0-16Z" className="origin-center transition-transform duration-0 ease-in-out motion-safe:group-hover/controls:duration-700 motion-safe:group-hover/controls:rotate-360 motion-reduce:transition-none" />
    </svg>
  );
}

export function AnimatedEye({ surfaceClassName = "fill-background", ...props }: SVGProps<SVGSVGElement> & { surfaceClassName?: string }) {
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden focusable="false" {...props}>
      <path d="M128,56C48,56,16,128,16,128s32,72,112,72,112-72,112-72S208,56,128,56Z" opacity="0.2" />
      <path d="M247.31,124.76c-.35-.79-8.82-19.58-27.65-38.41C194.57,61.26,162.88,48,128,48S61.43,61.26,36.34,86.35C17.51,105.18,9,124,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208s66.57-13.26,91.66-38.34c18.83-18.83,27.3-37.61,27.65-38.4A8,8,0,0,0,247.31,124.76ZM128,192c-30.78,0-57.67-11.19-79.93-33.25A133.47,133.47,0,0,1,25,128,133.33,133.33,0,0,1,48.07,97.25C70.33,75.19,97.22,64,128,64s57.67,11.19,79.93,33.25A133.46,133.46,0,0,1,231.05,128C223.84,141.46,192.43,192,128,192Z" />
      <g data-eye-pupil className="transition-transform duration-300 ease-in-out motion-safe:group-hover/controls:translate-x-[24px] motion-reduce:transition-none">
        <circle cx="128" cy="128" r="40" className={surfaceClassName} />
        <path d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Z" />
      </g>
    </svg>
  );
}
