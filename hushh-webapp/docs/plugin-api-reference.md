# Native Plugin API Reference

> **IMPORTANT**: All implementations (TypeScript, Android, iOS) MUST use identical parameter names.  
> This document is the **single source of truth** for native plugin APIs.


## Visual Context

Canonical visual owner: [Hushh Webapp Docs](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

When modifying any native plugin:
1. Update this document FIRST
2. Implement in Android (`*.kt`)
3. Implement in iOS (`*.swift`)
4. Verify TypeScript interface matches (`lib/capacitor/`)

---

## HushhAuth

Google Sign-In authentication plugin.

### signIn
No parameters required.

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| idToken | string | Firebase ID token |
| accessToken | string | Google access token |
| user | AuthUser | User profile object |

### signOut
No parameters required.

### getIdToken
No parameters required.

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| idToken | string \| null | Cached Firebase ID token |

### getCurrentUser
No parameters required.

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| user | AuthUser \| null | Current user or null |

### isSignedIn
No parameters required.

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| signedIn | boolean | Whether user is signed in |

---

## HushhVault

Encryption and vault storage plugin.

### deriveKey
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| passphrase | string | Yes | User passphrase |
| salt | string | Yes | Base64 salt |
| iterations | number | No | PBKDF2 iterations (default: 100000) |

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| keyHex | string | Hex-encoded derived key |

### encryptData
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| plaintext | string | Yes | Data to encrypt |
| keyHex | string | Yes | Hex-encoded encryption key |

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| ciphertext | string | Base64-encoded ciphertext |
| iv | string | Base64-encoded initialization vector |
| tag | string | Base64-encoded auth tag |

### decryptData
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| keyHex | string | Yes | Hex-encoded decryption key |
| payload | object | Yes | Encrypted payload object |
| payload.ciphertext | string | Yes | Base64-encoded ciphertext |
| payload.iv | string | Yes | Base64-encoded IV |
| payload.tag | string | Yes | Base64-encoded auth tag |

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| plaintext | string | Decrypted data |

### hasVault
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| userId | string | Yes | User ID |
| authToken | string | No | Firebase ID token |

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| exists | boolean | Whether vault exists |

### getVault
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| userId | string | Yes | User ID |
| authToken | string | No | Firebase ID token |

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| authMethod | string | Authentication method used |
| encryptedVaultKey | string | Encrypted vault key |
| salt | string | Salt for key derivation |
| iv | string | Initialization vector |
| recoveryEncryptedVaultKey | string | Recovery encrypted key |
| recoverySalt | string | Recovery salt |
| recoveryIv | string | Recovery IV |

### setupVault
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| userId | string | Yes | User ID |
| authMethod | string | No | Auth method (default: "password") |
| encryptedVaultKey | string | Yes | Encrypted vault key |
| salt | string | Yes | Salt |
| iv | string | Yes | IV |
| recoveryEncryptedVaultKey | string | Yes | Recovery encrypted key |
| recoverySalt | string | Yes | Recovery salt |
| recoveryIv | string | Yes | Recovery IV |
| authToken | string | No | Firebase ID token |

### isPasskeyAvailable
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| rpId | string | No | Passkey relying-party ID |

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| available | boolean | Whether native passkey PRF can be attempted on this device |
| reason | string | Optional machine-readable reason when unavailable |

### registerPasskeyPrf
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| userId | string | Yes | User ID |
| displayName | string | Yes | User display name |
| rpId | string | Yes | Passkey relying-party ID |

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| credentialId | string | Base64 credential ID |
| prfSalt | string | Base64 HKDF salt |
| vaultKeyHex | string | Hex-encoded PRF-derived vault key |

### authenticatePasskeyPrf
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| userId | string | Yes | User ID |
| rpId | string | Yes | Passkey relying-party ID |
| credentialId | string | No | Base64 credential ID hint |
| prfSalt | string | Yes | Base64 HKDF salt saved at registration time |

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| credentialId | string | Base64 credential ID used to authenticate |
| vaultKeyHex | string | Hex-encoded PRF-derived vault key |

### storePreferencesToCloud
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| userId | string | Yes | User ID |
| domain | string | Yes | Preference domain |
| fieldName | string | Yes | Encrypted field name within the domain |
| ciphertext | string | Yes | Base64 ciphertext |
| iv | string | Yes | Base64 IV |
| tag | string | Yes | Base64 auth tag |
| consentToken | string | Yes | VAULT_OWNER or approved consent token |
| authToken | string | No | Firebase ID token |

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| success | boolean | Whether the encrypted preference field was stored |

### storePreference / getPreferences / deletePreferences

Legacy compatibility-only local preference surfaces. Route-facing product flows must use `storePreferencesToCloud()` and other cloud-backed preference paths instead of depending on local-only CRUD parity.

---

## HushhConsent

Consent token management plugin.

### issueToken
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| userId | string | Yes | User ID |
| agentId | string | Yes | Agent requesting consent |
| scope | string | Yes | Consent scope |
| expiresIn | number | No | Expiry in seconds |

### validateToken
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| token | string | Yes | Token to validate |
| expectedScope | string | No | Expected scope |

### revokeToken
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| token | string | Yes | Token to revoke |

### issueVaultOwnerToken
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| userId | string | Yes | User ID |
| authToken | string | Yes | Firebase ID token |

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| token | string | VAULT_OWNER consent token |
| expiresAt | number | Expiry timestamp |
| scope | string | Token scope |

---

## Kai

Agent Kai stock analysis plugin.

### grantConsent
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| userId | string | Yes | User ID |
| scopes | string[] | Yes | Consent scopes |
| authToken | string | No | Firebase ID token |

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| token | string | Kai consent token |
| expires_at | string | Expiry timestamp |

### analyze
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| ticker | string | Yes | Stock ticker symbol |
| userId | string | Yes | User ID |
| authToken | string | Yes | Firebase ID token |
| consentToken | string | No | Kai consent token |
| riskProfile | string | No | User's risk profile |
| processingMode | string | No | Analysis mode |
| investorContext | string | No | Investor context JSON |

**Returns:** Full analysis response object.

Kai no longer exposes plugin methods for `/api/kai/preferences/*`.
Optional onboarding profile data is stored in encrypted PKM path `financial.profile`.

---

## HushhKeychain (iOS) / HushhKeystore (Android)

Secure key storage plugin.

> **Note:** jsName is `HushhKeychain` on both platforms for consistency.

### set
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| key | string | Yes | Storage key |
| value | string | Yes | Value to store |

### get
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| key | string | Yes | Storage key |

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| value | string \| null | Retrieved value |

### delete
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| key | string | Yes | Storage key |

### isBiometricAvailable
No parameters required.

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| available | boolean | Whether biometrics available |
| type | string | "faceId", "touchId", or "none" |

---

## HushhSync

Data synchronization plugin.

### sync
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| authToken | string | No | Firebase ID token |

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| success | boolean | Whether sync succeeded |
| pushedRecords | number | Records pushed |
| pulledRecords | number | Records pulled |
| conflicts | number | Conflicts encountered |
| timestamp | number | Sync timestamp |

### push
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| authToken | string | No | Firebase ID token |

### pull
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| authToken | string | No | Firebase ID token |

### getSyncStatus
No parameters required.

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| pendingCount | number | Pending changes |
| lastSyncTimestamp | number | Last sync time |
| hasPendingChanges | boolean | Whether changes pending |

---

## HushhSettings

Application settings plugin.

### getSettings
No parameters required.

**Returns:** Full `HushhSettingsData` object.

### updateSettings
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (partial settings) | object | Yes | Settings to update |

### resetSettings
No parameters required.

### shouldUseLocalAgents
No parameters required.

### shouldSyncToCloud
No parameters required.

---

## Implementation Checklist

When implementing or modifying a native plugin method:

- [ ] Parameter names match this document EXACTLY
- [ ] Return field names match this document EXACTLY
- [ ] HTTP status codes are validated (200-299 range)
- [ ] Debug logging shows received parameter keys
- [ ] Error messages include missing parameter names
- [ ] TypeScript interface updated if API changed
- [ ] Android implementation tested
- [ ] iOS implementation tested
