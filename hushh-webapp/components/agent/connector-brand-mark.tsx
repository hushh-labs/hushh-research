import { ProfilePaneConnectorsIcon } from "@/components/profile/profile-pane-icons";
import {
  CONNECTOR_ARTWORK,
  connectorArtworkId,
  resolveConnectorArtwork,
} from "@/lib/profile/connector-artwork";
import { cn } from "@/lib/utils";

/**
 * Official product marks vendored under public/icons/connectors (see its
 * README for sources).
 */
export type ConnectorBrand = "gmail" | "drive" | "calendar" | "contacts";

export function connectorBrandFor(value: unknown): ConnectorBrand | null {
  return value === "gmail" ||
    value === "drive" ||
    value === "calendar" ||
    value === "contacts"
    ? value
    : null;
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

/**
 * Shared pure-vector connector glyph backed by CONNECTOR_ARTWORK.
 * Uses 22px optical size in Profile rows or a subtle well in Connect/sheet tiles.
 */
export function ConnectorVectorGlyph({
  id,
  variant = "profile",
  className,
}: {
  id: string;
  variant?: "profile" | "tile";
  className?: string;
}) {
  const key = connectorArtworkId(id) ?? resolveConnectorArtwork(id);
  const artwork = key ? CONNECTOR_ARTWORK[key] : null;
  if (variant === "tile") {
    return (
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg bg-background text-foreground shadow-sm",
          className,
        )}
        aria-hidden="true"
      >
        {artwork ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/icons/connectors/${artwork.file}`}
            alt=""
            data-connector-brand={key ?? id}
            className={cn("size-6 object-contain", artwork.monochrome && "dark:invert")}
          />
        ) : (
          <ProfilePaneConnectorsIcon size={18} />
        )}
      </span>
    );
  }
  return (
    <span
      className={cn("inline-flex size-6 shrink-0 items-center justify-center", className)}
      aria-hidden="true"
    >
      {artwork ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/icons/connectors/${artwork.file}`}
          alt=""
          data-connector-brand={key ?? id}
          className={cn("size-[22px] object-contain", artwork.monochrome && "dark:invert")}
        />
      ) : (
        <ProfilePaneConnectorsIcon size={22} />
      )}
    </span>
  );
}
