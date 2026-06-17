"use client";

import { forwardRef, type ElementType, type ComponentPropsWithoutRef, type CSSProperties, type Ref, type ReactNode } from "react";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { cn } from "@/lib/utils";

export type AppPageShellWidth = "reading" | "standard" | "expanded" | "narrow" | "content" | "wide" | "profile";
export type AppPageDensity = "compact" | "comfortable";

export const APP_SHELL_MAX_WIDTHS: Record<AppPageShellWidth, string> = {
  reading: "max-w-[54rem]", narrow: "max-w-[54rem]", profile: "max-w-[54rem]",
  standard: "max-w-[90rem]", content: "max-w-[90rem]",
  expanded: "max-w-[96rem]", wide: "max-w-[96rem]",
};

const WIDTH_CLASSES = APP_SHELL_MAX_WIDTHS;

const DENSITY_CLASSES: Record<AppPageDensity, string> = {
  compact: "px-4 sm:px-6",
  comfortable: "px-6 sm:px-12",
};

export const APP_SHELL_FRAME_CLASSNAME =
  "mx-auto w-full px-[var(--page-inline-gutter-standard)]";

export const APP_SHELL_FRAME_STYLE: CSSProperties = {
  maxWidth: "90rem",
};

export const APP_MEASURE_STYLES: Record<"reading" | "standard" | "expanded", CSSProperties> = {
  reading: { maxWidth: "54rem" },
  standard: { maxWidth: "90rem" },
  expanded: { maxWidth: "96rem" },
} as const;

type AppPageShellProps<T extends ElementType> = {
  as?: T;
  width?: AppPageShellWidth;
  density?: AppPageDensity;
  nativeTest?: any;
} & ComponentPropsWithoutRef<T>;

const AppPageShellInner = <T extends ElementType = "main">({
  as,
  width = "standard",
  density = "compact",
  nativeTest,
  className,
  children,
  ...props
}: AppPageShellProps<T>, ref: any) => {
  const Component = as ?? "main";

  return (
    <Component
      ref={ref}
      className={cn(
        "mx-auto w-full transition-all duration-300",
        WIDTH_CLASSES[width],
        DENSITY_CLASSES[density],
        className
      )}
      data-app-density={density}
      {...props}
    >
      {nativeTest && <NativeTestBeacon {...nativeTest} />}
      {children}
    </Component>
  );
};

export const AppPageShell = forwardRef(AppPageShellInner) as <T extends ElementType = "main">(
  props: AppPageShellProps<T> & { ref?: Ref<any> }
) => ReactNode;

// Helper for cleaner region composition
export const AppPageHeaderRegion = ({ className, ...props }: ComponentPropsWithoutRef<"div">) => (
  <div className={cn("sticky top-0 z-10 w-full pt-4 pb-2 backdrop-blur-sm", className)} {...props} />
);

export const AppPageContentRegion = ({ className, ...props }: ComponentPropsWithoutRef<"div">) => (
  <div className={cn("mt-4 w-full min-h-[calc(100vh-200px)]", className)} {...props} />
);
