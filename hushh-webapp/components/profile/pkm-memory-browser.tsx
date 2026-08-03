"use client";

import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { PkmMemoryCard } from "@/lib/pkm/pkm-memory-cards";
import { buildPkmMemoryTree, type PkmMemoryTreeNode } from "@/lib/profile/pkm-memory-tree";
import { SurfaceInset } from "@/components/app-ui/surfaces";

export function PkmMemoryBrowser({
  cards,
  renderCard,
}: {
  cards: readonly PkmMemoryCard[];
  renderCard: (card: PkmMemoryCard) => ReactNode;
}) {
  const [openPaths, setOpenPaths] = useState<Set<string>>(() => new Set());
  const roots = buildPkmMemoryTree(cards);

  const renderNode = (node: PkmMemoryTreeNode, depth: number): ReactNode => {
    const hasChildren = node.children.length > 0;
    const open = openPaths.has(node.id);
    if (!hasChildren && node.card) return <div key={node.id}>{renderCard(node.card)}</div>;
    return (
      <div key={node.id} className="border-b border-[color:var(--app-card-border-standard)] last:border-b-0">
        <button
          type="button"
          className="flex min-h-11 w-full items-center gap-2 py-2 text-left text-sm font-medium text-foreground"
          style={{ paddingLeft: `${Math.min(depth, 4) * 0.85}rem` }}
          aria-expanded={open}
          onClick={() =>
            setOpenPaths((current) => {
              const next = new Set(current);
              if (next.has(node.id)) next.delete(node.id);
              else next.add(node.id);
              return next;
            })
          }
        >
          {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
          {open ? <FolderOpen className="h-4 w-4 text-accent" aria-hidden /> : <Folder className="h-4 w-4 text-muted-foreground" aria-hidden />}
          <span className="min-w-0 truncate">{node.label}</span>
        </button>
        {open ? <div className="pb-1">{node.children.map((child) => renderNode(child, depth + 1))}</div> : null}
      </div>
    );
  };

  if (!roots.length) return null;
  return (
    <SurfaceInset className="space-y-2 p-4" data-pkm-memory-tree="true">
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">Browse saved details</p>
        <p className="text-sm text-muted-foreground">Open a folder to view or correct one detail at a time.</p>
      </div>
      <div>{roots.map((node) => renderNode(node, 0))}</div>
    </SurfaceInset>
  );
}
