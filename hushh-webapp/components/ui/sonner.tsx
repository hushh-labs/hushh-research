"use client"

import type { CSSProperties } from "react"
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
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
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            "mx-auto w-[min(92vw,22rem)] rounded-[20px] border border-border/70 px-4 py-3 text-center shadow-lg shadow-black/5 sm:text-left",
          title: "text-[13px] font-medium leading-5 tracking-[-0.01em] text-center sm:text-left",
          description:
            "line-clamp-2 text-[12px] leading-5 text-muted-foreground text-center sm:text-left",
          content: "flex-1 gap-1.5 text-center sm:text-left",
          closeButton:
            "left-auto right-3 top-3 border-border/70 bg-background/90 text-muted-foreground hover:bg-muted hover:text-foreground",
        },
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          "--offset": "1rem",
        } as CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
