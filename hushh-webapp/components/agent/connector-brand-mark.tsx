import { cn } from "@/lib/utils";

/**
 * Official product marks vendored under public/icons/connectors (see its
 * README for sources). Only first-party Google products map here; a private
 * or custom connector has no official mark and renders nothing rather than
 * an invented logo.
 */
export type ConnectorBrand = "gmail" | "drive" | "calendar";

export function connectorBrandFor(value: unknown): ConnectorBrand | null {
  return value === "gmail" || value === "drive" || value === "calendar" ? value : null;
}

export function ConnectorBrandMark({
  brand,
  size = "md",
  className,
}: {
  brand: ConnectorBrand;
  /** md is a 32px icon well (card header); sm is a bare 14px inline mark (activity row). */
  size?: "sm" | "md";
  className?: string;
}) {
  const image = (
    // eslint-disable-next-line @next/next/no-img-element -- local static SVG; next/image adds nothing here.
    <img
      src={`/icons/connectors/${brand}.svg`}
      alt=""
      data-connector-brand={brand}
      className={size === "sm" ? cn("size-3.5 shrink-0 object-contain", className) : "size-5 object-contain"}
    />
  );
  if (size === "sm") return image;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-background shadow-sm",
        className,
      )}
    >
      {image}
    </span>
  );
}
