"use client";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

/** Existing consent revocation confirmation, including paid calendar-time consequences. */
export function ConsentSharingRevokeDialog({ open, onOpenChange, counterpartLabel, onConfirm }: {
  open: boolean; onOpenChange: (open: boolean) => void; counterpartLabel: string; onConfirm: () => void;
}) {
  return (
          <AlertDialog
            open={open}
            onOpenChange={onOpenChange}
          >
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Stop sharing with {counterpartLabel}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  They lose this access right away. The change stays visible in
                  History. For paid access, unused calendar time is refunded.
                  You bear processing costs that are not returned; a refund can
                  reduce your earnings below zero. Revocation remains available
                  while settlement is being reconciled.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep sharing</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={onConfirm}
                  className="h-11 w-full sm:w-auto"
                >
                  Stop sharing
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
  );
}
