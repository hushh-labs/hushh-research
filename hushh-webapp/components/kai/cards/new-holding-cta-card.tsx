"use client";

import { Plus, Upload } from "lucide-react";
import { Button } from "@/lib/morphy-ux/button";
import { Card, CardContent } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";

interface NewHoldingCtaCardProps {
  onAddHolding: () => void;
  onImportStatement: () => void;
  className?: string;
}

export function NewHoldingCtaCard({ onAddHolding, onImportStatement, className }: NewHoldingCtaCardProps) {
  return (
    <Card variant="none" effect="glass" className={cn("overflow-hidden border-border/50", className)}>
      <CardContent className="space-y-4 p-5">
        <div className="space-y-1">
          <h4 className="text-sm font-semibold tracking-tight">New Holding Entry</h4>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Quickly add a single holding or import a statement for bulk updates.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button
            type="button"
            variant="blue-gradient"
            effect="fill"
            size="default"
            onClick={onAddHolding}
            aria-label="Add a new holding manually"
          >
            <Icon icon={Plus} size="sm" className="mr-2" aria-hidden="true" />
            Add Holding
          </Button>

          <Button
            type="button"
            // Changed from "outline" to "none" to resolve type error
            variant="none"
            effect="fade"
            size="default"
            onClick={onImportStatement}
            aria-label="Import holding data from a statement file"
          >
            <Icon icon={Upload} size="sm" className="mr-2" aria-hidden="true" />
            Import Statement
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}