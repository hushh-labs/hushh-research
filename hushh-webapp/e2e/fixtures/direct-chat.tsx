import { createRoot } from "react-dom/client";
import { useState } from "react";
import { resolveTopShellRouteProfile } from "../../components/app-ui/top-shell-metrics";
import { resolveSignedInShellContentOffset, resolveTopShellGeometryStyle } from "../../components/app-ui/signed-in-shell-content-offset";
import { AgentDockProvider } from "../../components/agent/agent-dock";
import { AppBottomShell } from "../../components/app-ui/app-bottom-shell";
import { DirectMessagesRoute } from "../../components/direct-messages/direct-messages-route";
import { Dialog, DialogContent, DialogTitle } from "../../components/ui/dialog";
import { ThemeProvider } from "../../components/theme-provider";
import { Toaster } from "../../components/ui/sonner";
import { unwindBackLayer } from "../../lib/navigation/back-layers";
function OverlayFixture() {
  const [open, setOpen] = useState(false);
  return <><button type="button" style={{ position: "fixed", top: 12, right: 12 }} onClick={() => setOpen(true)}>Open fixture modal</button>
    <Dialog modal open={open} onOpenChange={setOpen}><DialogContent><DialogTitle>Fixture modal</DialogTitle><button type="button" onClick={() => setOpen(false)}>Finish fixture modal</button></DialogContent></Dialog></>;
}
(window as unknown as { directChatUnwindBack: () => boolean }).directChatUnwindBack = () =>
  unwindBackLayer("/one/messages", new URLSearchParams(location.search));
const shell = resolveTopShellRouteProfile("/one/messages");
const offset = resolveSignedInShellContentOffset({ shellVisible: shell.metrics.shellVisible, routeLayoutMode: "standard" });
createRoot(document.getElementById("root")!).render(<ThemeProvider attribute="class" defaultTheme="system" enableSystem><AgentDockProvider><div data-app-shell-root="true" style={{ ...offset.style, ...resolveTopShellGeometryStyle({ hasTabs: shell.metrics.hasTabs }) } as React.CSSProperties}><div data-app-scroll-root="true" data-app-scroll-mode={offset.mode} className="overflow-y-auto pb-[var(--app-scroll-bottom-pad,112px)]" style={{ height: "100dvh" }}>
  <style>{`[data-app-scroll-root] { --app-scroll-bottom-pad: var(--app-bottom-shell-height,112px); }`}</style>
  <DirectMessagesRoute />{document.documentElement.dataset.modalFixture === "true" && <OverlayFixture />}
</div></div><AppBottomShell model={{ navigationHidden: false, agentBarHidden: true, includeComposerHeight: true }} /><Toaster /></AgentDockProvider></ThemeProvider>);
