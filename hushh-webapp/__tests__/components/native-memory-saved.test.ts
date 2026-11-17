import { describe, expect, it, vi } from "vitest";
import { nativeMemorySaved, type NativeMemorySavedModel } from "@/components/profile/native-memory-saved";
import type { MemoryCommerceSummaryModel } from "@/components/profile/memory-commerce-summary";
import type { NativeWorkspaceChoice } from "@/lib/capacitor/native-workspace";
import type { LiveMirrorViewState } from "@/lib/pkm/use-live-mirror-view";
import { nativeMemoryMarkdown } from "@/components/profile/native-memory-markdown";
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
  it("organizes Personal wiki and Core documents compactly without inline memory.md wall or duplicate Sharing settings", async () => {
    const model = fixture("# Preferences\n\n## Travel\n- Window seat");
    const openSharing = vi.fn();
    const handoff = vi.fn(async (_target, action: () => void) => { action(); return true; });
    const result = nativeMemorySaved({ model, mirror: { status: "loading", view: null }, commerce, handle, handoff, openPayments: vi.fn(), openSharing })!;
    expect(result.requiresLiveSearch).toBe(true);
    expect(result.sections.slice(0, result.search.afterSection).map(section => section.title)).toEqual([
      "Live memory",
      "Personal wiki",
      "Core documents",
    ]);
    const labels = result.sections.flatMap(section => section.rows).map(row => row.label);
    expect(labels).toContain("Personal wiki");
    expect(labels).toContain("memory.md");
    expect(labels).toContain("identity.md");
    expect(labels).toContain("soul.md");
    expect(labels).not.toContain("Updates while the app is open and unlocked.");
    expect(labels).not.toContain("Sharing settings");
    // Compact index count instead of inline expanded bullets
    expect(labels).not.toContain("• Window seat");
    expect(result.sections.flatMap(section => section.rows).find(row => row.label === "memory.md")?.detail).toContain("2 sections");

    result.actions.get(result.search.id)?.({ ...choice, text: "synthetic" });
    expect(model.setHomeSearchQuery).toHaveBeenCalledWith("synthetic");
    result.actions.get(handle("memory-saved:add-memory"))?.(choice);
    expect(model.setWorkspaceTab).toHaveBeenCalledWith("add");
    await result.actions.get(handle("memory-saved:soul-edit"))?.(choice);
    expect(handoff).toHaveBeenCalledWith("soul-editor", expect.any(Function));
    expect(model.soul.beginEdit).toHaveBeenCalled();
    await result.actions.get(handle("memory-saved:download"))?.(choice);
    expect(model.handleExportMemory).toHaveBeenCalledTimes(1);
  });

  it("does not execute a nested action when native retirement is unconfirmed", async () => {
    const model = fixture();
    const handoff = vi.fn(async () => false);
    const result = nativeMemorySaved({ model, mirror: { status: "loading", view: null }, commerce, handle, handoff, openPayments: vi.fn(), openSharing: vi.fn() })!;
    await result.actions.get(handle("memory-saved:soul-edit"))?.(choice);
    expect(model.soul.beginEdit).not.toHaveBeenCalled();
  });

  it("retains the shared Live Memory status, facts, consolidated category sharing posture, and Memory earnings", async () => {
    const at = "2026-10-15T10:00:00.000Z";
    const mirror = { status: "ready", view: { evaluatedAt: at, overall: "current", lastVerifiedAt: at, conflicts: [],
      facts: [{ key: "name", predicate: "profile.name", kind: "profile", label: "Name", value: "Synthetic owner", state: "verified" }] } } as unknown as LiveMirrorViewState;
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
    const result = nativeMemorySaved({ model, mirror, commerce: earnings, handle, handoff, openPayments, openSharing: vi.fn() })!;
    const rows = result.sections.flatMap(section => section.rows);
    expect(rows.find(row => row.label === "Name")?.detail).toBe("Synthetic owner");
    expect(rows.find(row => row.label === "Financial")?.detail).toBe("2 memories · Ask first");
    expect(rows.find(row => row.label === "Pending earnings")?.detail).toContain("4.50");
    expect(rows.find(row => row.label === "Available earnings")?.detail).toContain("1.00");
    expect(rows.some(row => row.label === "See all")).toBe(true);
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
    const result = nativeMemorySaved({ model: fixture("| Name | Value |\n| --- | --- |\n| One | Two |"), mirror: { status: "loading", view: null }, commerce, handle,
      handoff: async () => false, openPayments: vi.fn(), openSharing: vi.fn() });
    expect(result).toBeNull();
  });

  it("never reuses a stale owner's memo for a changed Memory document", () => {
    const result = nativeMemorySaved({ model: fixture("# Current heading\n\n## Second\n\nCurrent text."), mirror: { status: "loading", view: null }, commerce, handle,
      handoff: async () => false, openPayments: vi.fn(), openSharing: vi.fn(),
      markdownProjection: { source: "old text", blocks: [{ kind: "paragraph", text: "Old private text", links: [] }] } })!;
    expect(JSON.stringify(result.sections)).not.toContain("Old private text");
    expect(result.sections.flatMap(section => section.rows).find(row => row.label === "memory.md")?.detail).toContain("2 sections");
  });
});
