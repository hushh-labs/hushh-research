"use client";

import { Plus, Upload } from "lucide-react";

import { Button } from "@/lib/morphy-ux/button";
import { Card, CardContent } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";

interface NewHoldingCtaCardProps {
  onAddHolding: () => void;
  onImportStatement: () => void;
}

export function NewHoldingCtaCard({ onAddHolding, onImportStatement }: NewHoldingCtaCardProps) {
  return (
    <Card variant="none" effect="glass" preset="default">
      <CardContent className="space-y-4 p-5">
        <div className="space-y-1">
          <h4 className="text-sm font-black">New Holding Entry</h4>
          <p className="text-xs text-muted-foreground">
            Use Manage Portfolio for full edits, or import another statement for bulk updates.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button variant="blue-gradient" effect="fill" size="default" onClick={onAddHolding}>
            <Icon icon={Plus} size="sm" className="mr-2" aria-hidden="true" />
            Add Holding
          </Button>
          <Button variant="none" effect="fade" size="default" onClick={onImportStatement}>
            <Icon icon={Upload} size="sm" className="mr-2" aria-hidden="true" />
            Import Statement
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
