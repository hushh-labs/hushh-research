import { describe, expect, it, vi } from "vitest";
import { nativeMemorySaved, type NativeMemorySavedModel } from "@/components/profile/native-memory-saved";
import type { MemoryCommerceSummaryModel } from "@/components/profile/memory-commerce-summary";
import type { NativeWorkspaceChoice } from "@/lib/capacitor/native-workspace";
import { nativeMemoryMarkdown } from "@/components/profile/native-memory-markdown";
import { ROUTES } from "@/lib/navigation/routes";
import { financialManifest } from "../fixtures/materialized-financial-manifest";

function fixture(markdown = "A plain private note."): NativeMemorySavedModel {
  return {
    authLoading: false, canOpen: true, selectedCard: null, selectedMetadataDomain: null,
    soul: { verified: true, editing: false, failed: false, loading: false, sync: "synced",
      current: { document: { markdown, persisted: true }, draft: markdown }, beginEdit: vi.fn(), retryLoad: vi.fn(), retrySync: vi.fn() },
    homeSearchQuery: "", setHomeSearchQuery: vi.fn(), bootstrapLoading: false, bootstrapError: null,
    metadata: {}, memoryCardsLoading: false, memoryCardsLoadError: null, memoryCards: [], trimmedQuery: "", searchResults: [],
    matchedCategories: [], recentMemories: [], categories: [], setWorkspaceTab: vi.fn(), openMemory: vi.fn(),
    setSelectedDomainKey: vi.fn(), navigate: vi.fn(), setRefreshNonce: vi.fn(), setMemoryCardsNonce: vi.fn(),
    visibleMetadataDomains: [], sharingManifests: {}, sharingManifestsLoading: false, exportBusy: false,
    exportStatus: null, exportError: null, isVaultUnlocked: true, handleExportMemory: vi.fn(),
  } as unknown as NativeMemorySavedModel;
}
const commerce = { user: null, data: null, loading: false, error: null } as unknown as MemoryCommerceSummaryModel;
const choice = {} as NativeWorkspaceChoice;
const handle = (key: string) => `opaque-${key}`;

describe("native Memory Saved projection", () => {
  it("organizes Wiki and Core files cleanly and navigates directly into /one/files", async () => {
    const model = fixture("# Preferences\n\n## Travel\n- Window seat");
    const openSharing = vi.fn();
    const handoff = vi.fn(async (_target, action: () => void) => { action(); return true; });
    const result = nativeMemorySaved({ model, commerce, handle, handoff, openPayments: vi.fn(), openSharing })!;
    expect(result.sections.slice(0, 2).map(section => section.title)).toEqual([
      "Wiki",
      "Core files",
    ]);
    const labels = result.sections.flatMap(section => section.rows).map(row => row.label);
    expect(labels).toContain("Personal wiki");
    expect(labels).toContain("memory.md");
    expect(labels).toContain("identity.md");
    expect(labels).toContain("soul.md");
    expect(labels).not.toContain("Live memory");
    expect(labels).not.toContain("Add Memory");
    expect(labels).not.toContain("Sharing settings");
    expect(labels).not.toContain("• Window seat");

    await result.actions.get(handle("memory-saved:wiki-open"))?.(choice);
    expect(handoff).toHaveBeenCalledWith("navigation", expect.any(Function));
    expect(model.navigate).toHaveBeenCalledWith(`${ROUTES.ONE_FILES}?folder=personal-wiki`);

    await result.actions.get(handle("memory-saved:identity-doc"))?.(choice);
    expect(model.navigate).toHaveBeenCalledWith(`${ROUTES.ONE_FILES}?folder=personal-wiki&doc=identity.md`);

    await result.actions.get(handle("memory-saved:download"))?.(choice);
    expect(model.handleExportMemory).toHaveBeenCalledTimes(1);
  });

  it("does not execute a nested action when native retirement is unconfirmed", async () => {
    const model = fixture();
    const handoff = vi.fn(async () => false);
    const result = nativeMemorySaved({ model, commerce, handle, handoff, openPayments: vi.fn(), openSharing: vi.fn() })!;
    await result.actions.get(handle("memory-saved:soul-edit"))?.(choice);
    expect(model.navigate).not.toHaveBeenCalled();
  });

  it("retains consolidated Scopes category sharing posture and Memory earnings", async () => {
    const earnings = { user: {}, data: { earnings: { pending_cents: 450, available_cents: 100 }, seller: { eligible: true } }, loading: false, error: null } as unknown as MemoryCommerceSummaryModel;
    const model = {
      ...fixture(),
      categories: [{ key: "financial", title: "Financial", count: 2 }],
      sharingManifests: {
        financial: financialManifest("consent_required"),
      },
    } as unknown as NativeMemorySavedModel;
    const openPayments = vi.fn();
    const handoff = vi.fn(async (_target, action: () => void) => { action(); return true; });
    const result = nativeMemorySaved({ model, commerce: earnings, handle, handoff, openPayments, openSharing: vi.fn() })!;
    const rows = result.sections.flatMap(section => section.rows);
    expect(rows.find(row => row.label === "Financial")?.detail).toBe("2 memories · Ask first");
    expect(rows.find(row => row.label === "Pending earnings")?.detail).toContain("4.50");
    expect(rows.find(row => row.label === "Available earnings")?.detail).toContain("1.00");
    await result.actions.get(handle("memory-saved:earnings-open"))?.(choice);
    expect(handoff).toHaveBeenCalledWith("payments", expect.any(Function));
    expect(openPayments).toHaveBeenCalledTimes(1);
  });

  it("keeps unsafe links inert and authored React content for unsupported GFM", () => {
    const blocks = nativeMemoryMarkdown("[unsafe](javascript:alert(1))");
    expect(blocks?.[0].text).toBe("unsafe");
    expect(blocks?.[0].links).toEqual([]);
    expect(blocks?.[0].runs?.some(run => run.href)).toBe(false);
    expect(nativeMemoryMarkdown("![Meaningful diagram](https://example.org/diagram.png)")).toBeNull();
    expect(nativeMemoryMarkdown("| Name | Value |\n| --- | --- |\n| One | Two |")).toBeNull();
  });

  it("never leaks stale inline markdown paragraphs into native Memory sections", () => {
    const result = nativeMemorySaved({ model: fixture("# Current heading\n\n## Second\n\nCurrent text."), commerce, handle,
      handoff: async () => false, openPayments: vi.fn(), openSharing: vi.fn() })!;
    expect(JSON.stringify(result.sections)).not.toContain("Current text.");
    expect(result.sections.flatMap(section => section.rows).find(row => row.label === "memory.md")?.detail)
      .toBe("Facts, preferences, and durable commitments.");
  });
});
