# New Feature Development Checklist


## Visual Context

Canonical visual owner: [Guides Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

Use this checklist for EVERY new feature that involves data operations.

## Before You Start

- [ ] Read `docs/project_context_map.md` Section "CRITICAL RULES"
- [ ] Understand tri-flow architecture (Web + iOS + Android)

## Backend (Python)

- [ ] Create endpoint in `consent-protocol/api/routes/{domain}.py`
- [ ] Add VAULT_OWNER token validation
- [ ] Test endpoint with curl/Postman
- [ ] Document in `docs/reference/architecture/api-contracts.md`

## Web Proxy (Next.js)

- [ ] Create proxy route: `hushh-webapp/app/api/{feature}/route.ts`
- [ ] Import `getPythonApiUrl()` helper
- [ ] Forward to Python backend endpoint
- [ ] Handle errors and return proper status codes

## iOS Native Plugin

- [ ] Create/update Swift plugin: `ios/App/App/Plugins/Hushh{Feature}Plugin.swift`
- [ ] Add `@objc` method matching service layer
- [ ] Call Python backend directly (bypass Next.js)
- [ ] Use same endpoint as web proxy calls
- [ ] Handle errors and return proper response format

### Adding new Swift files to the Xcode project

If you add a new `.swift` file (e.g. a new plugin or helper) and need to edit `ios/App/App.xcodeproj/project.pbxproj` manually:

- **Xcode project IDs must be exactly 24 hexadecimal characters** (digits `0-9` and letters `A-F` only).
- Each new file needs two IDs: one for the file reference (`PBXFileReference`) and one for the build file (`PBXBuildFile` in the Sources phase).
- Using any other character (e.g. `G`, `W`, `M`, `P`, `L`, `U`) causes Xcode errors such as **"invalid hex digit"** and will break the build.
- Generate or copy 24-char hex IDs from existing entries in `project.pbxproj` when adding new entries.

## Android Native Plugin

- [ ] Create/update Kotlin plugin: `android/.../plugins/Hushh{Feature}/Hushh{Feature}Plugin.kt`
- [ ] Add `@PluginMethod` matching service layer
- [ ] Call Python backend directly (bypass Next.js)
- [ ] Use same endpoint as web proxy calls
- [ ] Handle errors and return proper response format

## TypeScript Interfaces

- [ ] Add method signature to `lib/capacitor/index.ts`
- [ ] Match plugin method names exactly (case-sensitive!)
- [ ] Document parameters and return types

## Native Plugin Registration

**Required:** Every native plugin must be registered with the Capacitor bridge. If a plugin is not registered, TypeScript calls will fail at runtime on native platforms.

### iOS

- [ ] Register plugin in `hushh-webapp/ios/App/App/MyViewController.swift`
- [ ] In `capacitorDidLoad()`, add: `bridge?.registerPluginInstance(YourPlugin())`
- [ ] Add the plugin's `jsName` to the `verifyPluginRegistration()` array (for debugging)

### Android

- [ ] Register plugin in `hushh-webapp/android/app/src/main/java/com/hushh/app/MainActivity.kt`
- [ ] In `onCreate()` (before `super.onCreate()`), add: `registerPlugin(YourPlugin::class.java)`

## Service Layer

- [ ] Create/update service: `lib/services/{feature}-service.ts`
- [ ] Import Capacitor: `import { Capacitor } from '@capacitor/core'`
- [ ] Implement platform detection:
  ```typescript
  if (Capacitor.isNativePlatform()) {
    // Call native plugin
    return await HushhPlugin.method();
  }
  // Call Next.js proxy
  return fetch("/api/...");
  ```
- [ ] Transform snake_case responses from native plugins to camelCase
- [ ] Use fallback pattern: `result.camelCase || result.snake_case || default`
- [ ] Handle errors consistently across platforms

## UI Components

- [ ] Import service: `import { FeatureService } from '@/lib/services/feature-service'`
- [ ] Use service methods only (NO direct fetch())
- [ ] Handle loading states
- [ ] Handle error states
- [ ] Show success feedback only after confirmed save

## Testing

- [ ] Test on web (`make local` or `make local-web`)
- [ ] Test on iOS simulator (if available)
- [ ] Test on Android emulator
- [ ] Verify data persists after refresh
- [ ] Check for console errors on all platforms

## Documentation

- [ ] Add route to `hushh-webapp/route-contracts.json`
- [ ] Update `docs/reference/architecture/api-contracts.md` if needed
- [ ] Add JSDoc comments to service methods
- [ ] Add/update PR impact map using `docs/reference/quality/pr-impact-checklist.md`

## Common Mistakes to Avoid

❌ **Calling fetch() in components**
```typescript
// WRONG
const response = await fetch("/api/vault/food", { ... });
```

❌ **Service without platform detection**
```typescript
// WRONG: Always calls Next.js
static async getData() {
  return fetch("/api/...");  // Breaks on native
}
```

❌ **Missing native plugins**
- Creating `app/api/feature/route.ts` without corresponding iOS/Android plugins

❌ **Missing vaultOwnerToken prop**
```typescript
// WRONG: Component doesn't pass vaultOwnerToken
<PortfolioReviewView
  userId={userId}
  vaultKey={vaultKey}
  // Missing vaultOwnerToken - fails on native!
/>

// CORRECT: Always pass vaultOwnerToken
<PortfolioReviewView
  userId={userId}
  vaultKey={vaultKey}
  vaultOwnerToken={vaultOwnerToken}
/>
```

❌ **Stream closes before final event**
```typescript
// WRONG: Closes immediately
.then(() => {
  listener.remove();
  controller.close(); // Final event may be lost!
})

// CORRECT: Wait for events to process
.then(() => {
  setTimeout(() => {
    listener.remove();
    controller.close();
  }, 100);
})
```

❌ **Spinner during extraction**
```typescript
// WRONG: Spinner shows during extraction
isStreaming={stage === "extracting" || stage === "streaming"}

// CORRECT: Spinner only during initial stages
isStreaming={stage === "uploading" || stage === "analyzing" || stage === "thinking"}
```

✅ **Correct implementation**
```typescript
// Component
import { ApiService } from '@/lib/services/api-service';
const response = await ApiService.getData();

// Service
static async getData() {
  if (Capacitor.isNativePlatform()) {
    return await HushhVault.getData();  // Native
  }
  return fetch("/api/...");  // Web
}
```

## snake_case Transformation Checklist

When implementing service methods that call native plugins:

- [ ] Native plugins return raw backend JSON (snake_case)
- [ ] Service layer transforms to camelCase for React components
- [ ] Use fallback pattern to support both formats during transition
- [ ] Test on both web AND native platforms

### Example Transformation

```typescript
// WRONG - assumes native returns camelCase
const result = await Plugin.getData();
return { userId: result.userId };  // undefined on native!

// CORRECT - handles both formats
const result = await Plugin.getData();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const raw = result as any;
return {
  userId: raw.user_id || raw.userId,
  displayName: raw.display_name || raw.displayName,
};
```

## Verification

Before marking feature as complete:

- [ ] All 5 layers implemented (Backend, Web Proxy, iOS, Android, Service)
- [ ] Tested on web browser
- [ ] Tested on Android emulator
- [ ] Tested on iOS simulator (if available)
- [ ] No `fetch()` calls in components
- [ ] Documentation updated
- [ ] PR impact checklist sections completed
- [ ] If AI-assisted: commit message includes `Signed-off-by` and `Tokens used` (when available); see [Contributing](../../contributing.md)

## Platform-Specific Features

Not all features require all three platform implementations. Some features are
intentionally platform-specific:

### Web-Only Plugins

| Plugin | Reason | Web Implementation |
|--------|--------|-------------------|
| `HushhDatabase` | Uses IndexedDB for client-side storage | `lib/capacitor/plugins/database-web.ts` |

For web-only plugins:
- Native apps use alternative storage (e.g., `HushhVault` with SQLCipher)
- Document the limitation in the plugin file
- Service layer should gracefully handle missing native implementation

### Native-Only Features

| Plugin | Reason | Native Implementation |
|--------|--------|----------------------|
| `HushhAgent` | On-device ML inference requires native APIs | iOS: `HushhAgentPlugin.swift`, Android: `HushhAgentPlugin.kt` |

For native-only features:
- Web implementation should be a stub that returns appropriate fallback
- Document clearly that feature is not available on web
- Consider showing UI message when feature is unavailable

### Implementation Pattern for Platform-Specific Features

```typescript
// Service for native-only feature
static async runLocalInference(input: string): Promise<Result> {
  if (Capacitor.isNativePlatform()) {
    return await HushhAgent.inference({ input });
  }
  
  // Web fallback - feature not available
  console.warn("Local inference is only available on native platforms");
  return {
    available: false,
    message: "This feature requires the mobile app"
  };
}
```

## BYOK Security Checklist

For features that handle vault data:

- [ ] Encryption keys are NEVER sent to the backend
- [ ] Use `useVault().getVaultKey()` for key access (not localStorage/sessionStorage)
- [ ] Backend stores only ciphertext
- [ ] Decryption happens client-side only
- [ ] Tests use dynamically generated keys (see [`TESTING.md`](../../TESTING.md))

## Streaming Features

For features that use Server-Sent Events (SSE) streaming:

- [ ] Native plugin implements streaming method (emits events via `notifyListeners`)
- [ ] ApiService creates ReadableStream fed by plugin events
- [ ] Component processes buffer after `done=true` to catch final events
- [ ] Stream closes with delay to ensure all events are processed
- [ ] Loading state (spinner) stops at correct stage (not during extraction)
- [ ] See [Native Streaming Guide](./native_streaming.md) for detailed patterns

## See Also

- [Project Context Map](../project_context_map.md) - Tri-flow architecture rules
- [Component README](../../hushh-webapp/components/README.md) - Component guidelines
- [API Contracts](../reference/architecture/api-contracts.md) - Endpoint documentation
- [Route Contracts](../reference/architecture/route-contracts.md) - Next.js route governance
- [Architecture](../reference/architecture/architecture.md) - System design
- [PR Impact Checklist](../reference/quality/pr-impact-checklist.md) - Required PR mapping
- [Native Streaming Guide](./native_streaming.md) - SSE streaming patterns
- [Testing Guide](../../TESTING.md) - BYOK-compliant testing
- [Security Policy](../../SECURITY.md) - Security guidelines
