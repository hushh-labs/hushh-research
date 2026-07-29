"use client"

import * as React from "react"

function focusElement(element: Element | null) {
  if (!(element instanceof HTMLElement)) return
  if (!document.contains(element)) return
  element.focus({ preventScroll: true })
}

export function useRestoreFocusOnClose(
  onOpenChange?: (open: boolean) => void,
) {
  const lastFocusedElementRef = React.useRef<Element | null>(null)

  return React.useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        lastFocusedElementRef.current = document.activeElement
      }

      onOpenChange?.(nextOpen)

      if (!nextOpen) {
        window.requestAnimationFrame(() => {
          focusElement(lastFocusedElementRef.current)
        })
      }
    },
    [onOpenChange],
  )
}
