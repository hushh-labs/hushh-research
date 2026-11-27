"use client";

import { Button } from "@/components/ui/button";
import { useOwnerPresentationState } from "@/hooks/use-owner-presentation-state";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES, normalizeStaticExportPathname } from "@/lib/navigation/routes";
import { usePathname } from "next/navigation";
import { useProfilePanePresentation } from "@/lib/navigation/use-profile-pane-presentation";
import type { WebsiteLoginInput, WebsiteLoginSummary } from "@/lib/pkm/website-credential";
import { useWebsiteLogins } from "./use-website-logins";
import { WebsiteLoginEditor } from "./website-login-editor";
import { WebsiteLoginSharing } from "./website-login-sharing";

type Editor = { item: WebsiteLoginSummary | null; input: WebsiteLoginInput | null } | null;

export function WebsiteLoginsWorkspace() {
  const model = useWebsiteLogins();
  const route = normalizeStaticExportPathname(usePathname() ?? ROUTES.PKM);
  const pane = useProfilePanePresentation();
  const [editor, setEditor] = useOwnerPresentationState<Editor>(model.owner, null);
  const [removing, setRemoving] = useOwnerPresentationState<WebsiteLoginSummary | null>(model.owner, null);
  const [sharing, setSharing] = useOwnerPresentationState<WebsiteLoginSummary | null>(model.owner, null);
  const [shareBusy, setShareBusy] = useOwnerPresentationState(model.owner, false);
  const close = () => {
    if (!editor && !removing && !sharing) return false;
    if (!model.busy && !shareBusy) { setEditor(null); setRemoving(null); setSharing(null); }
    return true;
  };
  useBackLayer(route, !model.locked && (editor || removing || sharing) ? 2 : 0, close, pane?.open ? { profile_pane: "1" } : undefined);
  if (model.locked) return <p role="status">Unlock your vault to manage website logins.</p>;
  return <section className="space-y-4" aria-label="Saved website logins">
    <h3 className="font-medium">Website logins</h3>
    <p className="text-sm text-muted-foreground">Only you can use or share these. One never sees your passwords or verification codes.</p>
    {model.message ? <p role="status" className="text-sm">{model.message}</p> : null}
    {model.failed ? <p role="alert" className="text-sm">Saved logins could not be refreshed. Previously loaded entries remain visible.</p> : null}
    {model.uncertain ? <p role="alert" className="text-sm">Refresh to reconcile the last change before editing again.</p> : null}
    {sharing ? <WebsiteLoginSharing item={sharing} model={model} onClose={() => { setShareBusy(false); setSharing(null); }} onBusy={setShareBusy} /> : editor ? <WebsiteLoginEditor key={`${model.owner.epoch}:${editor.item?.id ?? "new"}`} initial={editor.input}
      busy={model.busy} disabled={model.uncertain} onCancel={() => setEditor(null)}
      onSave={async input => { if (await model.save(input, editor.item ?? undefined)) setEditor(null); }} /> : removing ?
      <div className="space-y-3 rounded-xl border p-4" role="group" aria-label="Confirm saved login removal">
        <p>Remove {removing.label}?</p>
        <p className="text-sm text-muted-foreground">This stops future credential use. To remove a remembered browser sign-in, use Forget in that Browser task.</p>
        <div className="flex flex-wrap gap-2"><Button variant="destructive" disabled={model.busy || model.uncertain} isLoading={model.busy}
          onClick={() => { void model.remove(removing).then(done => { if (done) setRemoving(null); }); }} data-voice-control-id="website-login-remove-confirm">Remove login</Button>
          <Button variant="secondary" disabled={model.busy} onClick={() => setRemoving(null)} data-voice-control-id="website-login-cancel">Keep login</Button></div>
      </div> : <>
        <div className="flex flex-wrap gap-2"><Button disabled={model.busy || model.uncertain} onClick={() => setEditor({ item: null, input: null })}
          data-voice-control-id="website-login-add">Add website login</Button>
          <Button variant="secondary" disabled={model.busy || model.loading} onClick={() => { void model.refresh(); }} data-voice-control-id="website-login-refresh">Refresh</Button>
          <Button variant="secondary" disabled={model.busy || model.uncertain} onClick={() => { void model.importLegacy(); }}>Import earlier saved logins</Button></div>
        {model.loading ? <p role="status" className="text-sm">Loading saved logins…</p> : null}
        {!model.loading && !model.failed && !model.items.length ? <p className="text-sm text-muted-foreground">No website logins saved.</p> : null}
        <ul className="divide-y rounded-xl border">{model.items.map(item => <li key={item.id} className="space-y-2 p-4">
          <p className="break-words font-medium">{item.label}</p>
          <p className="break-all text-sm text-muted-foreground">{item.boundOrigins.join(", ")}</p>
          <p className="text-sm text-muted-foreground">Your Allow is required for every sign-in.</p>
          <div className="flex flex-wrap gap-2"><Button variant="secondary" size="compact" disabled={model.busy || model.uncertain}
            onClick={() => { void model.reveal(item).then(input => { if (input && model.current()) setEditor({ item, input }); }); }} data-voice-control-id="website-login-edit">Edit privately</Button>
            <Button variant="ghost" size="compact" disabled={model.busy || model.uncertain} onClick={() => setRemoving(item)}
              data-voice-control-id="website-login-remove">Remove</Button>
            <Button variant="secondary" size="compact" disabled={model.busy || model.uncertain} onClick={() => setSharing(item)}
              data-voice-control-id="website-login-share">Share</Button></div>
        </li>)}</ul>
      </>}
  </section>;
}
