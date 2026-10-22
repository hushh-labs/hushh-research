import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentHistorySidebar } from "../../components/agent/agent-history-sidebar";
import { Download, DownloadAppIcon, TodoListIcon } from "../../components/icons";

import { weaveFrame } from "../../components/icons/ui/weave-geometry";

function Fixture() {
  const [lastAction, setLastAction] = useState("");
  if (location.search.includes("frames")) {
    return <main style={{ padding: 32, display: "flex", flexWrap: "wrap", gap: 32 }}>
      {[0, .2, .4, .6, .8, 1].map(progress => <figure key={progress} style={{ margin: 0, display: "grid", gap: 24, justifyItems: "center" }}>
        <svg width="96" height="96" viewBox="0 0 32 32" style={{ overflow: "visible" }} dangerouslySetInnerHTML={{ __html: weaveFrame(progress) }} />
        <svg width="22" height="22" viewBox="0 0 32 32" style={{ overflow: "visible" }} dangerouslySetInnerHTML={{ __html: weaveFrame(progress) }} />
        <figcaption>{Math.round(progress * 1040)} ms</figcaption>
      </figure>)}
    </main>;
  }
  if (location.search.includes("geometry")) {
    return <main style={{ display: "grid", gap: 32, padding: 32 }}>
      {[18, 22, 24].map(size => <div key={size} style={{ display: "flex", gap: 32 }}>
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground" data-original-todo={size}>
          <path d="M7 7H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h12" />
          <rect x="7" y="2" width="14" height="20" rx="2.5" />
          <path d="M11 7h6" /><path d="M11 11h4" />
        </svg>
        <TodoListIcon width={size} height={size} className="text-muted-foreground" data-todo={size} />
        <Download size={size} className="text-muted-foreground" data-original-download={size} />
        <DownloadAppIcon width={size} height={size} className="text-muted-foreground" data-download={size} />
        <svg width={size} height={size} viewBox="0 0 32 32" data-weave-end={size} dangerouslySetInnerHTML={{ __html: weaveFrame(1, 0) }} />
        <svg width={size} height={size} viewBox="0 0 32 32" data-weave-reset={size} dangerouslySetInnerHTML={{ __html: weaveFrame(0, 1) }} />
      </div>)}
    </main>;
  }
  return <>
    <div data-app-pane-material={location.search.includes("mobile") ? "profile" : undefined} style={{ height: 600, display: "flex" }}>
      <AgentHistorySidebar
        className={location.search.includes("mobile") ? "h-full w-full" : undefined}
        mode={location.search.includes("mobile") ? "mobile" : "desktop"}
        conversations={[]}
        activeConversationId={null}
        onCreateNew={() => setLastAction("new")}
        onSelectConversation={() => {}}
        onRenameConversation={() => {}}
        onDeleteConversation={() => {}}
        onGetApp={() => setLastAction("app")}
        onOpenConnectors={() => setLastAction("connectors")}
      />
    </div>
    <output data-testid="shortcut-result">{lastAction}</output>
  </>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
