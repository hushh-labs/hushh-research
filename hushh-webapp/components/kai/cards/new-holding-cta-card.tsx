"use client";

import { Plus, Upload, Loader2 } from "lucide-react";
import { Button } from "@/lib/morphy-ux/button";
import { Card, CardContent } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";

interface NewHoldingCtaCardProps {
  onAddHolding: () => void;
  onImportStatement: () => void;
  isLoading?: boolean;
  className?: string;
}

export function NewHoldingCtaCard({ 
  onAddHolding, 
  onImportStatement, 
  isLoading = false,
  className 
}: NewHoldingCtaCardProps) {
  return (
    <Card variant="none" effect="glass" preset="default" className={className}>
      <CardContent className="space-y-4 p-5">
        <div className="space-y-1">
          <h4 className="text-sm font-black tracking-tight text-foreground">
            New Holding Entry
          </h4>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Use Manage Portfolio for full edits, or import another statement for bulk updates.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button 
            variant="blue-gradient" 
            effect="fill" 
            size="default" 
            onClick={onAddHolding}
            disabled={isLoading}
          >
            {isLoading ? <Icon icon={Loader2} size="sm" className="mr-2 animate-spin" /> : <Icon icon={Plus} size="sm" className="mr-2" />}
            Add Holding
          </Button>
          
          {/* RECTIFIED: Removed 'variant' prop entirely to rely on component defaults 
              and avoid the Type mismatch error. */}
          <Button 
            effect="fade" 
            size="default" 
            onClick={onImportStatement}
            disabled={isLoading}
          >
            <Icon icon={Upload} size="sm" className="mr-2" />
            Import Statement
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}