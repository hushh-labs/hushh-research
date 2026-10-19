import { createRoot } from "react-dom/client";
import { useCallback, useState, type ReactNode } from "react";
import { ProfileStackNavigator } from "../../components/profile/profile-stack-navigator";
import { NativeFeaturePage } from "../../components/app-ui/native-feature-page";
import { SettingsGroup, SettingsRow } from "../../components/app-ui/settings-ui";
import { AccountProfileIcon, GmailAgentIcon } from "../../components/icons/agents";
import accountStyles from "../../components/profile/profile-your-account.module.css";
import { AppPageShell } from "../../components/app-ui/app-page-shell";
import { Sheet, SheetContent, SheetTitle } from "../../components/ui/sheet";
import { Dialog, DialogContent, DialogTitle } from "../../components/ui/dialog";

const pane = document.getElementById("root")!.dataset.pane === "true";

function NestedOverlayStudy() {
  const [sheet, setSheet] = useState(false), [preview, setPreview] = useState(false);
  return <NativeFeaturePage pane open title="Your account" owner="synthetic" context="photo"
    onBack={() => undefined} onClose={() => undefined}>
    <button onClick={() => setSheet(true)}>Photo options</button>
    <Sheet open={sheet} onOpenChange={setSheet}>
      <SheetContent side="bottom" showCloseButton={false}>
        <SheetTitle>Photo options</SheetTitle>
        <button onClick={() => { setSheet(false); setPreview(true); }}>View photo</button>
      </SheetContent>
    </Sheet>
    <Dialog open={preview} onOpenChange={setPreview}>
      <DialogContent><DialogTitle>Photo preview</DialogTitle><p>Public preview</p></DialogContent>
    </Dialog>
  </NativeFeaturePage>;
}

function NestedProfileStudy() {
  const [detail, setDetail] = useState(false);
  const [heading, setHeading] = useState("Preferences");
  const onActiveEntryChange = useCallback((entry: { title: ReactNode } | null) => {
    setHeading(typeof entry?.title === "string" ? entry.title : "Preferences");
  }, []);
  const entries = [{ key: "preferences", title: "Preferences", content:
    <div style={{ height: 1400 }}><button style={{ marginTop: 360 }} onClick={() => setDetail(true)}>Open Voice</button></div> },
    ...(detail ? [{ key: "voice", title: "Voice", content: <div style={{ height: 100 }}>Public voice controls</div> }] : [])];
  return <NativeFeaturePage pane contentInset="profile" open title={heading}
    owner="synthetic" context={detail ? "voice" : "preferences"} onBack={() => setDetail(false)} onClose={() => undefined}>
    <AppPageShell width="reading" fitContent className="profile-pane-page profile-pane-page--inner">
      <ProfileStackNavigator rootContent={null} entries={entries} resetScroll={false} onActiveEntryChange={onActiveEntryChange} />
    </AppPageShell>
  </NativeFeaturePage>;
}

createRoot(document.getElementById("root")!).render(
  document.getElementById("root")!.dataset.overlays === "true" ? <NestedOverlayStudy /> :
  document.getElementById("root")!.dataset.stack === "true" ? <NestedProfileStudy /> :
  <NativeFeaturePage pane={pane} contentInset={pane ? "profile" : undefined} open title="Preferences" owner="synthetic" context="synthetic" onBack={() => undefined}
    bodyClassName="profile-pane-scroll-root"
    onClose={document.getElementById("root")!.dataset.pane === "true" ? () => undefined : undefined}>
    <AppPageShell width="reading" fitContent className={pane ? "profile-pane-page profile-pane-page--inner" : undefined}>
    <p data-content-start>Public preference choices</p>
    <div data-profile-stack-content="true" className={accountStyles.paneAccountContent}>
      <SettingsGroup>
        <SettingsRow icon={AccountProfileIcon} iconTone="capability" title="Name" />
        <SettingsRow icon={GmailAgentIcon} iconTone="capability" title="Email" />
      </SettingsGroup>
    </div>
    </AppPageShell>
  </NativeFeaturePage>,
);
