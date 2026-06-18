"use client";

import { useState, useMemo } from "react";
import {
  CreditCard,
  Receipt,
  ArrowDownLeft,
  ArrowUpRight,
  Building2,
  Hash,
} from "lucide-react";

// ADJUST THESE PATHS to match your project structure
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";

// =============================================================================
// HELPERS (Defined inside or imported)
// =============================================================================

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value));
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return dateStr;
  }
}

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
  type: string;
  description: string;
  amount: number;
}

export interface CashManagement {
  checking_activity?: CheckTransaction[];
  debit_card_activity?: DebitTransaction[];
  deposits_and_withdrawals?: BankTransfer[];
}

export interface CashManagementCardProps {
  cashManagement?: CashManagement;
  className?: string;
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function CashManagementCard({
  cashManagement,
  className,
}: CashManagementCardProps) {
  const [activeTab, setActiveTab] = useState("transfers");

  // Logic remains the same...
  // Ensure all helpers (formatDate, formatCurrency) are in scope
  // ...
}