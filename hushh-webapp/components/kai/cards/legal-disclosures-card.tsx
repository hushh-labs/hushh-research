"use client";

import { useState, useMemo } from "react";
import { FileText, ChevronDown, ChevronUp, Shield, Scale, Search, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/lib/morphy-ux/button";
import { Icon } from "@/lib/morphy-ux/ui";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

// =============================================================================
// TYPES
// =============================================================================

interface LegalDisclosuresCardProps {
  disclosures?: string[];
  className?: string;
}

// =============================================================================
// HELPERS
// =============================================================================

function categorizeDisclosure(text: string): {
  category: string;
  icon: React.ReactNode;
  priority: number;
} {
  const lowerText = text.toLowerCase();
  if (lowerText.includes("patriot act") || lowerText.includes("usa patriot")) 
    return { category: "USA PATRIOT Act", icon: <Icon icon={Shield} size="md" />, priority: 1 };
  if (lowerText.includes("sipc") || lowerText.includes("securities investor")) 
    return { category: "SIPC Protection", icon: <Icon icon={Shield} size="md" />, priority: 2 };
  if (lowerText.includes("fdic")) 
    return { category: "FDIC Insurance", icon: <Icon icon={Shield} size="md" />, priority: 3 };
  if (lowerText.includes("privacy") || lowerText.includes("personal information")) 
    return { category: "Privacy Notice", icon: <Icon icon={Scale} size="md" />, priority: 4 };
  if (lowerText.includes("risk") || lowerText.includes("investment risk")) 
    return { category: "Risk Disclosure", icon: <Icon icon={Scale} size="md" />, priority: 5 };
  
  return { category: "General Disclosure", icon: <Icon icon={FileText} size="md" />, priority: 10 };
}

function truncateText(text: string, maxLength: number = 150): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength).trim() + "...";
}

// =============================================================================
// DISCLOSURE ITEM
// =============================================================================

function DisclosureItem({ text }: { text: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { category, icon, priority } = categorizeDisclosure(text);
  const isLongText = text.length > 150;

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className={cn("border border-border/50 rounded-lg overflow-hidden transition-colors", isOpen ? "bg-muted/30" : "hover:bg-muted/20")}>
        <CollapsibleTrigger asChild>
          <button className="w-full p-3 flex items-start gap-3 text-left">
            <div className={cn("p-1.5 rounded-lg shrink-0 mt-0.5", priority <= 3 ? "bg-primary/10" : "bg-muted")}>
              {icon}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium">{category}</span>
                {priority <= 3 && <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-primary/5">Important</Badge>}
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2">{truncateText(text)}</p>
            </div>
            {isLongText && <Icon icon={isOpen ? ChevronUp : ChevronDown} size="sm" className="shrink-0 text-muted-foreground" />}
          </button>
        </CollapsibleTrigger>
        
        {isLongText && (
          <CollapsibleContent>
            <div className="px-3 pb-3 pt-0">
              <div className="bg-background rounded-lg p-3 border border-border/30 relative group">
                <p className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed pr-8">{text}</p>
                <button onClick={handleCopy} className="absolute top-2 right-2 p-1.5 hover:bg-muted rounded-md transition-colors">
                  <Icon icon={copied ? Check : Copy} size="xs" className={copied ? "text-green-500" : ""} />
                </button>
              </div>
            </div>
          </CollapsibleContent>
        )}
      </div>
    </Collapsible>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function LegalDisclosuresCard({ disclosures, className }: LegalDisclosuresCardProps) {
  const [showAll, setShowAll] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredDisclosures = useMemo(() => {
    if (!disclosures) return [];
    return [...disclosures]
      .filter((d: string) => d.toLowerCase().includes(searchQuery.toLowerCase()))
      .sort((a: string, b: string) => categorizeDisclosure(a).priority - categorizeDisclosure(b).priority);
  }, [disclosures, searchQuery]);

  if (!disclosures) return null;

  const visibleDisclosures = showAll ? filteredDisclosures : filteredDisclosures.slice(0, 3);

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Icon icon={Scale} size="lg" className="text-muted-foreground" />
            <CardTitle className="text-base">Legal Disclosures</CardTitle>
          </div>
          <Badge variant="secondary">{filteredDisclosures.length}</Badge>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input 
            placeholder="Search disclosures..." 
            className="pl-8 h-9 text-xs" 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {filteredDisclosures.length === 0 ? (
          <p className="text-xs text-center text-muted-foreground py-4">No results found.</p>
        ) : (
          <>
            {visibleDisclosures.map((d: string, i: number) => <DisclosureItem key={i} text={d} />)}
            {filteredDisclosures.length > 3 && (
              <Button 
                size="sm" 
                className="w-full text-xs" 
                onClick={() => setShowAll(!showAll)}
              >
                {showAll ? (
                  <><ChevronUp size={14} className="mr-1" /> Show less</>
                ) : (
                  <><ChevronDown size={14} className="mr-1" /> Show {filteredDisclosures.length - 3} more</>
                )}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}