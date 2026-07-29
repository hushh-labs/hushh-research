import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"

function installAnimationFrameMock() {
  return vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      callback(0)
      return 1
    })
}

describe("modal focus restoration", () => {
  it("restores focus to the dialog trigger after close", async () => {
    const requestAnimationFrameMock = installAnimationFrameMock()

    render(
      <Dialog>
        <DialogTrigger>Open dialog</DialogTrigger>
        <DialogContent>
          <DialogTitle>Dialog title</DialogTitle>
          <DialogDescription>Dialog description</DialogDescription>
          <DialogClose>Close dialog</DialogClose>
        </DialogContent>
      </Dialog>,
    )

    const trigger = screen.getByRole("button", { name: "Open dialog" })
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole("button", { name: "Close dialog" }))

    await waitFor(() => {
      expect(document.activeElement).toBe(trigger)
    })

    requestAnimationFrameMock.mockRestore()
  })

  it("restores focus to the sheet trigger after close", async () => {
    const requestAnimationFrameMock = installAnimationFrameMock()

    render(
      <Sheet>
        <SheetTrigger>Open sheet</SheetTrigger>
        <SheetContent>
          <SheetTitle>Sheet title</SheetTitle>
          <SheetDescription>Sheet description</SheetDescription>
          <SheetClose>Close sheet</SheetClose>
        </SheetContent>
      </Sheet>,
    )

    const trigger = screen.getByRole("button", { name: "Open sheet" })
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole("button", { name: "Close sheet" }))

    await waitFor(() => {
      expect(document.activeElement).toBe(trigger)
    })

    requestAnimationFrameMock.mockRestore()
  })

  it("restores focus to the alert dialog trigger after cancel", async () => {
    const requestAnimationFrameMock = installAnimationFrameMock()

    render(
      <AlertDialog>
        <AlertDialogTrigger>Open alert</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>Alert title</AlertDialogTitle>
          <AlertDialogDescription>Alert description</AlertDialogDescription>
          <AlertDialogCancel>Cancel alert</AlertDialogCancel>
        </AlertDialogContent>
      </AlertDialog>,
    )

    const trigger = screen.getByRole("button", { name: "Open alert" })
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole("button", { name: "Cancel alert" }))

    await waitFor(() => {
      expect(document.activeElement).toBe(trigger)
    })

    requestAnimationFrameMock.mockRestore()
  })
})
