"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { type PathDescriptor } from "@/lib/personal-knowledge-model/manifest";
import { cn } from "@/lib/utils";

type ManifestTreeNode = {
  key: string;
  fullPath: string;
  descriptor?: PathDescriptor;
  children: Map<string, ManifestTreeNode>;
};

function stringifyValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function summarizeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `${value.length} ${value.length === 1 ? "item" : "items"}`;
  }
  if (value && typeof value === "object") {
    return `${Object.keys(value as Record<string, unknown>).length} keys`;
  }
  return stringifyValue(value);
}

function buildManifestTree(paths: PathDescriptor[]): ManifestTreeNode[] {
  const root = new Map<string, ManifestTreeNode>();

  for (const descriptor of paths) {
    const segments = descriptor.json_path.split(".").filter(Boolean);
    if (!segments.length) continue;

    let cursor = root;
    let currentPath = "";
    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}.${segment}` : segment;
      let nextNode = cursor.get(segment);
      if (!nextNode) {
        nextNode = {
          key: segment,
          fullPath: currentPath,
          children: new Map<string, ManifestTreeNode>(),
        };
        cursor.set(segment, nextNode);
      }
      if (descriptor.json_path === currentPath) {
        nextNode.descriptor = descriptor;
      }
      cursor = nextNode.children;
    }
  }

  return Array.from(root.values()).sort((left, right) => left.key.localeCompare(right.key));
}

function JsonNode({
  label,
  value,
  depth,
}: {
  label: string;
  value: unknown;
  depth: number;
}) {
  const [open, setOpen] = useState(false);
  const isArray = Array.isArray(value);
  const isObject = Boolean(value) && typeof value === "object" && !isArray;

  if (!isArray && !isObject) {
    return (
      <div className="flex flex-wrap items-start gap-2 rounded-xl border bg-background/70 px-3 py-2">
        <span className="font-medium text-foreground">{label}</span>
        <span className="break-all text-muted-foreground">{stringifyValue(value)}</span>
      </div>
    );
  }

  const entries = isArray
    ? (value as unknown[]).map((item, index) => [`[${index}]`, item] as const)
    : Object.entries(value as Record<string, unknown>);
  const summary = isArray
    ? `${entries.length} ${entries.length === 1 ? "item" : "items"}`
    : `${entries.length} ${entries.length === 1 ? "key" : "keys"}`;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-xl border bg-background/70">
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left">
          <div className="min-w-0">
            <p className="font-medium text-foreground">{label}</p>
            <p className="text-xs text-muted-foreground">
              {isArray ? "Array" : "Object"} • {summary}
            </p>
          </div>
          {open ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
        </CollapsibleTrigger>
        <CollapsibleContent className="px-3 pb-3">
          <div className="space-y-2 border-l border-border/70 pl-3">
            {entries.map(([entryLabel, entryValue]) => (
              <JsonNode
                key={`${label}:${entryLabel}`}
                label={entryLabel}
                value={entryValue}
                depth={depth + 1}
              />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function ManifestNode({
  node,
  depth,
}: {
  node: ManifestTreeNode;
  depth: number;
}) {
  const [open, setOpen] = useState(false);
  const children = Array.from(node.children.values()).sort((left, right) =>
    left.key.localeCompare(right.key)
  );
  const descriptor = node.descriptor;
  const hasChildren = children.length > 0;

  if (!hasChildren) {
    return (
      <div className="rounded-xl border bg-background/70 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{node.key}</span>
          {descriptor ? <Badge variant="outline">{descriptor.path_type}</Badge> : null}
          {descriptor?.segment_id ? <Badge variant="secondary">{descriptor.segment_id}</Badge> : null}
          {descriptor?.sensitivity_label ? (
            <Badge variant="secondary">{descriptor.sensitivity_label}</Badge>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{node.fullPath}</p>
      </div>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-xl border bg-background/70">
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{node.key}</span>
              {descriptor ? <Badge variant="outline">{descriptor.path_type}</Badge> : null}
              {descriptor?.segment_id ? (
                <Badge variant="secondary">{descriptor.segment_id}</Badge>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {node.fullPath} • {children.length} child{children.length === 1 ? "" : "ren"}
            </p>
          </div>
          {open ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
        </CollapsibleTrigger>
        <CollapsibleContent className="px-3 pb-3">
          <div className="space-y-2 border-l border-border/70 pl-3">
            {children.map((child) => (
              <ManifestNode key={child.fullPath} node={child} depth={depth + 1} />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export function PkmJsonTree({
  value,
  rootLabel = "root",
  emptyLabel = "No data available.",
  className,
}: {
  value: unknown;
  rootLabel?: string;
  emptyLabel?: string;
  className?: string;
}) {
  if (value === null || value === undefined) {
    return (
      <div className={cn("rounded-2xl border bg-muted/30 p-4 text-sm text-muted-foreground", className)}>
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      <JsonNode label={rootLabel} value={value} depth={0} />
    </div>
  );
}

export function PkmManifestTree({
  paths,
  className,
}: {
  paths: PathDescriptor[];
  className?: string;
}) {
  const nodes = useMemo(() => buildManifestTree(paths), [paths]);

  if (!nodes.length) {
    return (
      <div className={cn("rounded-2xl border bg-muted/30 p-4 text-sm text-muted-foreground", className)}>
        No manifest paths available.
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      {nodes.map((node) => (
        <ManifestNode key={node.fullPath} node={node} depth={0} />
      ))}
    </div>
  );
}

export function PkmValueSummary({
  value,
}: {
  value: unknown;
}) {
  return <span className="text-xs text-muted-foreground">{summarizeValue(value)}</span>;
}
