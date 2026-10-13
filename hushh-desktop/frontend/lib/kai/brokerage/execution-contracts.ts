/**
 * Reserved execution-layer contracts for future broker adapters.
 *
 * These types intentionally do not expose any live-trading route today.
 * Plaid remains the read-only brokerage connectivity source.
 */

export type ExecutionStatus =
  | "draft"
  | "approval_required"
  | "approved"
  | "submitted"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "rejected"
  | "failed";

export interface BrokerConnection {
  connection_id: string;
  user_id: string;
  broker_id: string;
  broker_name: string;
  status: "active" | "relink_required" | "permission_revoked" | "error";
  accounts: ExecutionAccount[];
}

export interface ExecutionBroker {
  broker_id: string;
  broker_name: string;
  capabilities: Array<"equities" | "etfs" | "options" | "paper_trading" | "fractional_shares">;
}

export interface ExecutionAccount {
  execution_account_id: string;
  broker_connection_id: string;
  account_id: string;
  name: string;
  subtype?: string | null;
  currency?: string | null;
}

export interface OrderIntent {
  intent_id: string;
  user_id: string;
  source: "optimize" | "debate" | "manual";
  symbol: string;
  side: "buy" | "sell";
  quantity?: number | null;
  notional?: number | null;
  reason?: string | null;
  portfolio_source?: "statement" | "plaid";
}

export interface OrderPreview {
  preview_id: string;
  intent_id: string;
  estimated_price?: number | null;
  estimated_fees?: number | null;
  warnings: string[];
  suitability_notes: string[];
}

export interface ExecutionApproval {
  approval_id: string;
  intent_id: string;
  required: boolean;
  approved_at?: string | null;
  approved_by_user_id?: string | null;
}

export interface ExecutionOrder {
  order_id: string;
  intent_id: string;
  execution_account_id: string;
  status: ExecutionStatus;
  submitted_at?: string | null;
  filled_at?: string | null;
  external_order_id?: string | null;
}
