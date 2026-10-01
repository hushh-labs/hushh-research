import { ApiService } from "@/lib/services/api-service";

export type SellerCatalogPilotVariant = {
  sourceVariantId: string;
  label: string | null;
  sku: string | null;
  recordedPrice: string;
  recordedInventory: number | null;
};

export type SellerCatalogPilotItem = {
  sourceProductId: string;
  state: "needs_seller_review" | "source_not_active" | "source_missing";
  sourceUpdatedAt?: string | null;
  title?: string | null;
  description?: string | null;
  vendor?: string | null;
  productType?: string | null;
  sourceStatus?: string;
  sourceHandle?: string | null;
  sourceUrl?: string | null;
  imageUrl?: string | null;
  imageAlt?: string | null;
  currency?: string;
  variants?: SellerCatalogPilotVariant[];
};

export type SellerCatalogPilotPreview = {
  mode: "technical_preview";
  source: "shopify";
  shopDomain: string;
  customerVisible: false;
  items: SellerCatalogPilotItem[];
};

export class SellerCatalogPilotError extends Error {
  constructor(readonly status: number) {
    super(
      status === 403
        ? "This private pilot is not enabled for your One account."
        : status === 503
          ? "The Shopify pilot connection is not configured yet."
          : "The Shopify preview is unavailable. Please try again later.",
    );
  }
}

/** Read the bounded, private Shopify preview through the shared web/native API path. */
export async function getSellerCatalogPilotPreview(
  vaultOwnerToken: string,
): Promise<SellerCatalogPilotPreview> {
  const response = await ApiService.apiFetch(
    "/api/one/seller-catalog/pilot/preview",
    {
      method: "GET",
      headers: ApiService.getAuthHeaders(vaultOwnerToken),
      cache: "no-store",
    },
  );
  if (!response.ok) throw new SellerCatalogPilotError(response.status);
  const payload = (await response.json()) as SellerCatalogPilotPreview;
  if (
    payload.mode !== "technical_preview" ||
    payload.customerVisible !== false ||
    !Array.isArray(payload.items)
  ) {
    throw new SellerCatalogPilotError(502);
  }
  return payload;
}
