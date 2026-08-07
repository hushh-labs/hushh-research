# Mobile Plugin Contracts

## Visual Context

Canonical visual owner: [Mobile Guide](../mobile.md).

## Plugin Inventory

All mobile security or backend-sensitive behavior must run through platform-aware services and Capacitor plugins.

| Plugin | jsName | Purpose |
| --- | --- | --- |
| `HushhAuth` | `HushhAuth` | Google/Apple sign-in and Firebase token access |
| `HushhVault` | `HushhVault` | vault setup, wrappers, encrypted preference reads/writes |
| `HushhConsent` | `HushhConsent` | consent tokens, pending/active/history, TrustLink |
| `Kai` | `Kai` | Kai analysis and decision history |
| `HushhSync` | `HushhSync` | local/cloud synchronization |
| `HushhSettings` | `HushhSettings` | app preferences and cloud sync state |
| `HushhKeystore` | `HushhKeychain` | secure item storage; jsName retained for compatibility |
| `PersonalKnowledgeModel` | `PersonalKnowledgeModel` | PKM metadata, attributes, domains, scopes |
| `HushhAccount` | `HushhAccount` | account lifecycle actions |
| `HushhNotifications` | `HushhNotifications` | push token registration |
| `HushhLocation` | `HushhLocation` | foreground location capture |

## Registration Rule

Every plugin must be registered on both iOS and Android before TypeScript calls it on native platforms.

Key files:

- `hushh-webapp/ios/App/App/MyViewController.swift`
- `hushh-webapp/android/app/src/main/java/com/hussh/app/MainActivity.kt`
- `hushh-webapp/lib/capacitor/index.ts`
- `hushh-webapp/lib/capacitor/types.ts`

When adding iOS source files manually, Xcode project IDs must be exactly 24 hexadecimal characters. Prefer adding files through Xcode so it generates valid IDs.

## Platform-Aware Service Pattern

Components should call service-layer methods, not plugins or `fetch()` directly.

```typescript
import { Capacitor } from "@capacitor/core";

export async function getVaultState(userId: string) {
  if (Capacitor.isNativePlatform()) {
    const { HushhVault } = await import("@/lib/capacitor");
    return HushhVault.getVault({ userId });
  }

  return apiFetch(`/api/vault/get?userId=${encodeURIComponent(userId)}`);
}
```

## Native JSON Shape Rule

Native plugins call the Python backend directly and receive `snake_case` JSON. Service methods must normalize values before returning them to React callers.

Plugins with known normalization needs:

- `PersonalKnowledgeModel`
- `Kai`
- identity/native profile helpers

Vault and consent token methods usually return simple values, but callers still need typed wrappers and explicit error mapping.

## Token Rule

When a component calls a service that requires `vaultOwnerToken`, pass it explicitly. Do not rely on session storage fallback on native platforms.

```typescript
await PersonalKnowledgeModelService.storeDomainData({
  userId,
  domain: "financial",
  encryptedBlob,
  summary,
  vaultOwnerToken,
});
```

## Endpoint Rule

Every Next.js `/api` route that needs to work on iOS or Android must have a corresponding native plugin path or an explicit mobile non-support decision in route governance.
