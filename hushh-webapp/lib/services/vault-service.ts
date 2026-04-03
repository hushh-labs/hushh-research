import { Capacitor } from "@capacitor/core";
import { HushhVault, HushhAuth, HushhConsent } from "@/lib/capacitor";
import { AuthService } from "@/lib/services/auth-service";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import {
  createVaultWithPassphrase as webCreateVault,
  unlockVaultWithPassphrase as webUnlockVault,
  unlockVaultWithRecoveryKey as webUnlockRecall,
} from "@/lib/vault/passphrase-key";
import { resolvePasskeyRpId } from "@/lib/vault/passkey-rp";
import { auth } from "@/lib/firebase/config";
import { apiJson } from "@/lib/services/api-client";
import {
  getLocalItem,
  getSessionItem,
  removeSessionItem,
  setSessionItem,
} from "@/lib/utils/session-storage";
import { resolveSlowRequestTimeoutMs } from "@/lib/utils/request-timeouts";
import type {
  GeneratedVaultProvisionResult,
  GeneratedVaultSupport,
  GeneratedVaultUnlockInput,
} from "@/lib/services/vault-bootstrap-service";

// Web must call same-origin Next.js API routes (/api/*) to avoid CORS issues when
// accessed via different Cloud Run hostnames. (Native uses plugins / backend URL.)

export type VaultMethod =
  | "passphrase"
  | "generated_default_native_biometric"
  | "generated_default_web_prf"
  | "generated_default_native_passkey_prf";

export interface VaultWrapper {
  method: VaultMethod;
  wrapperId?: string;
  encryptedVaultKey: string;
  salt: string;
  iv: string;
  passkeyCredentialId?: string;
  passkeyPrfSalt?: string;
  passkeyRpId?: string;
  passkeyProvider?: string;
  passkeyDeviceLabel?: string;
  passkeyLastUsedAt?: number;
}

export interface VaultState {
  vaultKeyHash: string;
  primaryMethod: VaultMethod;
  primaryWrapperId?: string;
  recoveryEncryptedVaultKey: string;
  recoverySalt: string;
  recoveryIv: string;
  wrappers: VaultWrapper[];
}

export class VaultService {
  private static readonly VAULT_STATE_CACHE_TTL_MS = 3 * 60 * 1000;
  private static readonly VAULT_CHECK_SESSION_TTL_MS = 30 * 60 * 1000;
  private static readonly ALLOWED_METHODS: VaultMethod[] = [
    "passphrase",
    "generated_default_native_biometric",
    "generated_default_web_prf",
    "generated_default_native_passkey_prf",
  ];
  private static vaultStateCache = new Map<
    string,
    {
      state: VaultState;
      cachedAt: number;
    }
  >();
  private static vaultCheckInflight = new Map<string, Promise<boolean>>();
  private static vaultStateInflight = new Map<string, Promise<VaultState>>();

  private static vaultCheckSessionKey(userId: string): string {
    return `vault_check:${userId}`;
  }

