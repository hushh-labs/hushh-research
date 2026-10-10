import { createRoot } from "react-dom/client";
import { useState } from "react";
import { AgentDockProvider } from "../../components/agent/agent-dock";
import { AppBottomShell } from "../../components/app-ui/app-bottom-shell";
import { DirectMessagesRoute } from "../../components/direct-messages/direct-messages-route";
import { Dialog, DialogContent, DialogTitle } from "../../components/ui/dialog";
import { ThemeProvider } from "../../components/theme-provider";
import { unwindBackLayer } from "../../lib/navigation/back-layers";
function OverlayFixture() {
  const [open, setOpen] = useState(false);
  return <><button type="button" style={{ position: "fixed", top: 12, right: 12 }} onClick={() => setOpen(true)}>Open fixture modal</button>
    <Dialog modal open={open} onOpenChange={setOpen}><DialogContent><DialogTitle>Fixture modal</DialogTitle><button type="button" onClick={() => setOpen(false)}>Finish fixture modal</button></DialogContent></Dialog></>;
}
(window as unknown as { directChatUnwindBack: () => boolean }).directChatUnwindBack = () =>
  unwindBackLayer("/one/messages", new URLSearchParams(location.search));
createRoot(document.getElementById("root")!).render(<ThemeProvider attribute="class" defaultTheme="system" enableSystem><AgentDockProvider><div data-app-scroll-root="true" style={{ height: "100dvh", overflowY: "auto", paddingTop: "96px", paddingBottom: "var(--app-scroll-bottom-pad,112px)", "--app-top-content-offset": "96px" } as React.CSSProperties}>
  <style>{`[data-app-scroll-root] { --app-scroll-bottom-pad: var(--app-bottom-shell-height,112px); }`}</style>
  <DirectMessagesRoute /><OverlayFixture />
</div><AppBottomShell model={{ navigationHidden: false, agentBarHidden: true, includeComposerHeight: true }} /></AgentDockProvider></ThemeProvider>);
