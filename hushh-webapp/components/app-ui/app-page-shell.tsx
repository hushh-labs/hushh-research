"use client"; // Kept "use client" because of data-attributes/events

import { forwardRef, type ElementType, type ComponentPropsWithoutRef } from "react";
import { NativeTestBeacon, type NativeTestAuthState, type NativeTestDataState } from "@/components/app-ui/native-test-beacon";
import { cn } from "@/lib/utils";

export type AppPageShellWidth = "reading" | "standard" | "expanded" | "narrow" | "content" | "wide" | "profile";
export type AppPageDensity = "compact" | "comfortable";

const WIDTH_CLASSES: Record<AppPageShellWidth, string> = {
  reading: "max-w-[54rem]", narrow: "max-w-[54rem]", profile: "max-w-[54rem]",
  standard: "max-w-[90rem]", content: "max-w-[90rem]",
  expanded: "max-w-[96rem]", wide: "max-w-[96rem]",
};

const DENSITY_CLASSES: Record<AppPageDensity, string> = {
  compact: "px-4 sm:px-6",
  comfortable: "px-6 sm:px-12",
};

export const AppPageShell = forwardRef(function AppPageShell<T extends ElementType = "main">({
  as,
  width = "standard",
  density = "compact",
  nativeTest,
  className,
  children,
  ...props
}: {
  as?: T;
  width?: AppPageShellWidth;
  density?: AppPageDensity;
  nativeTest?: any; // Simplified for brevity
} & ComponentPropsWithoutRef<T>, ref: any) {
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
});

// Helper for cleaner region composition
export const AppPageHeaderRegion = ({ className, ...props }: ComponentPropsWithoutRef<"div">) => (
  <div className={cn("sticky top-0 z-10 w-full pt-4 pb-2 backdrop-blur-sm", className)} {...props} />
);

export const AppPageContentRegion = ({ className, ...props }: ComponentPropsWithoutRef<"div">) => (
  <div className={cn("mt-4 w-full min-h-[calc(100vh-200px)]", className)} {...props} />
);
