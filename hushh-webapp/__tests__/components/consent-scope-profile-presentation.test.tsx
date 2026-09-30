import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConsentScopeNestedList } from "@/components/consent/consent-scope-nested-list";
import type { ConsentScopeItem } from "@/lib/consent/consent-scope-items";

const items: ConsentScopeItem[] = ["location", "financial"].map((domain) => ({
  id: domain, label: `${domain} detail`, domainKey: domain, domainLabel: domain,
  pathSegments: ["detail"], searchText: `${domain} detail`,
}));

function Fixture() {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  return <ConsentScopeNestedList items={items} searchThreshold={0} showDomainFilter
    searchPlaceholder="Search categories"
    renderDomainLeading={(domain) => <span data-testid={`icon-${domain}`} />}
    selection={{ selectedIds, onToggleMany: (ids, select) => setSelectedIds((current) => {
      const next = new Set(current);
      ids.forEach((id) => { if (select) next.add(id); else next.delete(id); });
      return next;
    }) }} />;
}

describe("profile category presentation", () => {
  it("keeps selection when filtering decorated category rows", async () => {
    render(<Fixture />);
    expect(screen.getByPlaceholderText("Search categories")).toBeInTheDocument();
    expect(screen.getByTestId("icon-location")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Everything in Location" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Filter categories" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "financial" }));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Open Location" })).not.toBeInTheDocument();
    expect(screen.getByTestId("icon-financial")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "Filter categories" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "All categories" }));
    expect(await screen.findByRole("checkbox", { name: "Everything in Location" })).toBeChecked();
  });
});
