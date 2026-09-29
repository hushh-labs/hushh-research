import { useRef, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentConnectionsDrawer } from "@/components/agent/agent-connections-drawer";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true }));

function Detail() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>View Drive update</button>
    <Dialog modal open={open} onOpenChange={setOpen}>
      <DialogContent><DialogTitle>Drive sharing</DialogTitle></DialogContent>
    </Dialog>
  </>;
}

function Harness() {
  const [open, setOpen] = useState(true);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return <AgentConnectionsDrawer open={open} onOpenChange={setOpen} mode="chats"
    externalModalOpen={false} chats={<Detail />} connections={null} triggerRef={triggerRef} />;
}

describe("chat drawer dialog layering", () => {
  it("keeps the mobile chat drawer open when Escape closes a Drive detail", async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "View Drive update" }));
    const detail = await screen.findByRole("dialog", { name: "Drive sharing" });
    fireEvent.keyDown(detail, { key: "Escape" });
    await waitFor(() => expect(detail).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Agent chat history" })).toBeVisible();
  });
});
