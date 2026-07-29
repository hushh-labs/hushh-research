// components/kai/cards/transaction-activity.tsx

"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
// Updated to match the exact exported name from the file
import { RelativeTime } from "@/components/app-ui/relative-time"; 
import { ArrowDownRight, ArrowUpRight, Clock, Receipt } from "lucide-react";
import { cn } from "@/lib/utils";

interface TransactionActivityProps {
  // Accepts NormalizedPortfolioTransaction arrays from the master views without strict type clashing
  transactions?: any[];
  maxItems?: number; // Added to satisfy TS and master views
  className?: string;
}

export function TransactionActivity({ transactions = [], maxItems, className }: TransactionActivityProps) {
  // Apply maxItems limit if provided by the parent view
  const displayTransactions = maxItems ? transactions.slice(0, maxItems) : transactions;

  return (
    <Card variant="none" effect="glass" className={cn("border border-border/50", className)}>
      <CardHeader className="pb-3 border-b border-border/30">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-md bg-primary/10 text-primary">
            <Clock size={16} />
          </div>
          <CardTitle className="text-sm font-semibold tracking-wide uppercase text-muted-foreground">
            Recent Activity
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-border/30">
          {displayTransactions.map((tx, index) => {
            // Dynamically map properties safely from NormalizedPortfolioTransaction
            const id = tx.id || tx.transactionId || tx.uuid || index.toString();
            const type = String(tx.type || tx.action || tx.transactionType || "transaction");
            const asset = tx.asset || tx.symbol || tx.ticker || "";
            const amount = Number(tx.amount || tx.total || tx.value || 0);
            const timestamp = tx.timestamp || tx.date || tx.createdAt || new Date().toISOString();
            const status = String(tx.status || tx.state || "completed").toLowerCase();

            const isPositive = type.toLowerCase() === "deposit" || type.toLowerCase() === "sell" || type.toLowerCase().includes("credit");
            const Icon = isPositive ? ArrowDownRight : ArrowUpRight;
            const iconColor = isPositive ? "text-emerald-500 bg-emerald-500/10" : "text-amber-500 bg-amber-500/10";

            return (
              <div key={id} className="flex items-center justify-between p-4 hover:bg-muted/10 transition-colors">
                <div className="flex items-center gap-3">
                  <div className={cn("w-9 h-9 rounded-full flex items-center justify-center shrink-0", iconColor)}>
                    <Icon size={18} />
                  </div>
                  <div>
                    <p className="text-sm font-bold capitalize leading-none mb-1 text-foreground">
                      {type} <span className="text-muted-foreground font-medium">{asset}</span>
                    </p>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Receipt size={12} />
                      {/* HARVESTED HYDRATION-SAFE RELATIVE TIME COMPONENT */}
                      <RelativeTime date={timestamp} className="font-medium" />
                    </div>
                  </div>
                </div>
                
                <div className="text-right">
                  <p className={cn("text-sm font-black tracking-tight", isPositive ? "text-emerald-500" : "text-foreground")}>
                    {isPositive ? "+" : "-"}${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                  <Badge status={status} />
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function Badge({ status }: { status: string }) {
  const isCompleted = status === "completed" || status === "settled" || status === "success";
  const isFailed = status === "failed" || status === "cancelled" || status === "error";
  
  const styles = isCompleted 
    ? "text-emerald-600 bg-emerald-500/10 border-emerald-500/20"
    : isFailed 
    ? "text-red-600 bg-red-500/10 border-red-500/20" 
    : "text-amber-600 bg-amber-500/10 border-amber-500/20";
  
  return (
    <span className={cn("inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider border", styles)}>
      {status}
    </span>
  );
}

export default TransactionActivity;