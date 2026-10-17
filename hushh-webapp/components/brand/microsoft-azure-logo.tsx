import { useId } from "react";

import { cn } from "@/lib/utils";

/**
 * The Microsoft Azure brand mark (the gradient "A"). Keep this isolated as a brand
 * asset: it names a provider, it is not an app accent or a replacement for Hussh
 * iconography.
 *
 * `decorative` hides it from assistive technology where the provider's name
 * already sits beside it, so a screen reader does not hear the name twice.
 */
export function MicrosoftAzureLogo({
  className,
  title = "Microsoft Azure",
  decorative = false,
}: {
  className?: string;
  title?: string;
  decorative?: boolean;
}) {
  const id = useId();
  const leg = `${id}-leg`;
  const shade = `${id}-shade`;
  const face = `${id}-face`;

  return (
    <svg
      viewBox="0 0 96 96"
      className={cn("h-6 w-6 shrink-0", className)}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": title })}
    >
      {decorative ? null : <title>{title}</title>}
      <defs>
        <linearGradient id={leg} x1="42.828" y1="12.688" x2="15.787" y2="92.574" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#114A8B" />
          <stop offset="1" stopColor="#0669BC" />
        </linearGradient>
        <linearGradient id={shade} x1="51.275" y1="49.917" x2="45.02" y2="52.032" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopOpacity="0.3" />
          <stop offset="0.071" stopOpacity="0.2" />
          <stop offset="0.321" stopOpacity="0.1" />
          <stop offset="0.623" stopOpacity="0.05" />
          <stop offset="1" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={face} x1="47.835" y1="10.358" x2="77.518" y2="89.439" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3CCBF4" />
          <stop offset="1" stopColor="#2892DF" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${leg})`}
        d="M33.338 6.544h26.038l-27.03 80.087a4.152 4.152 0 0 1-3.933 2.824H8.149a4.145 4.145 0 0 1-3.928-5.47L29.404 9.368a4.152 4.152 0 0 1 3.934-2.825z"
      />
      <path
        fill="#0078D4"
        d="M71.175 60.261h-41.29a1.911 1.911 0 0 0-1.305 3.309l26.532 24.764a4.171 4.171 0 0 0 2.846 1.121h23.38z"
      />
      <path
        fill={`url(#${shade})`}
        d="M33.338 6.544a4.118 4.118 0 0 0-3.943 2.879L4.252 83.917a4.14 4.14 0 0 0 3.908 5.538h20.787a4.443 4.443 0 0 0 3.41-2.9l5.014-14.777 17.91 16.705a4.237 4.237 0 0 0 2.666.972H81.24L71.024 60.261l-29.781.007L59.47 6.544z"
      />
      <path
        fill={`url(#${face})`}
        d="M66.595 9.364a4.145 4.145 0 0 0-3.928-2.82H33.648a4.146 4.146 0 0 1 3.928 2.82l25.184 74.62a4.146 4.146 0 0 1-3.928 5.472h29.02a4.146 4.146 0 0 0 3.927-5.472z"
      />
    </svg>
  );
}
