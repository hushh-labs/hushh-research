/** Explicit synthetic transport/native seams. Production form, OCR, WalletService,
 * PKM writer, segment encryption and AES-GCM codec are imported unchanged. */
import { encryptData, decryptData } from "../../lib/vault/encrypt";
export class AuthService {
  static getCurrentUser() { return { uid: "scan-proof-owner" }; }
  static async getIdTokenWithRetry() { return "synthetic-test-token"; }
}
export class ApiService {
  static async apiFetch(url: string, options: RequestInit & { beforeDispatch?: () => Promise<void>; isEffectCurrent?: () => boolean } = {}) {
    await options.beforeDispatch?.();
    if (options.isEffectCurrent && !options.isEffectCurrent()) throw new DOMException("Cancelled", "AbortError");
    // Explicit owned HTTP test transport; never part of the product bundle.
    return globalThis.fetch(url, options);
  }
}
export const HushhVault = {
  encryptData: ({ plaintext, keyHex }: { plaintext: string; keyHex: string }) => encryptData(plaintext, keyHex),
  decryptData: async ({ ciphertext, iv, tag, keyHex }: { ciphertext: string; iv: string; tag: string; keyHex: string }) => ({ plaintext: await decryptData({ ciphertext, iv, tag, algorithm: "aes-256-gcm", encoding: "base64" }, keyHex) }),
};
export const HushhPersonalKnowledgeModel = {};
export class CacheSyncService { static onPkmDomainStored() {} }
export function usePathname() { return "/one/wallet"; }
export function useSearchParams() { return new URLSearchParams(window.location.search); }
export const useRouter = () => ({ push() {}, replace() {}, back() {} });
