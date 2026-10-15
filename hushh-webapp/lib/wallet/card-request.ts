import { ROUTES } from "@/lib/navigation/routes";

export type WalletCardRequest = {
  id: string;
  status: "pending" | "fulfilled" | "declined" | "cancelled" | "expired";
  role: "owner" | "requester";
  requesterPersonRef: string;
  requesterName: string;
  ownerName: string;
  createdAt: string;
  expiresAt: string;
};

export const isCardRequestId = (value: string): boolean =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    value,
  );

export function cardRequestReference(content: string): string | null {
  const id = /^\[wallet-request:([^\]]+)\]$/.exec(content)?.[1];
  return id && isCardRequestId(id) ? id : null;
}

export function walletCardRequestHref(id: string): string {
  return isCardRequestId(id)
    ? `${ROUTES.ONE_WALLET}?card_request=${encodeURIComponent(id)}`
    : ROUTES.ONE_WALLET;
}

export function readCardRequest(value: unknown): WalletCardRequest {
  const row = value as Partial<WalletCardRequest> | null;
  if (
    !row ||
    typeof row.id !== "string" ||
    !isCardRequestId(row.id) ||
    typeof row.requesterPersonRef !== "string" ||
    !isCardRequestId(row.requesterPersonRef) ||
    !["pending", "fulfilled", "declined", "cancelled", "expired"].includes(
      String(row.status),
    ) ||
    !["owner", "requester"].includes(String(row.role)) ||
    ![row.requesterName, row.ownerName].every(
      (name) =>
        typeof name === "string" && name.length > 0 && name.length <= 200,
    ) ||
    ![row.createdAt, row.expiresAt].every(
      (date) => typeof date === "string" && Number.isFinite(Date.parse(date)),
    )
  ) {
    throw new Error("Card request is unavailable.");
  }
  return {
    id: row.id,
    status: row.status!,
    role: row.role!,
    requesterPersonRef: row.requesterPersonRef,
    requesterName: row.requesterName!,
    ownerName: row.ownerName!,
    createdAt: row.createdAt!,
    expiresAt: row.expiresAt!,
  };
}
