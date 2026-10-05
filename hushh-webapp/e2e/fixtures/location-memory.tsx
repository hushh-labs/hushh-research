import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LocationMemoryView } from "../../components/profile/location-memory-view";
import { PkmMemoryDetail } from "../../components/profile/pkm-memory-detail";
import { SettingsGroup, SettingsRow } from "../../components/app-ui/settings-ui";
import { buildLocationMemoryPresentation, resolveLocationMemoryField } from "../../lib/profile/location-memory-presentation";
import { ROUTES } from "../../lib/navigation/routes";

// Synthetic records only. Uses the production projection, rows and detail UI;
// auth/service and coordinator behavior are covered by the panel integration tests.
const initialData = {
  saved_places: { schema_version: 2, locations: [{ id: "fixture-home", label: "Home", category: "home", address: "Synthetic long address, ".repeat(16), addressDetails: { houseOrFlat: "12", landmark: "Synthetic library", postalCode: "12345" }, latitude: 10, longitude: 20 }] },
  visit_notes: { visits: [{ placeId: "fixture-cafe", label: "Cafe", note: "Synthetic first line\nSynthetic second line", rating: 4 }] },
  agent_memory: { note: "Editable first line\nEditable second line " + "Full note ".repeat(30) },
};

function Fixture() {
  const [data, setData] = useState(initialData);
  const presentation = buildLocationMemoryPresentation({ data });
  const [url, setUrl] = useState(() => new URL(window.location.href));
  const navigate = (href: string) => { window.history.pushState(null, "", href); setUrl(new URL(window.location.href)); };
  useEffect(() => {
    const pop = () => setUrl(new URL(window.location.href));
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  const field = resolveLocationMemoryField(presentation, url.searchParams.get("memory"));
  const location = url.pathname.startsWith(ROUTES.PKM_LOCATION);
  const detail = url.pathname === ROUTES.PKM_LOCATION_DETAIL;
  return <main className="app-page-shell mx-auto w-full max-w-xl p-4"><div className="space-y-5" data-pkm-workspace="true">
    <nav aria-label="Breadcrumb" className="flex min-h-11 items-center gap-3 text-[15px]">
      {location ? <button onClick={() => navigate(ROUTES.PKM)}>Memory</button> : <h1>Memory</h1>}
      {location ? <button onClick={() => navigate(ROUTES.PKM_LOCATION)}>Location</button> : null}
      {detail ? <span>Detail</span> : null}
    </nav>
    {!location ? <SettingsGroup title="Categories"><SettingsRow title="Location" description="Saved places and visits" onClick={() => navigate(ROUTES.PKM_LOCATION)} chevron /></SettingsGroup>
      : detail && field ? <PkmMemoryDetail card={field.card} displayLabel={field.label} displayValue={field.value} displayContext={field.context} hideBack sharingState="private" sharingPosture={null} sharingBusy={false} sharingError={null} canMutate={field.card.editable} saving={false} deleting={false} actionError={null} onBack={() => navigate(ROUTES.PKM_LOCATION)} onSharingChange={() => {}} onSave={(note) => { setData({ ...data, agent_memory: { note } }); navigate(ROUTES.PKM_LOCATION); }} onForget={() => {}} onOpenOwner={() => {}} />
        : <LocationMemoryView presentation={presentation} loading={false} error={false} onRetry={() => {}} onOpen={(selected) => navigate(`${ROUTES.PKM_LOCATION_DETAIL}?memory=${selected.selector}`)} />}
  </div></main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
