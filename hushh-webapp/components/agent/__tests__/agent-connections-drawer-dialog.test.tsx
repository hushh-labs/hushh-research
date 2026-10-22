import { useRef, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentConnectionsDrawer } from "@/components/agent/agent-connections-drawer";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true }));

function Detail() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>View Drive update</button>
    <Sheet modal open={open} onOpenChange={setOpen}>
      <SheetContent side="left" data-chat-detail-pane className="profile-pane-sheet"><SheetTitle>Drive sharing</SheetTitle></SheetContent>
    </Sheet>
  </>;
}

function Harness({ renderer = "web" }: { renderer?: "web" | "preparing" | "native" | "blocked" }) {
  const [open, setOpen] = useState(true);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return <AgentConnectionsDrawer open={open} onOpenChange={setOpen} mode="chats"
    externalModalOpen={false} chats={<Detail />} connections={null} triggerRef={triggerRef} historyRenderer={renderer} />;
}

describe("chat drawer dialog layering", () => {
  it("never mounts an interactive web History during native preparation, admission or uncertain retirement", () => {
    const view = render(<Harness renderer="preparing" />);
    for (const renderer of ["preparing", "native", "blocked"] as const) {
      view.rerender(<Harness renderer={renderer} />);
      expect(screen.queryByRole("button", { name: "View Drive update" })).toBeNull();
    }
    view.rerender(<Harness renderer="web" />);
    expect(screen.getByRole("button", { name: "View Drive update" })).toBeVisible();
  });
  it("keeps the mobile chat drawer open when Escape closes a Drive detail", async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "View Drive update" }));
    const detail = await screen.findByRole("dialog", { name: "Drive sharing" });
    fireEvent.keyDown(detail, { key: "Escape" });
    await waitFor(() => expect(detail).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Agent chat history" })).toBeVisible();
  });
  it("retains the same leading pane and connector state across History child navigation", async () => {
    function Journey() {
      const [mode, setMode] = useState<"chats" | "connections">("chats");
      const trigger = useRef<HTMLButtonElement>(null);
      return <AgentConnectionsDrawer open onOpenChange={vi.fn()} mode={mode} triggerRef={trigger} externalModalOpen={false}
        chats={<button onClick={() => setMode("connections")}>Open connectors</button>}
        connections={<><input aria-label="Synthetic connector draft" /><button onClick={() => setMode("chats")}>Back to chats</button></>} />;
    }
    render(<Journey />);
    const history = await screen.findByRole("dialog", { name: "Agent chat history" });
    fireEvent.click(screen.getByRole("button", { name: "Open connectors" }));
    expect(screen.getByRole("dialog", { name: "Chat connectors" })).toBe(history);
    const field = screen.getByRole("textbox", { name: "Synthetic connector draft" });
    fireEvent.change(field, { target: { value: "public draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to chats" }));
    fireEvent.click(screen.getByRole("button", { name: "Open connectors" }));
    expect(screen.getByRole("textbox", { name: "Synthetic connector draft" })).toBe(field);
    expect(field).toHaveValue("public draft");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
});
