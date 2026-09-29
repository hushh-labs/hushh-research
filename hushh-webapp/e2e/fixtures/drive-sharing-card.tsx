import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DriveRecentSharing } from "../../components/agent/drive-background-search";
import { DriveReadMemoryAction } from "../../components/agent/drive-read-memory-action";
import { publishValidatedAuthSessionOwner } from "../../lib/auth/session-owner";
publishValidatedAuthSessionOwner("synthetic-owner");
function Fixture() {
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(0);
  const sidebar = new URLSearchParams(window.location.search).has("sidebar");
  useEffect(() => {
    const receipt = (event: Event) => setSaved((event as CustomEvent<number>).detail);
    window.addEventListener("fixture:memory-saved", receipt);
    return () => window.removeEventListener("fixture:memory-saved", receipt);
  }, []);
  return <main className={sidebar ? "flex min-h-dvh bg-background text-foreground" : "mx-auto min-h-dvh max-w-4xl space-y-6 bg-background p-4 text-foreground"}>
    {sidebar ? <aside data-test-drive-sidebar data-agent-history-sidebar="persistent" className="min-h-dvh w-[min(88vw,360px)] shrink-0 border-r border-[color:var(--one-chat-divider)] bg-[color:var(--one-chat-sidebar)] px-2.5 pt-4 sm:w-60">
      <h2 className="px-3 pb-3 text-lg font-semibold">Chats</h2>
      <input aria-label="Search chats" className="mx-3 mb-2 w-[calc(100%-1.5rem)] rounded-full border border-border bg-background px-3 py-2 text-sm" />
      <DriveRecentSharing presentation="sidebar" />
    </aside> : <DriveRecentSharing />}
    <div className={sidebar ? "min-w-0 flex-1 p-4" : undefined}>
    <section className="space-y-2">
      <h1 className="text-xl font-semibold">One</h1>
      <p className="text-sm leading-6">The team agreed to launch the SDK in October. Priya owns the launch.</p>
      <DriveReadMemoryAction ownerId="synthetic-owner" vaultKey="synthetic-key" vaultOwnerToken="synthetic-vault-owner"
        answer="The team agreed to launch the SDK in October. Priya owns the launch. [drive:1]" scopeId="synthetic-chat:answer"
        getCurrentToken={() => "synthetic-vault-owner"} isScopeCurrent={() => true} />
      <output aria-label="Saved note count">{saved}</output>
    </section>
    <form data-agent-chat-composer-form="root" onSubmit={event => event.preventDefault()}>
      <label className="flex flex-col gap-2 text-sm">Chat draft
        <textarea className="min-h-11 w-full rounded-xl border border-border p-3" value={draft}
          onChange={event => setDraft(event.target.value)} />
      </label>
    </form>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
