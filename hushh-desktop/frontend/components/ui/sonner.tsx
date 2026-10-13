"use client"

import type { CSSProperties } from "react"
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "@/components/theme-provider"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="top-center"
      duration={3600}
      expand={false}
      visibleToasts={2}
      gap={10}
      icons={{
        success: <CircleCheckIcon className="size-4" aria-hidden="true" />,
        info: <InfoIcon className="size-4" aria-hidden="true" />,
        warning: <TriangleAlertIcon className="size-4" aria-hidden="true" />,
        error: <OctagonXIcon className="size-4" aria-hidden="true" />,
        loading: <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            "w-full rounded-[20px] border border-border/70 px-4 py-3 text-center shadow-lg shadow-black/5 sm:max-w-[22rem] sm:text-left",
          title: "text-[13px] font-medium leading-5 tracking-[-0.01em] text-center sm:text-left",
          description:
            "line-clamp-2 text-[12px] leading-5 text-muted-foreground text-center sm:text-left",
          content: "flex-1 gap-1.5 text-center sm:text-left",
          closeButton:
            "left-auto right-3 top-3 border-border/70 bg-background/90 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        },
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          "--offset": "1rem",
          "--mobile-offset-left": "1rem",
          "--mobile-offset-right": "1rem",
          "--mobile-offset-top": "calc(var(--top-inset, 0px) + 12px)",
          "--width": "22rem",
        } as CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
