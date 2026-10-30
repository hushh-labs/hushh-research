// components/kai/cards/cash-management-card.tsx

/**
 * Cash Management Card - Detailed cash activity breakdown
 *
 * Features:
 * - Checking activity (checks paid with numbers and payees)
 * - Debit card transactions (merchant details)
 * - Deposits and withdrawals (ACH, wire, transfers)
 * - Tabbed interface for different activity types
 * - Responsive and mobile-friendly
 */

"use client";

import { useState } from "react";
import {
  CreditCard,
  Receipt,
  ArrowDownLeft,
  ArrowUpRight,
  Building2,
  Hash,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/lib/morphy-ux/ui";

// =============================================================================
// TYPES
// =============================================================================

export interface CheckTransaction {
  date: string;
  check_number: string;
  payee: string;
  amount: number;
}

export interface DebitTransaction {
  date: string;
  merchant: string;
  amount: number;
}

export interface BankTransfer {
  date: string;
  type: string; // ACH, Wire, Transfer
  description: string;
  amount: number;
}

export interface CashManagement {
  checking_activity?: CheckTransaction[];
  debit_card_activity?: DebitTransaction[];
  deposits_and_withdrawals?: BankTransfer[];
}

interface CashManagementCardProps {
  cashManagement?: CashManagement;
  className?: string;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function formatCurrency(value: number): string {
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value));

  return value < 0 ? `-${formatted}` : formatted;
}

function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

// =============================================================================
// TRANSACTION ROW COMPONENTS
// =============================================================================

function CheckRow({ transaction }: { transaction: CheckTransaction }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
      <div className="flex items-center gap-3">
        <div className="p-1.5 rounded-lg bg-muted">
          <Icon icon={Hash} size="xs" className="text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium">{transaction.payee}</p>
          <p className="text-xs text-muted-foreground">
            Check #{transaction.check_number} • {formatDate(transaction.date)}
          </p>
        </div>
      </div>
      <span className="text-sm font-medium text-red-500">
        -{formatCurrency(transaction.amount)}
      </span>
    </div>
  );
}

function DebitRow({ transaction }: { transaction: DebitTransaction }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
      <div className="flex items-center gap-3">
        <div className="p-1.5 rounded-lg bg-muted">
          <Icon icon={CreditCard} size="xs" className="text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium">{transaction.merchant}</p>
          <p className="text-xs text-muted-foreground">
            {formatDate(transaction.date)}
          </p>
        </div>
      </div>
      <span className="text-sm font-medium text-red-500">
        -{formatCurrency(transaction.amount)}
      </span>
    </div>
  );
}

function TransferRow({ transaction }: { transaction: BankTransfer }) {
  const isDeposit = transaction.amount > 0;
  const Lucide = isDeposit ? ArrowDownLeft : ArrowUpRight;

  return (
    <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "p-1.5 rounded-lg",
            isDeposit ? "bg-emerald-500/10" : "bg-red-500/10"
          )}
        >
          <Icon
            icon={Lucide}
            size="xs"
            className={isDeposit ? "text-emerald-500" : "text-red-500"}
          />
        </div>
        <div>
          <p className="text-sm font-medium">{transaction.description}</p>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {transaction.type}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {formatDate(transaction.date)}
            </span>
          </div>
        </div>
      </div>
      <span
        className={cn(
          "text-sm font-medium",
          isDeposit ? "text-emerald-500" : "text-red-500"
        )}
      >
        {isDeposit ? "+" : "-"}
        {formatCurrency(transaction.amount)}
      </span>
    </div>
  );
}

