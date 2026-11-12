"use client";

import { useMemo } from "react";
import { toast } from "sonner";
import { useTypographyScope } from "./typography-scope";

/** Capture the initiating surface on feedback that outlives its portal. */
export function useTypographyToast() {
  const className = useTypographyScope();
  return useMemo(() => !className ? toast : ({
    success: (...[message, options]: Parameters<typeof toast.success>) => toast.success(message, { ...options, className: [className, options?.className].filter(Boolean).join(" ") || undefined }),
    error: (...[message, options]: Parameters<typeof toast.error>) => toast.error(message, { ...options, className: [className, options?.className].filter(Boolean).join(" ") || undefined }),
    info: (...[message, options]: Parameters<typeof toast.info>) => toast.info(message, { ...options, className: [className, options?.className].filter(Boolean).join(" ") || undefined }),
  }), [className]);
}
