// Allocation colors describe existing categories, independently of their rank.
// Reuse the app's theme-aware system palette without changing other charts.
const ALLOCATION_COLORS: Readonly<Record<string, string>> = {
  equities: "var(--system-blue)",
  equity: "var(--system-blue)",
  stocks: "var(--system-blue)",
  technology: "var(--system-blue)",
  "information technology": "var(--system-blue)",
  "fixed income": "var(--app-teal)",
  bonds: "var(--app-teal)",
  financials: "var(--app-indigo)",
  healthcare: "var(--app-teal)",
  "health care": "var(--app-teal)",
  cash: "var(--system-green)",
  "cash equivalents": "var(--system-green)",
  industrials: "var(--system-orange)",
  energy: "var(--system-orange)",
  materials: "var(--system-orange)",
  "consumer discretionary": "var(--app-purple)",
  "consumer staples": "var(--app-purple)",
  "communication services": "var(--app-purple)",
  "real estate": "var(--app-purple)",
  utilities: "var(--system-green)",
  alternatives: "var(--app-purple)",
  "real assets": "var(--system-orange)",
};

export function allocationColor(category: string): string {
  return ALLOCATION_COLORS[category.trim().replace(/\s+/g, " ").toLowerCase()]
    ?? "var(--muted-foreground)";
}
