"use client"

import { type CSSProperties } from "react"
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

// Feature: Define theme-aware custom styles or override defaults here
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="top-center"
      duration={4000} // Increased slightly for better readability
      expand={true}   // Feature: Allow expansion for multiple notifications
      visibleToasts={3} // Feature: Show more toasts to avoid queue overflow
      gap={12}
      icons={{
        success: <CircleCheckIcon className="size-4 text-emerald-500" />,
        info: <InfoIcon className="size-4 text-blue-500" />,
        warning: <TriangleAlertIcon className="size-4 text-amber-500" />,
        error: <OctagonXIcon className="size-4 text-rose-500" />,
        loading: <Loader2Icon className="size-4 animate-spin text-primary" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            "w-full rounded-[20px] border border-border/70 px-4 py-3 text-center shadow-lg shadow-black/5 sm:max-w-[22rem] sm:text-left transition-all duration-300",
          title: "text-[13px] font-semibold leading-5 tracking-[-0.01em]",
          description:
            "line-clamp-2 text-[12px] leading-5 text-muted-foreground",
          content: "flex-1 gap-1.5",
          // Feature: Styled action buttons to match your UI
          actionButton: "bg-primary text-primary-foreground text-[11px] px-3 py-1.5 rounded-full font-medium hover:opacity-90",
          cancelButton: "bg-muted text-muted-foreground text-[11px] px-3 py-1.5 rounded-full font-medium hover:bg-muted/80",
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
          "--offset": "1.5rem", // Increased offset for better visual breathing room
          "--mobile-offset-left": "1rem",
          "--mobile-offset-right": "1rem",
          "--mobile-offset-top": "calc(var(--top-inset, 0px) + 20px)",
          "--width": "22rem",
        } as CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }