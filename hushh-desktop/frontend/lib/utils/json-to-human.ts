/**
 * JSON to Human-Readable Formatter
 *
 * Transforms streaming JSON from Gemini document parsing into
 * human-readable format for real-time display during extraction.
 *
 * Features:
 * - Incremental parsing of partial JSON
 * - Currency and percentage formatting
 * - Section headers and bullet lists
 * - Graceful handling of incomplete data
 */

// =============================================================================
// TYPES
// =============================================================================

export interface ParserContext {
  /** Current section being parsed */
  currentSection: string | null;
  /** Accumulated complete JSON so far */
  accumulatedJson: string;
  /** Last formatted output */
  lastOutput: string;
  /** Number of holdings found */
  holdingsCount: number;
  /** Number of transactions found */
  transactionsCount: number;
  /** Whether we've seen the opening brace */
  jsonStarted: boolean;
}

export interface FormattedOutput {
  /** Human-readable text */
  text: string;
  /** Updated parser context */
  context: ParserContext;
  /** Section that was just completed (if any) */
  completedSection?: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const SECTION_LABELS: Record<string, string> = {
  account_metadata: "Account Information",
  portfolio_summary: "Portfolio Summary",
  asset_allocation: "Asset Allocation",
  holdings: "Holdings",
  activity_and_transactions: "Transactions",
  cash_management: "Cash Management",
  income_summary: "Income Summary",
  realized_gain_loss: "Realized Gains/Losses",
  projections_and_mrd: "Projections & MRD",
  historical_values: "Historical Values",
  cash_flow: "Cash Flow",
  ytd_metrics: "Year-to-Date Metrics",
  legal_and_disclosures: "Legal Disclosures",
};

const FIELD_LABELS: Record<string, string> = {
  // Account metadata
  institution_name: "Institution",
  account_holder: "Account Holder",
  account_number: "Account Number",
  statement_period_start: "Period Start",
  statement_period_end: "Period End",
  account_type: "Account Type",
  
  // Portfolio summary
  beginning_value: "Beginning Value",
  ending_value: "Ending Value",
  total_change: "Total Change",
  net_deposits_withdrawals: "Net Deposits/Withdrawals",
  investment_gain_loss: "Investment Gain/Loss",
  
  // Holdings
  description: "Security",
  symbol_cusip: "Symbol",
  quantity: "Shares",
  price: "Price",
  market_value: "Market Value",
  cost_basis: "Cost Basis",
  unrealized_gain_loss: "Unrealized Gain/Loss",
  unrealized_gain_loss_pct: "Gain/Loss %",
  acquisition_date: "Acquired",
  estimated_annual_income: "Est. Annual Income",
  est_yield: "Yield",
  asset_class: "Asset Class",
  
  // Transactions
  date: "Date",
  transaction_type: "Type",
  amount: "Amount",
  realized_gain_loss: "Realized Gain/Loss",
  
  // Income
  taxable_dividends: "Taxable Dividends",
  qualified_dividends: "Qualified Dividends",
  tax_exempt_interest: "Tax-Exempt Interest",
  taxable_interest: "Taxable Interest",
  capital_gains_distributions: "Capital Gains",
  total_income: "Total Income",
  
  // Cash flow
  opening_balance: "Opening Balance",
  closing_balance: "Closing Balance",
  deposits: "Deposits",
  withdrawals: "Withdrawals",
  dividends_received: "Dividends Received",
  interest_received: "Interest Received",
  
  // Totals
  cash_balance: "Cash Balance",
  total_value: "Total Portfolio Value",
};

// Fields that should be formatted as currency
const CURRENCY_FIELDS = new Set([
  "beginning_value", "ending_value", "total_change", "net_deposits_withdrawals",
  "investment_gain_loss", "market_value", "cost_basis", "unrealized_gain_loss",
  "price", "amount", "estimated_annual_income", "taxable_dividends",
  "qualified_dividends", "tax_exempt_interest", "taxable_interest",
  "capital_gains_distributions", "total_income", "opening_balance",
  "closing_balance", "deposits", "withdrawals", "dividends_received",
  "interest_received", "cash_balance", "total_value", "realized_gain_loss",
  "short_term_gain", "short_term_loss", "long_term_gain", "long_term_loss",
  "net_short_term", "net_long_term", "net_realized", "projected_income",
  "required_amount", "amount_taken", "remaining", "fees_paid", "trades_proceeds",
  "trades_cost", "value",
]);

// Fields that should be formatted as percentage
const PERCENTAGE_FIELDS = new Set([
  "unrealized_gain_loss_pct", "est_yield", "percentage",
]);

// =============================================================================
// FORMATTING HELPERS
// =============================================================================

/**
 * Clean markdown formatting from text (removes *, **, ***, `)
 */
function cleanMarkdown(text: string): string {
  return text
    .replace(/\*\*\*/g, '')  // Remove bold+italic
    .replace(/\*\*/g, '')    // Remove bold
    .replace(/\*/g, '')      // Remove italic
    .replace(/`/g, '')       // Remove code backticks
    .trim();
}

function formatCurrency(value: number): string {
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value));
  
  return value < 0 ? `-${formatted}` : formatted;
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  }).format(value);
}

function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined) {
    return "N/A";
  }
  
  if (typeof value === "number") {
    if (CURRENCY_FIELDS.has(key)) {
      return formatCurrency(value);
    }
    if (PERCENTAGE_FIELDS.has(key)) {
      return formatPercent(value);
    }
    return formatNumber(value);
  }
  
  if (typeof value === "string") {
    // Clean any markdown formatting from string values
    return cleanMarkdown(value);
  }
  
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  
  return String(value);
}

function getFieldLabel(key: string): string {
  return FIELD_LABELS[key] || key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// =============================================================================
// MAIN FORMATTER
// =============================================================================

/**
 * Create a new parser context
 */
export function createParserContext(): ParserContext {
  return {
    currentSection: null,
    accumulatedJson: "",
    lastOutput: "",
    holdingsCount: 0,
    transactionsCount: 0,
    jsonStarted: false,
  };
}

/**
 * Format a complete JSON object into human-readable text
 */
export function formatCompleteJson(json: Record<string, unknown>): string {
  const lines: string[] = [];
  
  for (const [sectionKey, sectionValue] of Object.entries(json)) {
    if (sectionValue === null || sectionValue === undefined) continue;
    
    const sectionLabel = SECTION_LABELS[sectionKey] || getFieldLabel(sectionKey);
    
    // Handle top-level scalar values
    if (typeof sectionValue === "number" || typeof sectionValue === "string") {
      lines.push(`${sectionLabel}: ${formatValue(sectionKey, sectionValue)}`);
      continue;
    }
    
    // Handle arrays
    if (Array.isArray(sectionValue)) {
      if (sectionValue.length === 0) continue;
      
      lines.push("");
      lines.push(`--- ${sectionLabel} (${sectionValue.length} items) ---`);
      
      // For holdings and transactions, show summary
      if (sectionKey === "holdings") {
        for (const item of sectionValue.slice(0, 10)) {
          const holding = item as Record<string, unknown>;
          const symbol = holding.symbol_cusip || holding.description || "Unknown";
          const value = holding.market_value;
          const gainLoss = holding.unrealized_gain_loss;
          
          let line = `  • ${symbol}`;
          if (value !== null && value !== undefined) {
            line += `: ${formatCurrency(value as number)}`;
          }
          if (gainLoss !== null && gainLoss !== undefined) {
            const gl = gainLoss as number;
            line += ` (${gl >= 0 ? "+" : ""}${formatCurrency(gl)})`;
          }
          lines.push(line);
        }
        if (sectionValue.length > 10) {
          lines.push(`  ... and ${sectionValue.length - 10} more holdings`);
        }
      } else if (sectionKey === "activity_and_transactions") {
        for (const item of sectionValue.slice(0, 5)) {
          const tx = item as Record<string, unknown>;
          const date = tx.date || "";
          const type = tx.transaction_type || tx.type || "";
          const desc = tx.description || "";
          const amount = tx.amount;
          
          let line = `  • ${date} - ${type}`;
          if (desc) line += `: ${desc}`;
          if (amount !== null && amount !== undefined) {
            line += ` (${formatCurrency(amount as number)})`;
          }
          lines.push(line);
        }
        if (sectionValue.length > 5) {
          lines.push(`  ... and ${sectionValue.length - 5} more transactions`);
        }
      } else if (sectionKey === "asset_allocation") {
        for (const item of sectionValue) {
          const alloc = item as Record<string, unknown>;
          const category = alloc.category || "Unknown";
          const pct = alloc.percentage;
          const value = alloc.market_value;
          
          let line = `  • ${category}`;
          if (pct !== null && pct !== undefined) {
            line += `: ${(pct as number).toFixed(1)}%`;
          }
          if (value !== null && value !== undefined) {
            line += ` (${formatCurrency(value as number)})`;
          }
          lines.push(line);
        }
      } else if (sectionKey === "legal_and_disclosures") {
        lines.push(`  ${sectionValue.length} disclosure(s) extracted`);
      } else if (sectionKey === "historical_values") {
        lines.push(`  ${sectionValue.length} data point(s) for portfolio history chart`);
      } else {
        // Generic array handling
        for (const item of sectionValue.slice(0, 3)) {
          if (typeof item === "object" && item !== null) {
            const obj = item as Record<string, unknown>;
            const firstValue = Object.values(obj).find(v => v !== null && v !== undefined);
            lines.push(`  • ${String(firstValue || "Item")}`);
          } else {
            lines.push(`  • ${String(item)}`);
          }
        }
        if (sectionValue.length > 3) {
          lines.push(`  ... and ${sectionValue.length - 3} more`);
        }
      }
      continue;
    }
    
    // Handle objects
    if (typeof sectionValue === "object") {
      lines.push("");
      lines.push(`--- ${sectionLabel} ---`);
      
      for (const [key, value] of Object.entries(sectionValue as Record<string, unknown>)) {
        if (value === null || value === undefined) continue;
        
        // Handle nested objects (like year_to_date_totals)
        if (typeof value === "object" && !Array.isArray(value)) {
          lines.push(`  ${getFieldLabel(key)}:`);
          for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
            if (nestedValue === null || nestedValue === undefined) continue;
            lines.push(`    • ${getFieldLabel(nestedKey)}: ${formatValue(nestedKey, nestedValue)}`);
          }
        } else if (Array.isArray(value)) {
          lines.push(`  ${getFieldLabel(key)}: ${value.length} item(s)`);
        } else {
          lines.push(`  ${getFieldLabel(key)}: ${formatValue(key, value)}`);
        }
      }
    }
  }
  
  return lines.join("\n");
}

/**
 * Incrementally format streaming JSON chunks into human-readable text.
 * This function attempts to parse partial JSON and extract meaningful information.
 */
export function formatJsonChunk(
  chunk: string,
  context: ParserContext
): FormattedOutput {
  // Accumulate the chunk
  context.accumulatedJson += chunk;
  
  // Try to detect section changes
  const sectionMatches = chunk.matchAll(/"([a-z_]+)":\s*[{\[]/gi);
  for (const match of sectionMatches) {
    const sectionName = match[1];
    if (sectionName && SECTION_LABELS[sectionName]) {
      context.currentSection = sectionName;
    }
  }
  
  // Count holdings and transactions as they stream
  const holdingMatches = chunk.match(/"symbol_cusip":/g);
  if (holdingMatches) {
    context.holdingsCount += holdingMatches.length;
  }
  
  const txMatches = chunk.match(/"transaction_type":/g);
  if (txMatches) {
    context.transactionsCount += txMatches.length;
  }
  
  // Build incremental output
  const lines: string[] = [];
  
  // Show current section being processed
  if (context.currentSection) {
    const label = SECTION_LABELS[context.currentSection] || context.currentSection;
    lines.push(`Extracting: ${label}...`);
  }
  
  // Show counts
  if (context.holdingsCount > 0) {
    lines.push(`Found ${context.holdingsCount} holding(s)`);
  }
  if (context.transactionsCount > 0) {
    lines.push(`Found ${context.transactionsCount} transaction(s)`);
  }
  
  // Try to extract and format key values from the accumulated JSON
  const extractedValues: string[] = [];
  
  // Extract institution name
  const institutionMatch = context.accumulatedJson.match(/"institution_name":\s*"([^"]+)"/);
  if (institutionMatch) {
    extractedValues.push(`Institution: ${institutionMatch[1]}`);
  }
  
  // Extract account holder
  const holderMatch = context.accumulatedJson.match(/"account_holder":\s*"([^"]+)"/);
  if (holderMatch && holderMatch[1]) {
    extractedValues.push(`Account Holder: ${holderMatch[1].split(",")[0]}`);
  }
  
  // Extract total value
  const totalValueMatch = context.accumulatedJson.match(/"total_value":\s*([\d.]+)/);
  if (totalValueMatch && totalValueMatch[1]) {
    extractedValues.push(`Total Value: ${formatCurrency(parseFloat(totalValueMatch[1]))}`);
  }
  
  // Extract ending value
  const endingValueMatch = context.accumulatedJson.match(/"ending_value":\s*([\d.]+)/);
  if (endingValueMatch && endingValueMatch[1] && !totalValueMatch) {
    extractedValues.push(`Portfolio Value: ${formatCurrency(parseFloat(endingValueMatch[1]))}`);
  }
  
  if (extractedValues.length > 0) {
    lines.push("");
    lines.push(...extractedValues);
  }

  // Always surface the latest readable fragment so users see active stream movement.
  const compactChunk = cleanMarkdown(chunk.replace(/\s+/g, " ").trim());
  if (compactChunk && /[A-Za-z0-9]/.test(compactChunk)) {
    const preview =
      compactChunk.length > 180 ? `${compactChunk.slice(0, 180)}...` : compactChunk;
    lines.push("");
    lines.push(`Live chunk: ${preview}`);
  }
  
  let text = lines.join("\n");
  if (!text.trim()) {
    const compact = chunk.replace(/\s+/g, " ").trim();
    const preview = compact.length > 180 ? `${compact.slice(0, 180)}...` : compact;
    text = preview ? `Streaming extract: ${preview}` : "Streaming extract in progress...";
  }
  context.lastOutput = text;
  
  return {
    text,
    context,
  };
}

/**
 * Try to parse the accumulated JSON and format it completely.
 * Returns null if JSON is not yet complete/valid.
 */
export function tryFormatComplete(context: ParserContext): string | null {
  try {
    // Clean up the JSON string
    let jsonStr = context.accumulatedJson.trim();
    
    // Remove any markdown code fences
    jsonStr = jsonStr.replace(/^```json?\s*/i, "").replace(/\s*```$/i, "");
    
    const parsed = JSON.parse(jsonStr);
    return formatCompleteJson(parsed);
  } catch {
    return null;
  }
}
