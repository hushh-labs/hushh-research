import Image from "next/image";
import type { ComponentPropsWithoutRef } from "react";

import { HUSHH_MARK_PATH } from "@/lib/brand/hushh-mark";
import { cn } from "@/lib/utils";

export function HushhMark({
  alt = "",
  className,
  imageClassName,
  priority = false,
  ...props
}: Omit<ComponentPropsWithoutRef<"span">, "children"> & {
  alt?: string;
  imageClassName?: string;
  priority?: boolean;
}) {
  return (
    <span
      {...props}
      className={cn("inline-flex shrink-0", className)}
      data-hushh-mark
    >
      <Image
        src={HUSHH_MARK_PATH}
        alt={alt}
        width={512}
        height={512}
        priority={priority}
        draggable={false}
        className={cn(
          "block h-full w-full select-none object-contain",
          imageClassName,
        )}
      />
    </span>
  );
}
