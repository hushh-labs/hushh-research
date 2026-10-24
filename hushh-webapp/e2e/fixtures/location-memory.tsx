import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LocationMemoryView } from "../../components/profile/location-memory-view";
import { PkmMemoryDetail } from "../../components/profile/pkm-memory-detail";
import { SegmentedTabs, SettingsGroup, SettingsRow } from "../../components/app-ui/settings-ui";
import { buildLocationMemoryPresentation, resolveLocationMemoryField } from "../../lib/profile/location-memory-presentation";
import { ROUTES } from "../../lib/navigation/routes";
import { PkmSettingsShell } from "../../components/profile/pkm-settings-shell";
import { SoulMemoryPanelBody } from "../../components/profile/soul-memory-panel";
import type { SoulMemoryModel } from "../../components/profile/use-soul-memory-model";
import { PkmNaturalPanelBody } from "../../components/profile/pkm-natural-panel";
import type { PkmNaturalModel, MemoryWorkspaceTab } from "../../components/profile/use-pkm-natural-model";
import type { AgentPkmPreviewCard } from "../../lib/agent/agent-pkm-memory";

const MEMORY = "# memory.md\n\n## Facts\n- Synthetic detail with a long reference: " + "reference".repeat(14)
  + "\n- A second detail that stays aligned.\n\n## Preferences\n- Concise answers.\n\n## Commitments\n- Review next week.\n";

function MemoryWorkspace() {
  const addFixture = new URLSearchParams(window.location.search).get("workspace") === "add";
  const [draft, changeDraft] = useState(MEMORY);
  const [editing, setEditing] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<MemoryWorkspaceTab>("add");
  const [captureText, changeCaptureText] = useState("");
  const [captureCards, setCaptureCards] = useState<AgentPkmPreviewCard[]>([]);
  const [captureMessage, setCaptureMessage] = useState<string | null>(null);
  const [identifierApproved, setIdentifierApproved] = useState(false);
  const model: SoulMemoryModel = {
    active: true, verified: true, current: { document: { markdown: MEMORY, persisted: true }, draft },
    editing, loading: false, failed: false, saving: false, conflict: false, sync: undefined,
    beginEdit: () => setEditing(true), cancelEdit: () => { changeDraft(MEMORY); setEditing(false); },
    changeDraft, save: async () => { setEditing(false); }, retrySync: async () => undefined,
    retryLoad() {}, reloadLatest() {},
  };
  const naturalModel = {
    authLoading: false, signedIn: true, canOpen: true, isVaultUnlocked: true,
    nativeDataState: "ready", locationView: false, selectedCard: null,
    selectedMetadataDomain: null, workspaceTab, setWorkspaceTab,
    soul: model, homeSearchQuery: "", setHomeSearchQuery() {},
    metadata: {}, bootstrapLoading: false, bootstrapError: null,
    memoryCards: [], memoryCardsLoading: false, memoryCardsLoadError: null,
    categories: [], recentMemories: [], trimmedQuery: "", searchResults: [],
    matchedCategories: [], visibleMetadataDomains: [], sharingManifests: {},
    sharingManifestsLoading: false, sharingActionKey: null, ownerId: "synthetic-owner",
    exportBusy: false, exportStatus: null, exportError: null,
    updateSharingBundles() {}, handleExportMemory() {}, setRefreshNonce() {},
    setMemoryCardsNonce() {},
    captureText, changeCaptureText: (value: string) => { changeCaptureText(value); setCaptureCards([]); },
    captureCards, captureSaveableCards: captureCards, captureLoading: false,
    captureSaving: false, captureMessage, setCaptureMessage,
    identifierProcessingApproved: () => identifierApproved,
    setIdentifierProcessingApproval: setIdentifierApproved,
    captureHasSharedRecipients: false, captureSharingImpactAcknowledged: false,
    setCaptureSharingImpactAcknowledged() {}, captureHasUnresolvedSource: false,
    captureUnresolvedSections: [], captureRetryingSectionKey: null,
    domainTitles: new Map([["preferences", "Preferences"]]),
    previewMemoryCapture: async () => setCaptureCards([{
      card_id: "synthetic-review", source_text: captureText,
      write_mode: "confirm_first", target_domain: "preferences",
    }]),
    retryCaptureSection: async () => {}, saveMemoryCapture: async () => setCaptureMessage("Synthetic save acknowledged."),
  } as unknown as PkmNaturalModel;
  return <PkmSettingsShell title="Memory" titleRole="agent" titleVisuallyHidden shellWidth="agent">
    {addFixture ? <PkmNaturalPanelBody model={naturalModel} view="home" locationMemoryId={null} />
      : <div className="space-y-[var(--page-header-section-gap)]">
        <SegmentedTabs tabSetId="memory" ariaLabel="Memory" value="browse" options={[
          { value: "browse", label: "Saved" }, { value: "add", label: "Add" },
        ]} mobileColumns={2} variant="agent-top" onValueChange={() => {}} />
        <SoulMemoryPanelBody model={model} />
      </div>}
  </PkmSettingsShell>;
}

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

createRoot(document.getElementById("root")!).render(
  new URLSearchParams(window.location.search).has("workspace") ? <MemoryWorkspace /> : <Fixture />,
);
