"use client"

import type { CSSProperties } from "react"
import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  TriangleAlertIcon,
} from "@/components/icons"
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
        error: <CircleAlertIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            "w-full rounded-[16px] border px-4 py-3 shadow-lg sm:max-w-[22rem]",
          // Clamped, and this is the only place a toast's height is
          // actually bounded. `toast.error("...")` sets the TITLE, which is
          // nearly every toast in this app, and the title used to have no
          // ceiling at all -- the one part everything used was the one part
          // that could grow to four lines.
          //
          // Copy alone cannot be the guarantee: a server message reaches this
          // element through `oneLocationErrorMessage`, whose only length rule
          // is 160 characters. So the ceiling lives here, where every string
          // ends up regardless of who wrote it.
          title:
            "line-clamp-2 text-[14px] font-semibold leading-5 tracking-[-0.01em] text-left",
          // One line, so a toast carrying both still reads as a glance rather
          // than a paragraph.
          description:
            "line-clamp-1 text-[13px] leading-[18px] text-left",
          content: "min-w-0 flex-1 gap-1 text-left",
          closeButton:
            "left-auto right-1 top-1 text-muted-foreground hover:bg-muted hover:text-foreground",
        },
      }}
      style={
        {
          "--normal-bg": "var(--app-settings-surface)",
          "--normal-text": "var(--app-label)",
          "--normal-border": "var(--app-settings-border)",
          "--border-radius": "16px",
          "--offset": "1rem",
          "--mobile-offset-left": "max(1rem, env(safe-area-inset-left, 0px))",
          "--mobile-offset-right": "max(1rem, env(safe-area-inset-right, 0px))",
          "--mobile-offset-top": "calc(var(--top-inset, 0px) + 12px)",
          "--width": "22rem",
        } as CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
