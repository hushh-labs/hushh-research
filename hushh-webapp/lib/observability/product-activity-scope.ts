import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent, type AuthSessionOwnerSnapshot } from "@/lib/auth/session-owner";
import { subscribeDurableOwnerReset } from "@/lib/services/secure-durable-resource-service";

let reset = 0;
if (typeof window !== "undefined") subscribeDurableOwnerReset(() => { reset++; });
export type ProductActivityScope = { owner: AuthSessionOwnerSnapshot; reset: number };
export function snapshotProductActivityScope(): ProductActivityScope | null {
  const owner = snapshotValidatedAuthSessionOwner();
  return owner ? { owner, reset } : null;
}
export function isProductActivityScopeCurrent(scope: ProductActivityScope): boolean {
  return scope.reset === reset && isValidatedAuthSessionOwnerCurrent(scope.owner);
}
