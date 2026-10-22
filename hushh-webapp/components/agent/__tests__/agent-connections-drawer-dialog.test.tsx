import { useRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentConnectionsDrawer } from "@/components/agent/agent-connections-drawer";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useBackLayer } from "@/lib/navigation/back-layers";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true }));
vi.mock("next/navigation", () => ({ usePathname: () => "/one" }));

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
  const animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
  beforeEach(() => { Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] }); });
  afterEach(() => {
    if (animationDescriptor) Object.defineProperty(Element.prototype, "getAnimations", animationDescriptor);
    else Reflect.deleteProperty(Element.prototype, "getAnimations");
  });
  it("never mounts an interactive web History during native preparation, admission or uncertain retirement", () => {
    const view = render(<Harness renderer="preparing" />);
    for (const renderer of ["preparing", "native", "blocked"] as const) {
      view.rerender(<Harness renderer={renderer} />);
      expect(screen.queryByRole("button", { name: "View Drive update" })).toBeNull();
    }
    view.rerender(<Harness renderer="web" />);
    expect(screen.getByRole("button", { name: "View Drive update" })).toBeVisible();
  });
  it.each([false, true])("admits early keyboard navigation before entry autofocus (reverse=%s)", async (shiftKey) => {
    const close = vi.fn();
    const trigger = { current: null };
    render(<AgentConnectionsDrawer open onOpenChange={close} mode="chats"
      triggerRef={trigger} externalModalOpen={false}
      chats={<><button>First history action</button><button>Last history action</button></>} connections={null} />);
    const first = screen.getByRole("button", { name: "First history action" });
    const last = screen.getByRole("button", { name: "Last history action" });
    // JSDOM has no layout; admit just these real DOM controls as rendered.
    for (const button of [first, last]) Object.defineProperty(button, "offsetParent", { configurable: true, value: document.body });
    expect(document.activeElement).toBe(document.body);
    expect(fireEvent.keyDown(document.body, { key: "Tab", shiftKey })).toBe(false);
    expect(shiftKey ? last : first).toHaveFocus();
    const intercepted = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    intercepted.preventDefault();
    document.body.dispatchEvent(intercepted);
    expect(shiftKey ? last : first).toHaveFocus();
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(close).toHaveBeenCalledExactlyOnceWith(false);
  });
  it("keeps the mobile chat drawer open when Escape closes a Drive detail", async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "View Drive update" }));
    const detail = await screen.findByRole("dialog", { name: "Drive sharing" });
    fireEvent.keyDown(detail, { key: "Escape" });
    await waitFor(() => expect(detail).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Agent chat history" })).toBeVisible();
  });
  it("preserves connector state across the separate modal and History navigation", async () => {
    const dismiss = vi.fn();
    function Journey({ external = false }: { external?: boolean }) {
      const [mode, setMode] = useState<"chats" | "connections">("chats");
      const trigger = useRef<HTMLButtonElement>(null);
      useBackLayer("/one", mode === "connections" ? 2 : 0, () => { setMode("chats"); return true; });
      return <AgentConnectionsDrawer open onOpenChange={dismiss} mode={mode} triggerRef={trigger} externalModalOpen={external}
        chats={<button onClick={() => setMode("connections")}>Open connectors</button>}
        connections={<><input aria-label="Synthetic connector draft" /><button onClick={() => setMode("chats")}>Back to chats</button></>} />;
    }
    const view = render(<Journey />);
    const history = await screen.findByRole("dialog", { name: "Agent chat history" });
    fireEvent.click(screen.getByRole("button", { name: "Open connectors" }));
    expect(screen.getByRole("dialog", { name: "Connectors", exact: true })).not.toBe(history);
    expect(screen.queryByRole("dialog", { name: "Agent chat history" })).toBeNull();
    const field = screen.getByRole("textbox", { name: "Synthetic connector draft" });
    fireEvent.change(field, { target: { value: "public draft" } });
    fireEvent.keyDown(screen.getByRole("button", { name: "Drag down to close" }), { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Agent chat history" })).toBeVisible();
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open connectors" }));
    expect(screen.getByRole("textbox", { name: "Synthetic connector draft" })).toBe(field);
    expect(field).toHaveValue("public draft");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    view.rerender(<Journey external />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    view.rerender(<Journey />);
    expect(screen.getByRole("dialog", { name: "Connectors", exact: true })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Synthetic connector draft" })).toHaveValue("public draft");
    expect(dismiss).not.toHaveBeenCalled();
  });
  it("refuses delayed web focus restoration after native presentation takes ownership", async () => {
    function Journey({ renderer }: { renderer: "web" | "blocked" }) {
      const trigger = useRef<HTMLButtonElement>(null);
      return <><button ref={trigger}>History trigger</button><AgentConnectionsDrawer open mode="connections"
        onOpenChange={vi.fn()} triggerRef={trigger} externalModalOpen={false} historyRenderer={renderer}
        chats={null} connections={<input aria-label="Synthetic connector draft" />} /></>;
    }
    const view = render(<Journey renderer="web" />);
    await screen.findByRole("dialog", { name: "Connectors", exact: true });
    const trigger = screen.getByRole("button", { name: "History trigger", hidden: true });
    const focus = vi.spyOn(trigger, "focus");
    view.rerender(<Journey renderer="blocked" />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(screen.queryByRole("dialog", { name: "Connectors", exact: true })).toBeNull();
    expect(focus).not.toHaveBeenCalled();
  });
});