// =============================================================================
// EMPTY STATE
// =============================================================================

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <Icon icon={Receipt} size={32} className="text-muted-foreground/50 mb-2" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function CashManagementCard({
  cashManagement,
  className,
}: CashManagementCardProps) {
  const [activeTab, setActiveTab] = useState("transfers");

  const checkCount = cashManagement?.checking_activity?.length || 0;
  const debitCount = cashManagement?.debit_card_activity?.length || 0;
  const transferCount = cashManagement?.deposits_and_withdrawals?.length || 0;

  const totalCount = checkCount + debitCount + transferCount;

  if (!cashManagement || totalCount === 0) {
    return null;
  }

  // Calculate totals
  const totalChecks =
    cashManagement.checking_activity?.reduce(
      (sum, t) => sum + (t.amount || 0),
      0
    ) || 0;
  const totalDebit =
    cashManagement.debit_card_activity?.reduce(
      (sum, t) => sum + (t.amount || 0),
      0
    ) || 0;
  const totalDeposits =
    cashManagement.deposits_and_withdrawals
      ?.filter((t) => t.amount > 0)
      .reduce((sum, t) => sum + t.amount, 0) || 0;
  const totalWithdrawals =
    cashManagement.deposits_and_withdrawals
      ?.filter((t) => t.amount < 0)
      .reduce((sum, t) => sum + Math.abs(t.amount), 0) || 0;

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon icon={Building2} size="md" className="text-primary" />
            <CardTitle className="text-base">Cash Management</CardTitle>
          </div>
          <Badge variant="secondary" className="text-xs">
            {totalCount} transaction{totalCount !== 1 ? "s" : ""}
          </Badge>
        </div>
      </CardHeader>

      <CardContent>
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-3 mb-4">
            <TabsTrigger value="transfers" className="text-xs">
              Transfers
              {transferCount > 0 && (
                <span className="ml-1 text-muted-foreground">
                  ({transferCount})
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="checks" className="text-xs">
              Checks
              {checkCount > 0 && (
                <span className="ml-1 text-muted-foreground">
                  ({checkCount})
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="debit" className="text-xs">
              Debit
              {debitCount > 0 && (
                <span className="ml-1 text-muted-foreground">
                  ({debitCount})
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="transfers" className="mt-0">
            {transferCount > 0 ? (
              <div className="space-y-0">
                {/* Summary */}
                <div className="flex justify-between text-xs text-muted-foreground mb-3 pb-2 border-b border-border">
                  <span>
                    Deposits:{" "}
                    <span className="text-emerald-500 font-medium">
                      +{formatCurrency(totalDeposits)}
                    </span>
                  </span>
                  <span>
                    Withdrawals:{" "}
                    <span className="text-red-500 font-medium">
                      -{formatCurrency(totalWithdrawals)}
                    </span>
                  </span>
                </div>
                {/* Transactions */}
                <div className="max-h-[200px] overflow-y-auto">
                  {cashManagement.deposits_and_withdrawals?.map((tx, i) => (
                    <TransferRow key={i} transaction={tx} />
                  ))}
                </div>
              </div>
            ) : (
              <EmptyState message="No transfers this period" />
            )}
          </TabsContent>

          <TabsContent value="checks" className="mt-0">
            {checkCount > 0 ? (
              <div className="space-y-0">
                {/* Summary */}
                <div className="text-xs text-muted-foreground mb-3 pb-2 border-b border-border">
                  Total checks paid:{" "}
                  <span className="text-red-500 font-medium">
                    -{formatCurrency(totalChecks)}
                  </span>
                </div>
                {/* Transactions */}
                <div className="max-h-[200px] overflow-y-auto">
                  {cashManagement.checking_activity?.map((tx, i) => (
                    <CheckRow key={i} transaction={tx} />
                  ))}
                </div>
              </div>
            ) : (
              <EmptyState message="No checks paid this period" />
            )}
          </TabsContent>

          <TabsContent value="debit" className="mt-0">
            {debitCount > 0 ? (
              <div className="space-y-0">
                {/* Summary */}
                <div className="text-xs text-muted-foreground mb-3 pb-2 border-b border-border">
                  Total debit purchases:{" "}
                  <span className="text-red-500 font-medium">
                    -{formatCurrency(totalDebit)}
                  </span>
                </div>
                {/* Transactions */}
                <div className="max-h-[200px] overflow-y-auto">
                  {cashManagement.debit_card_activity?.map((tx, i) => (
                    <DebitRow key={i} transaction={tx} />
                  ))}
                </div>
              </div>
            ) : (
              <EmptyState message="No debit card activity this period" />
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