  private static readSessionVaultCheck(userId: string): boolean | null {
    const raw = getSessionItem(this.vaultCheckSessionKey(userId));
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as {
        exists?: boolean;
        cachedAt?: number;
      };
      if (
        typeof parsed?.exists !== "boolean" ||
        typeof parsed?.cachedAt !== "number"
      ) {
        removeSessionItem(this.vaultCheckSessionKey(userId));
        return null;
      }

      if (Date.now() - parsed.cachedAt > this.VAULT_CHECK_SESSION_TTL_MS) {
        removeSessionItem(this.vaultCheckSessionKey(userId));
        return null;
      }

      return parsed.exists;
    } catch {
      removeSessionItem(this.vaultCheckSessionKey(userId));
      return null;
    }
  }

  private static writeSessionVaultCheck(userId: string, exists: boolean): void {
    try {
      setSessionItem(
        this.vaultCheckSessionKey(userId),
        JSON.stringify({
          exists,
          cachedAt: Date.now(),
        })
      );
    } catch {
      // Ignore session persistence failures.
    }
  }

  private static readBootstrapVaultCheck(userId: string): boolean | null {
    const cached = CacheService.getInstance().get<{ hasVault?: unknown }>(
      CACHE_KEYS.PRE_VAULT_BOOTSTRAP(userId)
    );
    if (!cached) return null;
    return typeof cached.hasVault === "boolean" ? cached.hasVault : null;
  }

  private static async resolveVaultCheckFallback(userId: string): Promise<boolean | null> {
    const cached = this.readBootstrapVaultCheck(userId);
    if (cached !== null) {
      return cached;
    }

    try {
      const state = await PreVaultUserStateService.bootstrapState(userId);
      return state.hasVault;
    } catch (error) {
      console.warn("[VaultService] bootstrap-state fallback failed:", error);
      return null;
    }
  }

  private static normalizeNullableString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const normalized = trimmed.toLowerCase();
    if (normalized === "null" || normalized === "undefined" || normalized === "none") {
      return undefined;
    }
    return trimmed;
  }

  private static getCachedVaultState(userId: string): VaultState | null {
    const entry = this.vaultStateCache.get(userId);
    if (!entry) return null;
    const age = Date.now() - entry.cachedAt;
    if (age > this.VAULT_STATE_CACHE_TTL_MS) {
      this.vaultStateCache.delete(userId);
      return null;
    }
    return entry.state;
  }

  private static setCachedVaultState(userId: string, state: VaultState): void {
    this.vaultStateCache.set(userId, {
      state,
      cachedAt: Date.now(),
    });
  }

  static invalidateVaultStateCache(userId?: string): void {
    if (userId) {
      this.vaultStateCache.delete(userId);
      this.vaultCheckInflight.delete(userId);
      this.vaultStateInflight.delete(userId);
      removeSessionItem(this.vaultCheckSessionKey(userId));
      return;
    }
    this.vaultStateCache.clear();
    this.vaultCheckInflight.clear();
    this.vaultStateInflight.clear();
  }

  private static normalizeVaultKeyHex(value: string): string | null {
    const normalized = value.trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
  }

  private static normalizeMethod(value: unknown): VaultMethod {
    const normalized = this.normalizeNullableString(value)?.toLowerCase();
    if (
      normalized &&
      this.ALLOWED_METHODS.includes(normalized as VaultMethod)
    ) {
      return normalized as VaultMethod;
    }
    return "passphrase";
  }

  private static normalizeWrapper(wrapper: Partial<VaultWrapper>): VaultWrapper {
    const maybeWrapper = wrapper as Partial<VaultWrapper> & {
      encrypted_vault_key?: string;
      wrapper_id?: string;
      passkey_credential_id?: string;
      passkey_prf_salt?: string;
      passkey_rp_id?: string;
      passkey_provider?: string;
      passkey_device_label?: string;
      passkey_last_used_at?: number;
    };
    const passkeyLastUsedAtRaw =
      wrapper.passkeyLastUsedAt ?? maybeWrapper.passkey_last_used_at;
    const passkeyLastUsedAt =
      typeof passkeyLastUsedAtRaw === "number" ? passkeyLastUsedAtRaw : undefined;
    return {
      method: this.normalizeMethod(wrapper.method),
      wrapperId:
        this.normalizeNullableString(wrapper.wrapperId ?? maybeWrapper.wrapper_id) ??
        "default",
      encryptedVaultKey:
        this.normalizeNullableString(
          wrapper.encryptedVaultKey ?? maybeWrapper.encrypted_vault_key
        ) ?? "",
      salt: this.normalizeNullableString(wrapper.salt ?? maybeWrapper.salt) ?? "",
      iv: this.normalizeNullableString(wrapper.iv ?? maybeWrapper.iv) ?? "",
      passkeyCredentialId: this.normalizeNullableString(
        wrapper.passkeyCredentialId ?? maybeWrapper.passkey_credential_id
      ),
      passkeyPrfSalt: this.normalizeNullableString(
        wrapper.passkeyPrfSalt ?? maybeWrapper.passkey_prf_salt
      ),
      passkeyRpId: this.normalizeNullableString(
        wrapper.passkeyRpId ?? maybeWrapper.passkey_rp_id
      ),
      passkeyProvider: this.normalizeNullableString(
        wrapper.passkeyProvider ?? maybeWrapper.passkey_provider
      ),
      passkeyDeviceLabel: this.normalizeNullableString(
        wrapper.passkeyDeviceLabel ?? maybeWrapper.passkey_device_label
      ),
      passkeyLastUsedAt,
    };
  }

  private static getCurrentRpId(): string | null {
    const rpId = resolvePasskeyRpId({
      isNative: Capacitor.isNativePlatform(),
      hostname: typeof window !== "undefined" ? window.location.hostname : null,
    });
    return rpId || null;
  }

  private static describeWrapperPayload(input: unknown): string {
    if (input == null) return "nullish";
    if (Array.isArray(input)) return `array(len=${input.length})`;
    if (typeof input === "string") return `string(len=${input.length})`;
    if (typeof input !== "object") return typeof input;
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record);
    const lengthCandidate = Number(record.length);
    if (Number.isFinite(lengthCandidate) && lengthCandidate >= 0) {
      return `arrayLike(len=${lengthCandidate},keys=${keys.slice(0, 6).join("|")})`;
    }
    return `object(keys=${keys.slice(0, 8).join("|")})`;
  }

  private static extractWrappers(input: unknown): Partial<VaultWrapper>[] {
    if (!input) return [];

    if (Array.isArray(input)) {
      return input as Partial<VaultWrapper>[];
    }

    if (typeof input === "string") {
      try {
        const parsed = JSON.parse(input);
        return this.extractWrappers(parsed);
      } catch {
        return [];
      }
    }

    if (typeof input !== "object") {
      return [];
    }

    if (typeof (input as any)[Symbol.iterator] === "function") {
      try {
        const iterated = Array.from(input as Iterable<unknown>);
        if (iterated.length) {
          return iterated.filter((value) => value && typeof value === "object") as Partial<VaultWrapper>[];
        }
      } catch {
        // continue to object heuristics
      }
    }

    const record = input as Record<string, unknown>;

    // Capacitor/native bridges sometimes return array-like objects.
    const maybeLength = Number(record.length);
    if (Number.isFinite(maybeLength) && maybeLength > 0) {
      const items: Partial<VaultWrapper>[] = [];
      for (let index = 0; index < maybeLength; index += 1) {
        const candidate = record[String(index)];
        if (candidate && typeof candidate === "object") {
          items.push(candidate as Partial<VaultWrapper>);
        }
      }
      if (items.length) {
        return items;
      }
    }

    // Some bridge implementations wrap the payload as { wrappers: [...] }.
    if ("wrappers" in record) {
      return this.extractWrappers(record.wrappers);
    }

    // Some bridge implementations expose values through serialized toString().
    if (typeof (input as { toString?: () => string }).toString === "function") {
      try {
        const asString = (input as { toString: () => string }).toString();
        if (asString && asString !== "[object Object]") {
          const parsed = JSON.parse(asString);
          const parsedWrappers = this.extractWrappers(parsed);
          if (parsedWrappers.length) return parsedWrappers;
        }
      } catch {
        // ignore
      }
    }

    // Map/object fallback: { passphrase: {...}, generated_default_web_prf: {...} }.
    const objectValues = Object.values(record).filter(
      (value) => value && typeof value === "object"
    ) as Partial<VaultWrapper>[];

    return objectValues;
  }

  private static normalizeVaultState(vault: Partial<VaultState>): VaultState {
    const wrappers = this.extractWrappers(vault.wrappers).map((wrapper) =>
      this.normalizeWrapper(wrapper)
    );
    const normalizedWrappers = wrappers.filter(
      (wrapper) => !!wrapper.encryptedVaultKey && !!wrapper.salt && !!wrapper.iv
    );
    if (!normalizedWrappers.some((wrapper) => wrapper.method === "passphrase")) {
      const methods = Array.from(new Set(normalizedWrappers.map((wrapper) => wrapper.method)));
      throw new Error(
        `Vault state is invalid: passphrase wrapper missing (wrappers=${normalizedWrappers.length}, methods=${methods.join(",") || "none"}).`
      );
    }

    return {
      vaultKeyHash: this.normalizeNullableString(vault.vaultKeyHash) ?? "",
      primaryMethod: this.normalizeMethod(vault.primaryMethod),
      primaryWrapperId:
        this.normalizeNullableString(vault.primaryWrapperId) ?? "default",
      recoveryEncryptedVaultKey:
        this.normalizeNullableString(vault.recoveryEncryptedVaultKey) ?? "",
      recoverySalt: this.normalizeNullableString(vault.recoverySalt) ?? "",
      recoveryIv: this.normalizeNullableString(vault.recoveryIv) ?? "",
      wrappers: normalizedWrappers,
    };
  }

  private static findWrapperByMethod(
    state: VaultState,
    method: VaultMethod
  ): VaultWrapper | null {
    return state.wrappers.find((wrapper) => wrapper.method === method) ?? null;
  }

  private static isPasskeyMethod(method: VaultMethod): boolean {
    return (
      method === "generated_default_web_prf" ||
      method === "generated_default_native_passkey_prf"
    );
  }

  private static async buildApiError(
    response: Response,
    fallbackMessage: string
  ): Promise<Error> {
    let message = fallbackMessage;
    let code: string | undefined;

    try {
      const raw = await response.text();
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const detail =
            parsed?.detail && typeof parsed.detail === "object"
              ? (parsed.detail as Record<string, unknown>)
              : null;
          const directCode = this.normalizeNullableString(
            typeof parsed.code === "string" ? parsed.code : undefined
          );
          const directError = this.normalizeNullableString(
            typeof parsed.error === "string" ? parsed.error : undefined
          );
          const detailCode = this.normalizeNullableString(
            detail && typeof detail.code === "string" ? detail.code : undefined
          );
          const detailError = this.normalizeNullableString(
            detail && typeof detail.error === "string" ? detail.error : undefined
          );

          code = detailCode || directCode || undefined;
          message = detailError || directError || message;
        } catch {
          message = raw;
        }
      }
    } catch {
      // Ignore error body parse failures and keep fallback.
    }

    return new Error(code ? `${message} [${code}]` : message);
  }

  static getWrapperByMethod(
    state: VaultState,
    method: VaultMethod,
    options?: {
      wrapperId?: string;
      preferCurrentRpId?: boolean;
    }
  ): VaultWrapper | null {
    const all = state.wrappers.filter((wrapper) => wrapper.method === method);
    if (!all.length) return null;

    const shouldPreferRp =
      this.isPasskeyMethod(method) ? (options?.preferCurrentRpId ?? true) : false;
    const rpId = shouldPreferRp ? this.getCurrentRpId() : null;

    const requestedWrapperId = this.normalizeNullableString(options?.wrapperId);
    if (requestedWrapperId) {
      const requested =
        all.find((wrapper) => (wrapper.wrapperId ?? "default") === requestedWrapperId) ??
        null;
      if (!requested) return null;
      if (!shouldPreferRp || !rpId) return requested;
      const wrapperRpId = this.normalizeNullableString(requested.passkeyRpId);
      if (!wrapperRpId || wrapperRpId === rpId) return requested;
      return (
        all.find((wrapper) => this.normalizeNullableString(wrapper.passkeyRpId) === rpId) ?? null
      );
    }

    if (shouldPreferRp && rpId) {
      const rpMatch = all.find(
        (wrapper) => this.normalizeNullableString(wrapper.passkeyRpId) === rpId
      );
      if (rpMatch) return rpMatch;

      // If wrappers are explicitly pinned to other RP IDs, fail closed and fall
      // back to passphrase/recovery rather than triggering cross-device QR UX.
      const hasExplicitRpIds = all.some(
        (wrapper) => !!this.normalizeNullableString(wrapper.passkeyRpId)
      );
      if (hasExplicitRpIds) {
        return null;
      }
    }

    return all[0] ?? null;
  }

  static getPrimaryWrapper(state: VaultState): VaultWrapper {
    const wrapper =
      this.getWrapperByMethod(state, state.primaryMethod, {
        wrapperId: state.primaryWrapperId,
      }) ??
      this.findWrapperByMethod(state, "passphrase") ??
      state.wrappers[0];
    if (!wrapper) {
      throw new Error("Vault state has no enrolled wrappers.");
    }
    return wrapper;
  }

  static async hashVaultKey(vaultKeyHex: string): Promise<string> {
    const normalized = this.normalizeVaultKeyHex(vaultKeyHex);
    if (!normalized) {
      throw new Error("Invalid vault key hex.");
    }
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(normalized)
    );
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  static async unlockWithMethod(params: {
    state: VaultState;
    method: VaultMethod;
    secretMaterial: string;
  }): Promise<string | null> {
    const wrapper = this.getWrapperByMethod(params.state, params.method);
    if (!wrapper) return null;

    const decrypted = await this.unlockVault(
      params.secretMaterial,
      wrapper.encryptedVaultKey,
      wrapper.salt,
      wrapper.iv
    );
    if (!decrypted) return null;

    await this.assertVaultKeyMatchesState(params.state, decrypted);
    return decrypted;
  }

  static async assertVaultKeyMatchesState(
    state: VaultState,
    vaultKeyHex: string
  ): Promise<void> {
    const normalizedKey = this.normalizeVaultKeyHex(vaultKeyHex);
    if (!normalizedKey) {
      throw new Error("Vault key format is invalid.");
    }
    if (!state.vaultKeyHash) return;

    const hashed = await this.hashVaultKey(normalizedKey);
    if (hashed !== state.vaultKeyHash) {
      throw new Error("Vault key integrity check failed.");
    }
  }

  private static assertVaultStateForSetup(state: VaultState): void {
    if (!state.vaultKeyHash) {
      throw new Error("vaultKeyHash is required.");
    }
    if (
      !state.recoveryEncryptedVaultKey ||
      !state.recoverySalt ||
      !state.recoveryIv
    ) {
      throw new Error("Recovery wrapper is required.");
    }
    if (!state.wrappers.length) {
      throw new Error("At least one vault wrapper is required.");
    }
    const methods = new Set(state.wrappers.map((wrapper) => wrapper.method));
    if (!methods.has("passphrase")) {
      throw new Error("Passphrase wrapper is mandatory.");
    }
    const hasPrimaryWrapper = state.wrappers.some(
      (wrapper) =>
        wrapper.method === state.primaryMethod &&
        (wrapper.wrapperId ?? "default") === (state.primaryWrapperId ?? "default")
    );
    if (!hasPrimaryWrapper) {
      throw new Error("primaryMethod + primaryWrapperId must reference an enrolled wrapper.");
    }
  }

  private static shouldDebugVaultOwner(): boolean {
    // Keep this very cheap and safe in production: only logs when explicitly enabled.
    try {
      if (typeof window !== "undefined") {
        return (
          getLocalItem("debug_vault_owner") === "true" ||
          getSessionItem("debug_vault_owner") === "true"
        );
      }
    } catch {
      // ignore
    }
    return false;
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private static async debugAuthSnapshot(): Promise<Record<string, unknown>> {
    if (!Capacitor.isNativePlatform()) {
      return {
        platform: "web",
        firebaseJsCurrentUser: !!auth.currentUser,
        firebaseJsUid: auth.currentUser?.uid || null,
      };
    }

    try {
      const [{ signedIn }, { user }, { idToken }] = await Promise.all([
        HushhAuth.isSignedIn().catch(() => ({ signedIn: false })),
        HushhAuth.getCurrentUser().catch(() => ({ user: null })),
        HushhAuth.getIdToken().catch(() => ({ idToken: null })),
      ]);

      return {
        platform: "native",
        hushhAuthSignedIn: signedIn,
        hushhAuthUserId: user?.id || null,
        hushhAuthUserEmail: user?.email || null,
        hushhAuthIdTokenLen: idToken ? idToken.length : 0,
        firebaseJsCurrentUser: !!auth.currentUser,
        firebaseJsUid: auth.currentUser?.uid || null,
        envBackendUrl: process.env.NEXT_PUBLIC_BACKEND_URL || null,
      };
    } catch (e: any) {
      return {
        platform: "native",
        debugError: e?.message || String(e),
        envBackendUrl: process.env.NEXT_PUBLIC_BACKEND_URL || null,
      };
    }
  }

  /**
   * Get or issue VAULT_OWNER consent token (unified path for all native features).
   *
   * This is the single canonical function used by all native features (Kai, Identity, Food, etc.).
   * It checks for a valid cached token first, then issues a new one if needed.
   *
   * @param userId - Firebase user ID
   * @param currentToken - Current token from VaultContext (if available)
   * @param currentExpiresAt - Current token expiry timestamp (if available)
   * @returns Token + expiry + scope
   */
  static async getOrIssueVaultOwnerToken(
    userId: string,
    currentToken: string | null = null,
    currentExpiresAt: number | null = null
  ): Promise<{
    token: string;
    expiresAt: number;
    scope: string;
  }> {
    // Check if we have a valid cached token
    if (currentToken && currentExpiresAt) {
      const now = Date.now();
      const bufferMs = 5 * 60 * 1000; // 5 minute buffer before expiry
      if (now < currentExpiresAt - bufferMs) {
        console.log(
          "[VaultService] Reusing valid VAULT_OWNER token (expires in",
          Math.round((currentExpiresAt - now) / 1000 / 60),
          "minutes)"
        );
        return {
          token: currentToken,
          expiresAt: currentExpiresAt,
          scope: "VAULT_OWNER",
        };
      }
      console.log(
        "[VaultService] Cached token expired or expiring soon, issuing new one"
      );
    }

    // Issue new token
    console.log("[VaultService] Issuing new VAULT_OWNER token");

    // Phase A instrumentation: capture auth snapshot for debugging.
    if (this.shouldDebugVaultOwner()) {
      console.log(
        "[VaultService] VAULT_OWNER debug snapshot (before token acquisition):",
        await this.debugAuthSnapshot()
      );
    }

    // Phase B: deterministic token acquisition (native-first + fallback + single retry)
    const tryGetFirebaseIdToken = async (): Promise<string | undefined> => {
      // 1) Prefer the active Firebase JS SDK session first.
      // This is authoritative for review/custom-token bootstrap flows.
      const jsToken = await this.getFirebaseToken();
      if (jsToken) return jsToken;

      // 2) Fallback: AuthService (may use @capacitor-firebase/authentication)
      const fallback = await AuthService.getIdToken().catch(() => null);
      if (fallback) return fallback;

      // 3) Native plugin fallback
      const hushh = await HushhAuth.getIdToken().catch(() => ({ idToken: null }));
      if (hushh?.idToken) return hushh.idToken;

      return undefined;
    };

    let firebaseIdToken = await tryGetFirebaseIdToken();
    if (!firebaseIdToken) {
      // Small delay to mitigate race right after sign-in / app resume.
      await this.sleep(400);
      firebaseIdToken = await tryGetFirebaseIdToken();
    }

    if (!firebaseIdToken) {
      const snapshot = this.shouldDebugVaultOwner()
        ? await this.debugAuthSnapshot()
        : undefined;
      const hint = snapshot
        ? ` Debug: ${JSON.stringify(snapshot)}`
        : " Enable debug by setting localStorage.debug_vault_owner=true";
      throw new Error(
        `No Firebase ID token available (native).${hint}`
      );
    }

    return this.issueVaultOwnerToken(userId, firebaseIdToken);
  }

  /**
   * Issue VAULT_OWNER consent token for authenticated user.
   *
   * Called after successful vault unlock (passphrase verification).
   *
   * Platform routing:
   * - Web: → /api/consent/vault-owner-token → backend
   * - iOS/Android: → HushhConsent plugin → backend
   */
  static async issueVaultOwnerToken(
    userId: string,
    firebaseIdToken: string
  ): Promise<{
    token: string;
    expiresAt: number;
    scope: string;
  }> {
    if (Capacitor.isNativePlatform()) {
      // iOS/Android: Use native plugin
      console.log("[VaultService] Using native plugin for VAULT_OWNER token");
      return HushhConsent.issueVaultOwnerToken({
        userId,
        authToken: firebaseIdToken,
      });
    } else {
      // Web: Call Next.js API route
      console.log("[VaultService] Using web API for VAULT_OWNER token");
      return apiJson("/api/consent/vault-owner-token", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${firebaseIdToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId }),
      });
    }
  }

  /**
   * Check if a vault exists for the given user
   * Cached per session to avoid repeated API calls across page navigations.
   * iOS: Uses HushhVault native plugin
   * Web: Calls /api/vault/check (backed by bootstrap-state on the server)
   */
  static async checkVault(userId: string): Promise<boolean> {
    const cache = CacheService.getInstance();
    const cacheKey = CACHE_KEYS.VAULT_CHECK(userId);
    const cached = cache.get<boolean>(cacheKey);
    if (cached !== null && cached !== undefined) {
      return cached;
    }
    const sessionCached = this.readSessionVaultCheck(userId);
    if (sessionCached !== null) {
      cache.set(cacheKey, sessionCached);
      return sessionCached;
    }
    const bootstrapCached = this.readBootstrapVaultCheck(userId);
    if (bootstrapCached !== null) {
      cache.set(cacheKey, bootstrapCached);
      this.writeSessionVaultCheck(userId, bootstrapCached);
      return bootstrapCached;
    }
    const inflight = this.vaultCheckInflight.get(userId);
    if (inflight) {
      return inflight;
    }

    console.log("🔐 [VaultService] checkVault called for:", userId);

    const request = (async () => {
      let hasVault: boolean;

      if (Capacitor.isNativePlatform()) {
        console.log("🔐 [VaultService] Using native plugin for checkVault");
        try {
          const authToken = await this.getFirebaseToken();
          console.log(
            "🔐 [VaultService] Got auth token:",
            authToken ? "yes" : "no"
          );
          const result = await HushhVault.hasVault({ userId, authToken });
          console.log("🔐 [VaultService] hasVault result:", result);
          hasVault = result.exists;
        } catch (error) {
          console.error("❌ [VaultService] Native hasVault error:", error);
          throw error;
        }
      } else {
        // Web: use API route with Firebase auth
        console.log("🌐 [VaultService] Using API for checkVault");
        const url = this.getApiUrl(`/api/vault/check?userId=${userId}`);

        const authToken = await this.getFirebaseToken();
        const headers: HeadersInit = {};
        if (authToken) {
          headers["Authorization"] = `Bearer ${authToken}`;
        }

        try {
          const response = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(resolveSlowRequestTimeoutMs(20_000)),
          });
          if (!response.ok) {
            throw new Error(`Vault check failed: ${response.status}`);
          }
          const data = await response.json();
          hasVault = data.hasVault;
        } catch (error) {
          const fallbackHasVault = await this.resolveVaultCheckFallback(userId);
          if (fallbackHasVault === null) {
            console.error("❌ [VaultService] checkVault failed:", error);
            throw error;
          }
          console.warn(
            "⚠️ [VaultService] checkVault served via bootstrap-state fallback"
          );
          hasVault = fallbackHasVault;
        }
      }

      CacheSyncService.onVaultStateChanged(userId, { hasVault });
      this.writeSessionVaultCheck(userId, hasVault);
      return hasVault;
    })().finally(() => {
      if (this.vaultCheckInflight.get(userId) === request) {
        this.vaultCheckInflight.delete(userId);
      }
    });

    this.vaultCheckInflight.set(userId, request);
    return request;
  }

  /**
   * Set vault check cache to true (call after create or unlock so subsequent checks skip API).
   */
  static setVaultCheckCache(userId: string, exists: boolean): void {
    CacheSyncService.onVaultStateChanged(userId, { hasVault: exists });
    this.writeSessionVaultCheck(userId, exists);
  }

  /**
   * Get vault state (recovery + all enrolled wrappers).
   */
  static async getVaultState(userId: string): Promise<VaultState> {
    const cached = this.getCachedVaultState(userId);
    if (cached) {
      return cached;
    }

    const inFlight = this.vaultStateInflight.get(userId);
    if (inFlight) {
      return inFlight;
    }

    console.log("🔐 [VaultService] getVaultState called for:", userId);

    const requestPromise = (async () => {
      if (Capacitor.isNativePlatform()) {
        try {
          const authToken = await this.getFirebaseToken();
          const result = await HushhVault.getVault({ userId, authToken });
          const wrapperProbe = (result as { wrappers?: unknown }).wrappers;
          const extractedCount = this.extractWrappers(wrapperProbe).length;
          const wrapperShape = this.describeWrapperPayload(wrapperProbe);
          let hasVaultCheckResult: boolean | "error" | "unknown" = "unknown";
          if (!extractedCount) {
            try {
              hasVaultCheckResult = await this.checkVault(userId);
            } catch {
              hasVaultCheckResult = "error";
            }
            console.warn(
              "[VaultService] Native getVault returned wrapper payload with zero extractable wrappers",
              {
                wrapperType: wrapperProbe == null ? "nullish" : typeof wrapperProbe,
                wrapperShape,
                hasVault: hasVaultCheckResult,
              }
            );
          }
          try {
            const normalized = this.normalizeVaultState(result as Partial<VaultState>);
            this.setCachedVaultState(userId, normalized);
            return normalized;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Vault state normalization failed.";
            throw new Error(
              `${message} [platform=${Capacitor.getPlatform()} source=native wrapperShape=${wrapperShape} extracted=${extractedCount} hasVault=${hasVaultCheckResult}]`
            );
          }
        } catch (error) {
          console.error("❌ [VaultService] Native getVaultState error:", error);
          throw error;
        }
      }

      const url = this.getApiUrl(`/api/vault/get?userId=${userId}`);
      const authToken = await this.getFirebaseToken();
      const headers: HeadersInit = {};
      if (authToken) {
        headers["Authorization"] = `Bearer ${authToken}`;
      }

      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error("Failed to get vault");
      }
      const payload = (await response.json()) as Partial<VaultState>;
      const wrapperProbe = (payload as { wrappers?: unknown }).wrappers;
      const extractedCount = this.extractWrappers(wrapperProbe).length;
      const wrapperShape = this.describeWrapperPayload(wrapperProbe);
      let hasVaultCheckResult: boolean | "error" | "unknown" = "unknown";
      if (!extractedCount) {
        try {
          hasVaultCheckResult = await this.checkVault(userId);
        } catch {
          hasVaultCheckResult = "error";
        }
        console.warn("[VaultService] Web getVault payload has zero extractable wrappers", {
          wrapperShape,
          hasVault: hasVaultCheckResult,
        });
      }
      try {
        const normalized = this.normalizeVaultState(payload);
        this.setCachedVaultState(userId, normalized);
        this.writeSessionVaultCheck(userId, true);
        return normalized;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Vault state normalization failed.";
        throw new Error(
          `${message} [platform=web source=api wrapperShape=${wrapperShape} extracted=${extractedCount} hasVault=${hasVaultCheckResult}]`
        );
      }
    })();

    this.vaultStateInflight.set(userId, requestPromise);
    try {
      return await requestPromise;
    } finally {
      if (this.vaultStateInflight.get(userId) === requestPromise) {
        this.vaultStateInflight.delete(userId);
      }
    }
  }

  // Backward alias used by existing callers.
  static async getVault(userId: string): Promise<VaultState> {
    return this.getVaultState(userId);
  }

  /**
   * Create or replace full vault state (breaking contract v5.0).
   */
  static async setupVaultState(userId: string, vaultState: VaultState): Promise<void> {
    const normalized = this.normalizeVaultState(vaultState);
    this.assertVaultStateForSetup(normalized);

    if (Capacitor.isNativePlatform()) {
      try {
        const authToken = await this.getFirebaseToken();
        const result = await HushhVault.setupVault({
          userId,
          vaultKeyHash: normalized.vaultKeyHash,
          primaryMethod: normalized.primaryMethod,
          primaryWrapperId: normalized.primaryWrapperId ?? "default",
          recoveryEncryptedVaultKey: normalized.recoveryEncryptedVaultKey,
          recoverySalt: normalized.recoverySalt,
          recoveryIv: normalized.recoveryIv,
          wrappers: normalized.wrappers,
          authToken,
        });
        if (!result?.success) {
          throw new Error("Native vault setup failed.");
        }
        this.invalidateVaultStateCache(userId);
        CacheSyncService.onVaultStateChanged(userId, { hasVault: true });
        return;
      } catch (error) {
        console.error("❌ [VaultService] Native setupVaultState error:", error);
        throw error;
      }
    }

    const url = this.getApiUrl("/api/vault/setup");
    const authToken = await this.getFirebaseToken();
    const headers: HeadersInit = {
      "Content-Type": "application/json",
      "x-hushh-client-version": process.env.NEXT_PUBLIC_CLIENT_VERSION || "2.0.0",
    };
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        userId,
        vaultKeyHash: normalized.vaultKeyHash,
        primaryMethod: normalized.primaryMethod,
        primaryWrapperId: normalized.primaryWrapperId ?? "default",
        recoveryEncryptedVaultKey: normalized.recoveryEncryptedVaultKey,
        recoverySalt: normalized.recoverySalt,
        recoveryIv: normalized.recoveryIv,
        wrappers: normalized.wrappers,
      }),
    });
    if (!response.ok) {
      throw await this.buildApiError(response, "Failed to setup vault state.");
    }
    this.invalidateVaultStateCache(userId);
    CacheSyncService.onVaultStateChanged(userId, { hasVault: true });
  }

  static async upsertVaultWrapper(params: {
    userId: string;
    vaultKeyHash: string;
    wrapper: VaultWrapper;
  }): Promise<void> {
    const wrapper = this.normalizeWrapper(params.wrapper);
    if (!wrapper.encryptedVaultKey || !wrapper.salt || !wrapper.iv) {
      throw new Error("Wrapper fields are required.");
    }

    if (Capacitor.isNativePlatform()) {
      const authToken = await this.getFirebaseToken();
      const result = await HushhVault.upsertVaultWrapper({
        userId: params.userId,
        vaultKeyHash: params.vaultKeyHash,
        method: wrapper.method,
        wrapperId: wrapper.wrapperId ?? "default",
        encryptedVaultKey: wrapper.encryptedVaultKey,
        salt: wrapper.salt,
        iv: wrapper.iv,
        passkeyCredentialId: wrapper.passkeyCredentialId,
        passkeyPrfSalt: wrapper.passkeyPrfSalt,
        passkeyRpId: wrapper.passkeyRpId,
        passkeyProvider: wrapper.passkeyProvider,
        passkeyDeviceLabel: wrapper.passkeyDeviceLabel,
        passkeyLastUsedAt: wrapper.passkeyLastUsedAt,
        authToken,
      });
      if (!result?.success) {
        throw new Error("Native vault wrapper upsert failed.");
      }
      this.invalidateVaultStateCache(params.userId);
      return;
    }

    const url = this.getApiUrl("/api/vault/wrapper/upsert");
    const authToken = await this.getFirebaseToken();
    const headers: HeadersInit = {
      "Content-Type": "application/json",
      "x-hushh-client-version": process.env.NEXT_PUBLIC_CLIENT_VERSION || "2.0.0",
    };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        userId: params.userId,
        vaultKeyHash: params.vaultKeyHash,
        method: wrapper.method,
        wrapperId: wrapper.wrapperId ?? "default",
        encryptedVaultKey: wrapper.encryptedVaultKey,
        salt: wrapper.salt,
        iv: wrapper.iv,
        passkeyCredentialId: wrapper.passkeyCredentialId,
        passkeyPrfSalt: wrapper.passkeyPrfSalt,
        passkeyRpId: wrapper.passkeyRpId,
        passkeyProvider: wrapper.passkeyProvider,
        passkeyDeviceLabel: wrapper.passkeyDeviceLabel,
        passkeyLastUsedAt: wrapper.passkeyLastUsedAt,
      }),
    });
    if (!response.ok) {
      throw await this.buildApiError(response, "Failed to upsert vault wrapper.");
    }
    this.invalidateVaultStateCache(params.userId);
  }

  static async setPrimaryVaultMethod(
    userId: string,
    primaryMethod: VaultMethod,
    primaryWrapperId?: string
  ): Promise<void> {
    const normalizedMethod = this.normalizeMethod(primaryMethod);
    const normalizedWrapperId =
      this.normalizeNullableString(primaryWrapperId) ?? "default";

    if (Capacitor.isNativePlatform()) {
      const authToken = await this.getFirebaseToken();
      const result = await HushhVault.setPrimaryVaultMethod({
        userId,
        primaryMethod: normalizedMethod,
        primaryWrapperId: normalizedWrapperId,
        authToken,
      });
      if (!result?.success) {
        throw new Error("Native primary vault method update failed.");
      }
      this.invalidateVaultStateCache(userId);
      return;
    }

    const url = this.getApiUrl("/api/vault/primary/set");
    const authToken = await this.getFirebaseToken();
    const headers: HeadersInit = {
      "Content-Type": "application/json",
      "x-hushh-client-version": process.env.NEXT_PUBLIC_CLIENT_VERSION || "2.0.0",
    };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        userId,
        primaryMethod: normalizedMethod,
        primaryWrapperId: normalizedWrapperId,
      }),
    });
    if (!response.ok) {
      throw await this.buildApiError(
        response,
        "Failed to set primary vault method."
      );
    }
    this.invalidateVaultStateCache(userId);
  }

  // ============================================================================
  // CRYPTOGRAPHY ABSTRACTION (Native vs Web)
  // ============================================================================

  /**
   * Create a new Vault (Generate Key + Encrypt)
   */
  static async createVault(passphrase: string) {
    // Currently using Web Logic for creation as it works efficiently in WebView
    return webCreateVault(passphrase);
  }

  /**
   * Unlock Vault (Decrypt Key)
   */
  static async unlockVault(
    passphrase: string,
    encryptedKey: string,
    salt: string,
    iv: string
  ): Promise<string> {
    // Always use the web-crypto unlock path for deterministic cross-platform
    // vault-key decoding (native plugin decrypt is UTF-8 text-oriented).
    const decrypted = await webUnlockVault(passphrase, encryptedKey, salt, iv);
    const normalized = this.normalizeVaultKeyHex(decrypted);
    if (!normalized) {
      if (!decrypted) return "";
      throw new Error("Vault key format is invalid after passphrase unlock.");
    }
    return normalized;
  }

  static async unlockVaultWithRecoveryKey(
    key: string,
    encryptedKey: string,
    salt: string,
    iv: string
  ): Promise<string> {
    const decrypted = await webUnlockRecall(key, encryptedKey, salt, iv);
    const normalized = this.normalizeVaultKeyHex(decrypted);
    if (!normalized) {
      if (!decrypted) return "";
      throw new Error("Vault key format is invalid after recovery unlock.");
    }
    return normalized;
  }

  static async canUseGeneratedDefaultVault(): Promise<GeneratedVaultSupport> {
    const { VaultBootstrapService } = await import(
      "@/lib/services/vault-bootstrap-service"
    );
    return VaultBootstrapService.canUseGeneratedDefaultVault();
  }

  static async provisionGeneratedDefaultVault(params: {
    userId: string;
    displayName: string;
  }): Promise<GeneratedVaultProvisionResult> {
    const { VaultBootstrapService } = await import(
      "@/lib/services/vault-bootstrap-service"
    );
    return VaultBootstrapService.provisionGeneratedDefaultVault(params);
  }

  static async unlockGeneratedDefaultVault(
    input: GeneratedVaultUnlockInput
  ): Promise<string | null> {
    const { VaultBootstrapService } = await import(
      "@/lib/services/vault-bootstrap-service"
    );
    const decrypted = await VaultBootstrapService.unlockGeneratedDefaultVault(input);
    if (!decrypted) return null;
    const normalized = this.normalizeVaultKeyHex(decrypted);
    if (!normalized) {
      throw new Error("Vault key format is invalid for generated unlock.");
    }
    return normalized;
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  /**
   * Get Firebase ID token for authentication
   */
  private static async getFirebaseToken(): Promise<string | undefined> {
    try {
      // Check Firebase JS SDK first (consistent across all platforms)
      const user = auth.currentUser;
      if (user) {
        return await user.getIdToken();
      }

      // Fallback to native plugin if on native platform
      if (Capacitor.isNativePlatform()) {
        const result = await HushhAuth.getIdToken();
        return result.idToken || undefined;
      }
    } catch (e) {
      console.warn("[VaultService] Failed to get Firebase token:", e);
    }
    return undefined;
  }

  private static getApiUrl(path: string): string {
    // Always same-origin for web; native branches return early via plugins.
    return path;
  }
}
