import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { useWebHistoryBack } from "../../lib/navigation/web-history-back";
import { pushProfilePaneLocation, resolveProfilePaneUrlState } from "../../lib/navigation/profile-pane";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "../../components/ui/sheet";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "../../components/ui/alert-dialog";

import accountStyles from "../../components/profile/profile-your-account.module.css";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

const subscribe = (listener: () => void) => {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
};
const snapshot = () => window.location.search;
const laggedShell = new URLSearchParams(window.location.search).has("lagged-shell");

function Fixture() {
  const search = useSyncExternalStore(subscribe, snapshot);
  const [shellSearch, setShellSearch] = useState("");
  useWebHistoryBack("/one", laggedShell ? shellSearch : search);
  const pane = resolveProfilePaneUrlState(search);
  const [confirmation, setConfirmation] = useState<"Reset" | "Delete" | "Refusing" | null>(null);
  const [editingName, setEditingName] = useState(false);
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
              {laggedShell ? <button onClick={() => setShellSearch("previous=1")}>Commit stale shell query</button> : null}
              <button onClick={() => setEditingName(true)}>Edit display name</button>
              {editingName ? (
                <div className={accountStyles.paneEditor}>
                  <label htmlFor="display-name">Display name</label>
                  <Input id="display-name" defaultValue="Test Person" />
                  <div data-display-name-actions>
                    <Button size="compact" variant="outline" onClick={() => setEditingName(false)}>Cancel</Button>
                    <Button size="compact">Save name</Button>
                  </div>
                </div>
              ) : null}
              <button onClick={() => pushProfilePaneLocation("/one", search, { panel: "account", detail: "phone" })}>Open Details</button>
              {(["Reset", "Delete", "Refusing"] as const).map(action => (
                <button key={action} onClick={() => setConfirmation(action)}>{action} confirmation</button>
              ))}
            </>
          )}
          <AlertDialog open={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null); }}>
            <AlertDialogContent className={`${accountStyles.accountDialogCompact} ${accountStyles.accountDialog}`} onEscapeKeyDown={event => { if (confirmation === "Refusing") event.preventDefault(); }}>
              <AlertDialogHeader>
                <AlertDialogTitle>{confirmation} account?</AlertDialogTitle>
                <AlertDialogDescription>Cancel or confirm the account action.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant={confirmation === "Delete" ? "destructive" : "default"} onClick={() => setMutations(count => count + 1)}>{confirmation === "Refusing" ? "Confirm" : `${confirmation} account`}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </SheetContent>
      </Sheet>
    </>
  );
}

window.history.replaceState({ __NA: true, caller: "preserve" }, "", "/one");
createRoot(document.getElementById("root")!).render(<Fixture />);
