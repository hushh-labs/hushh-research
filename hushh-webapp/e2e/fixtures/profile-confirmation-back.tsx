import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { useWebHistoryBack } from "../../lib/navigation/web-history-back";
import { pushProfilePaneLocation, resolveProfilePaneUrlState } from "../../lib/navigation/profile-pane";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "../../components/ui/sheet";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "../../components/ui/alert-dialog";

const subscribe = (listener: () => void) => {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
};
const snapshot = () => window.location.search;

function Fixture() {
  const search = useSyncExternalStore(subscribe, snapshot);
  useWebHistoryBack("/one", search);
  const pane = resolveProfilePaneUrlState(search);
  const [confirmation, setConfirmation] = useState<"Reset" | "Delete" | "Refusing" | null>(null);
  const [mutations, setMutations] = useState(0);
  const title = pane.location.detail ? "Details" : pane.location.panel ? "Account" : "Profile";
  return (
    <>
      <h1>One</h1>
      <button onClick={() => pushProfilePaneLocation("/one", search, { panel: null, detail: null })}>Open Profile</button>
      <output data-testid="mutation-count">{mutations}</output>
      <Sheet open={pane.open} modal onOpenChange={() => window.history.back()}>
        <SheetContent showCloseButton={false} contentDragDismiss={false}>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>History contract fixture</SheetDescription>
          {title === "Profile" ? (
            <button onClick={() => pushProfilePaneLocation("/one", search, { panel: "account", detail: null })}>Open Account</button>
          ) : (
            <>
              <button onClick={() => pushProfilePaneLocation("/one", search, { panel: "account", detail: "phone" })}>Open Details</button>
              {(["Reset", "Delete", "Refusing"] as const).map(action => (
                <button key={action} onClick={() => setConfirmation(action)}>{action} confirmation</button>
              ))}
            </>
          )}
        </SheetContent>
      </Sheet>
      <AlertDialog open={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null); }}>
        <AlertDialogContent onEscapeKeyDown={event => { if (confirmation === "Refusing") event.preventDefault(); }}>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation} account?</AlertDialogTitle>
            <AlertDialogDescription>Cancel or confirm the account action.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => setMutations(count => count + 1)}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

window.history.replaceState({ __NA: true, caller: "preserve" }, "", "/one");
createRoot(document.getElementById("root")!).render(<Fixture />);
