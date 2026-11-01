import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PersonProfilePreview } from "@/components/connections/person-profile-preview";
import { CirclePersonSelectionRow } from "@/components/one-location/redesign/circles/circle-person-selection-row";
import { ContactRow } from "@/components/one-location/redesign/contact-picker/atoms";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { dismissTopmostOverlay } from "@/lib/navigation/back-layers";
import { useWebHistoryBack } from "@/lib/navigation/web-history-back";

publishValidatedAuthSessionOwner("fixture-requester");
function Fixture() {
  const [selected, setSelected] = useState(false);
  const [query, setQuery] = useState("");
  useWebHistoryBack(window.location.pathname, window.location.search);
  return <><Dialog modal open><DialogContent data-profile-type-scale="circles" aria-label="Add people to circle">
    <DialogTitle>Add people to circle</DialogTitle>
    <input aria-label="Search connections" value={query} onChange={event => setQuery(event.target.value)} />
    <CirclePersonSelectionRow person={{ userId: "peer", displayName: "Aarav Sharma", photoUrl: null } as Parameters<typeof CirclePersonSelectionRow>[0]["person"]}
      selected={selected} disabled={false} ariaLabel="Select Aarav for circle" onToggle={() => setSelected(!selected)} />
    <ContactRow userId="second-peer" label="Maya Singh" selected={false} busy={false} ready onAdd={() => { throw new Error("Profile taps must not add contacts"); }} onRemove={() => {}} />
    <p role="status">{selected ? "1 selected" : "0 selected"}</p>
  </DialogContent></Dialog><PersonProfilePreview />
  <button type="button" data-fixture-native-back onClick={() => dismissTopmostOverlay()}>Native Back</button></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
