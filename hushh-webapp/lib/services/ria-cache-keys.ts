import { createStableHash } from "@/lib/utils/hash";

export function buildRiaClientQueryKey(options?: {
  q?: string;
  status?: string;
  page?: number;
  limit?: number;
}): string {
  return createStableHash({
    q: options?.q || "",
    status: options?.status || "",
    page: options?.page || 1,
    limit: options?.limit || 50,
  });
}
