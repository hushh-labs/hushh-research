export type RuntimeProviderAvailability = "available" | "coming_soon";

export type RuntimeProviderCatalogEntry = {
  id: "gemini" | "openai" | "anthropic" | "grok" | "meta_muse_spark";
  name: string;
  availability: RuntimeProviderAvailability;
  /** Consumer-safe label; never a runtime routing identifier. */
  description: string;
};

/**
 * Presentation-only provider inventory. Runtime routing remains server-owned;
 * a coming-soon card is deliberately not selectable and cannot alter a model.
 */
export const RUNTIME_PROVIDER_CATALOG: readonly RuntimeProviderCatalogEntry[] = [
  {
    id: "gemini",
    name: "Google Gemini",
    availability: "available",
    description: "Use Hussh managed Gemini or your own Gemini API key.",
  },
  {
    id: "openai",
    name: "OpenAI",
    availability: "coming_soon",
    description: "Bring your own access is coming soon.",
  },
  {
    id: "anthropic",
    name: "Claude",
    availability: "coming_soon",
    description: "Claude access is coming soon.",
  },
  {
    id: "grok",
    name: "Grok",
    availability: "coming_soon",
    description: "Bring your own access is coming soon.",
  },
  {
    id: "meta_muse_spark",
    name: "Meta Muse Spark",
    availability: "coming_soon",
    description: "Private-preview access is coming soon.",
  },
] as const;
