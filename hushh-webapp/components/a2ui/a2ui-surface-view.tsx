"use client";

import { useId, useState } from "react";
import dynamic from "next/dynamic";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { a2uiTableRows, readA2uiBinding, type A2uiSurface } from "@/lib/a2ui/surface-store";

const A2uiPortfolioRead = dynamic(() => import("./a2ui-portfolio-read"));
const FinanceShareProposal = dynamic(() =>
  import("@/components/agent/finance-share-proposal").then(module => module.FinanceShareProposal),
);
const FinancePortfolioCard = dynamic(() =>
  import("@/components/agent/finance-portfolio-card").then(module => module.FinancePortfolioCard),
);

function SurfaceTable({
  label, columns, rows, previewRows,
}: {
  label: string;
  columns: string[];
  rows: NonNullable<ReturnType<typeof a2uiTableRows>>;
  previewRows?: number;
}) {
  const tableId = useId();
  const [expanded, setExpanded] = useState(false);
  if (!rows.length) return <p className="ui-text-row-description">No entries to display.</p>;

  const canExpand = previewRows !== undefined && previewRows < rows.length;
  const visible = canExpand && !expanded ? rows.slice(0, previewRows) : rows;
  return (
    <div className="min-w-0 space-y-2">
      <Table id={tableId} aria-label={label}>
        <TableHeader>
          <TableRow>
            {columns.map((column, index) => <TableHead key={index}>{column}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((row, index) => (
            <TableRow key={index}>
              {row.map((cell, columnIndex) => (
                <TableCell key={columnIndex} className="tabular-nums">{cell ?? "Unavailable"}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {canExpand ? (
        <Button size="compact" variant="outline" aria-controls={tableId} aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}>
          {expanded ? "Show fewer rows" : `Show all ${rows.length} rows`}
        </Button>
      ) : null}
    </div>
  );
}

function SurfaceNode({ surface, id, allowFinanceShare, portfolioConversationId }: {
  surface: A2uiSurface; id: string; allowFinanceShare: boolean; portfolioConversationId?: string;
}) {
  const node = surface.components.get(id);
  if (!node) return null;
  switch (node.component) {
    case "SurfaceCard":
      return (
        <SurfaceCard>
          <SurfaceCardContent className="min-w-0 space-y-2">
            {node.children.map(child => <SurfaceNode key={child} surface={surface} id={child} allowFinanceShare={allowFinanceShare} />)}
          </SurfaceCardContent>
        </SurfaceCard>
      );
    case "TextBlock": {
      const text = readA2uiBinding(surface, node.text);
      if (typeof text !== "string") return null;
      if (node.emphasis === "title") return <h3 className="ui-text-row-label-emphasized">{text}</h3>;
      return <p className={node.emphasis === "muted" ? "ui-text-row-description text-muted-foreground" : "ui-text-row-label"}>{text}</p>;
    }
    case "DataTable": {
      const rows = a2uiTableRows(readA2uiBinding(surface, node.rows), node.columns.length);
      return rows ? <SurfaceTable label={node.label} columns={node.columns} rows={rows} previewRows={node.previewRows} /> : null;
    }
    case "PortfolioAllocation":
    case "PortfolioPerformance":
    case "PortfolioSources":
      return <A2uiPortfolioRead component={node.component} value={readA2uiBinding(surface, node.snapshot)} />;
    case "FinanceShareProposal":
      return allowFinanceShare
        ? <FinanceShareProposal audience={node.audience} />
        : <p className="ui-text-row-description">Portfolio sharing was proposed.</p>;
    case "SavedPortfolio":
      return portfolioConversationId
        ? <FinancePortfolioCard section={node.section} conversationId={portfolioConversationId} />
        : <p className="ui-text-row-description">Saved portfolio requested.</p>;
  }
}

export function A2uiSurfaceView({ surface, allowFinanceShare = false, portfolioConversationId }: {
  surface: A2uiSurface; allowFinanceShare?: boolean; portfolioConversationId?: string;
}) {
  return <SurfaceNode surface={surface} id="root" allowFinanceShare={allowFinanceShare}
    portfolioConversationId={portfolioConversationId} />;
}
