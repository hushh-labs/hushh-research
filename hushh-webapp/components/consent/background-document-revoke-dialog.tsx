"use client";
import { usePathname } from "next/navigation";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useBackLayer } from "@/lib/navigation/back-layers";

/** The shared overlay owns dismissal; route Back also cancels without changing authority. */
export function BackgroundDocumentRevokeDialog({ open, onOpenChange, busy, onConfirm }: {
  open: boolean; onOpenChange: (open: boolean) => void; busy: boolean; onConfirm: () => void;
}) {
  const pathname = usePathname();
  useBackLayer(pathname, open ? 4 : 0, () => { onOpenChange(false); return true; });
  return <AlertDialog open={open} onOpenChange={onOpenChange}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Stop One access?</AlertDialogTitle>
        <AlertDialogDescription>Drive access is separate. Saved files can’t be recalled.</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel data-voice-control-id="document-copy-cancel-revoke">Keep access</AlertDialogCancel>
        <AlertDialogAction data-voice-control-id="document-copy-confirm-revoke" variant="destructive" disabled={busy} onClick={onConfirm}>Stop access</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
