import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PuppyComposer, PuppyControlRibbon } from "../../components/agent/puppy-chat-controls";
import { startFramePacingProbe } from "../../lib/perf/frame-pacing";
import { PuppyMachineSheet } from "../../components/agent/puppy-resource-monitor";
import { PuppyLocalControls } from "../../components/agent/puppy-local-controls";
import { PuppyRemoteModelPicker } from "../../components/agent/puppy-remote-model-picker";
import { AgentDockPortal, AgentDockProvider, AgentDockVoiceBoundary } from "../../components/agent/agent-dock";
import { AgentBarSurface, RetainedAgentBar } from "../../components/agent/agent-bar-surface";

function Fixture() {
  useEffect(() => {
    const probe = startFramePacingProbe({ hud: false });
    probe.setRoute("/one/puppy", "");
    return () => probe.stop();
  }, []);
  const [sent, setSent] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [onDevice, setOnDevice] = useState(true);
  return <main data-one-chat-surface className="mx-auto flex h-dvh min-h-0 w-full max-w-[var(--app-bottom-shell-max-width)] flex-col px-3 sm:px-5">
    {location.hash === "#local" ? <PuppyLocalControls active connected currentModel="google/gemma-4-12b"
      pill={{ live: true, pending: false, label: "google/gemma-4-12b" }} onDevice={onDevice}
      onTogglePin={() => setOnDevice(value => !value)} onApplied={() => {}} accessory={<PuppyMachineSheet ribbon />} /> : <PuppyControlRibbon accessory={<PuppyMachineSheet ribbon />}>
      <PuppyRemoteModelPicker hushhId="synthetic-owner" deviceId="synthetic-device"
        vaultOwnerToken="synthetic-fixture" chatModel={selected} busy={false} hasTurns={false}
        machine="a computer with a long reported name" machineState="live"
        lastKnownModel="google/gemma-4-12b" onChatModel={model => setSelected(model)} onGlobalModel={() => {}} />
    </PuppyControlRibbon>}
    <div data-testid="transcript" className="min-h-0 flex-1 overflow-y-auto py-4">
      {Array.from({ length: 30 }, (_, index) => <p key={index}>Synthetic conversation line {index + 1}</p>)}
      <output data-testid="sent-count">{sent}</output>
    </div>
    <AgentDockProvider>
      <AgentDockPortal enabled visible>
        <PuppyComposer embedded busy={false} stopping={false} disabled={false} onSend={() => setSent(value => value + 1)} onStop={() => {}} />
      </AgentDockPortal>
      <AgentDockVoiceBoundary><RetainedAgentBar><AgentBarSurface><button>Talk to One</button></AgentBarSurface></RetainedAgentBar></AgentDockVoiceBoundary>
    </AgentDockProvider>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
