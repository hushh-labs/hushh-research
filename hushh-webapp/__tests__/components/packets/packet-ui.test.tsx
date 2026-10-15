import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { PacketPage } from "@/components/consent/packets/packet-page";
import { PacketRows, type PacketRowItem } from "@/components/consent/packets/packet-rows";

afterEach(cleanup);

const rows: PacketRowItem[] = [
  { id: "ready", title: "Example Bank statements", statusLine: "Ready to list · 3 documents · Jan–Jun 2026", amountCents: 1234, tone: "ready" },
  { id: "checking", title: "New packet", statusLine: "Checking · 1 document", amountCents: null, tone: "waiting" },
];

describe("packet rows", () => {
  it("shows one compact row per packet: name, one status line, price, and opens on tap", () => {
    const open = vi.fn();
    render(<SettingsGroup title="Packets"><PacketRows items={[{ ...rows[0], onOpen: open }, rows[1]]} /></SettingsGroup>);
    const row = screen.getByRole("button", { name: /Example Bank statements/ });
    expect(row).toHaveTextContent("Ready to list · 3 documents · Jan–Jun 2026");
    expect(row).toHaveTextContent("$12.34");
    fireEvent.click(row);
    expect(open).toHaveBeenCalledOnce();
    // Nothing to open: the row only reads. No price: none is shown.
    expect(screen.getAllByRole("button")).toHaveLength(1);
    const checking = screen.getByText("New packet").closest("[data-testid='settings-row']");
    expect(checking).toHaveTextContent("Checking · 1 document");
    expect(checking?.textContent).not.toContain("$");
  });
});

describe("packet page", () => {
  const sections = [
    { id: "inside", title: "What’s inside", rows: [{ id: "jan", title: "Example Bank statement Jan 2026.pdf", description: "Bank statement · 2 pages · Jan 2026" }] },
    { id: "buyers", title: "What buyers see", rows: [{ id: "name", title: "Example Bank statements", description: "January to June 2026" }] },
    { id: "price", title: "Price", rows: [{ id: "price", title: "Price", value: "$12.34" }], children: <p>Extra price content</p> },
    { id: "status", title: "Status", rows: [{ id: "status", title: "Ready to list", description: "Only you can see it.", tone: "ready" as const }] },
  ];

  it("shows the packet's sections, runs its actions, and Back closes it", () => {
    const list = vi.fn(), deny = vi.fn(), close = vi.fn();
    render(<PacketPage open onOpenChange={close} title="Example Bank statements" description="Ready to list · 3 documents"
      sections={sections} message="Couldn’t finish. Retry to check the latest status."
      actions={[{ id: "list", label: "List for $12.34", onSelect: list },
        { id: "deny", label: "Don’t list", onSelect: deny, emphasis: "secondary" }]} />);
    const page = screen.getByRole("dialog", { name: "Example Bank statements" });
    for (const section of sections) expect(within(page).getByRole("heading", { name: section.title })).toBeInTheDocument();
    const inside = within(page).getByRole("heading", { name: "What’s inside" }).closest("section")!;
    expect(inside).toHaveTextContent("Example Bank statement Jan 2026.pdf");
    expect(inside).toHaveTextContent("Bank statement · 2 pages · Jan 2026");
    expect(within(page).getByRole("heading", { name: "Price" }).closest("section")).toHaveTextContent("$12.34");
    expect(within(page).getByText("Extra price content")).toBeInTheDocument();
    expect(within(page).getByRole("status")).toHaveTextContent("Couldn’t finish. Retry to check the latest status.");
    fireEvent.click(within(page).getByRole("button", { name: "List for $12.34" }));
    expect(list).toHaveBeenCalledOnce();
    fireEvent.click(within(page).getByRole("button", { name: "Don’t list" }));
    expect(deny).toHaveBeenCalledOnce();
    fireEvent.click(within(page).getByRole("button", { name: "Close detail panel" }));
    expect(close).toHaveBeenCalledWith(false);
  });

  it("shows no action buttons when it has none, and renders nothing while closed", () => {
    const view = render(<PacketPage open onOpenChange={vi.fn()} title="New packet" sections={sections.slice(3)} />);
    const page = screen.getByRole("dialog", { name: "New packet" });
    expect(within(page).getAllByRole("button").map(button => button.getAttribute("aria-label") ?? button.textContent))
      .toEqual(["Close detail panel"]);
    view.rerender(<PacketPage open={false} onOpenChange={vi.fn()} title="New packet" sections={sections} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
