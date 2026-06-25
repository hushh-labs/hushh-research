# Vault Encryption Explained

This guide explains how Hussh's vault encryption works, from key derivation to decryption during agent access. Understanding these concepts will help you debug encryption issues and make informed decisions about data security.

## Visual Context

This guide inherits its layout and security model from the [Documentation Architecture Map](../reference/operations/documentation-architecture-map.md) and [IAM Architecture](../reference/iam/architecture.md).

## Key Flow

```text
Passphrase -> PBKDF2 key derivation -> AES-256-GCM encrypt/decrypt
          -> Ciphertext persisted in vault boundary
          -> Consent + scoped access controls gate runtime access
```

## Quick Overview

```
User's Passphrase
       ↓
  [Key Derivation - PBKDF2]
       ↓
   Encryption Key (256-bit)
       ↓
  [AES-256-GCM Encryption]
       ↓
   Ciphertext + IV + Auth Tag
       ↓
  [Store in Backend]
  (Only ciphertext is stored, key never leaves client)
```

---

## Part 1: How BYOK (Bring Your Own Key) Works

### The Zero-Knowledge Principle

In Hussh, **you hold the encryption key boundary**:

```
┌─────────────────────────────────────┐
│         YOUR DEVICE (Client)         │
│                                       │
│  ✓ Passphrase                       │
│  ✓ Encryption Key (derived)         │
│  ✓ Plaintext Data (temporary)       │
│                                       │
└─────────────────────────────────────┘
           ↓ Upload Encrypted ↓
┌─────────────────────────────────────┐
│      HUSSH BACKEND (Server)          │
│                                       │
│  ✓ Ciphertext (encrypted blob)      │
│  ✓ Metadata (schema info)           │
│  ✗ Your Passphrase (never sent)     │
│  ✗ Your Encryption Key (never sent) │
│  ✗ Your Plaintext Data (encrypted)  │
│                                       │
└─────────────────────────────────────┘
```

**Key Property**: The backend cannot decrypt your data because it never receives your encryption key. If Hussh is breached, your encrypted vault remains secure.

---

## Part 2: Key Derivation from Passphrase

### Step 1: User Sets a Passphrase

When you create a Hussh account:

```typescript
// User enters passphrase (e.g., "MySecurePassphrase123!")
const userPassphrase = "MySecurePassphrase123!";

// Client generates a random salt (never sent to server)
const salt = crypto.getRandomValues(new Uint8Array(32));

// Derive encryption key using PBKDF2
const encryptionKey = await deriveKeyFromPassphrase(
  userPassphrase,
  salt
);
// Result: 256-bit AES key suitable for encryption
```

### Step 2: PBKDF2 Key Derivation

**PBKDF2 (Password-Based Key Derivation Function 2)**:

```
Pseudocode:
┌────────────────────────────────────────────┐
│ PBKDF2-SHA256(                             │
│   password   = user's passphrase,          │
│   salt       = 32 random bytes,            │
│   iterations = 100,000+,                   │
│   keyLength  = 32 bytes (256 bits)         │
│ )                                          │
└────────────────────────────────────────────┘
```

**Why 100,000+ iterations?**
- **Security**: Makes brute-force attacks infeasible
- **Speed**: Still fast enough (~100ms on modern devices)
- **Time Cost**: Attacker needs 100,000+ hash computations per password guess

**TypeScript Implementation**:

```typescript
async function deriveKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = 100_000
): Promise<CryptoKey> {
  // Step 1: Convert passphrase string to bytes
  const passphraseBuffer = new TextEncoder().encode(passphrase);

  // Step 2: Import passphrase as a PBKDF2 key
  const passphraseKey = await crypto.subtle.importKey(
    'raw',
    passphraseBuffer,
    'PBKDF2',
    false, // not extractable
    ['deriveBits', 'deriveKey']
  );

  // Step 3: Derive encryption key
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: salt,
      iterations: iterations
    },
    passphraseKey,
    { name: 'AES-GCM', length: 256 },
    true, // extractable for export if needed
    ['encrypt', 'decrypt']
  );
}
```

### Why This Matters

```
Weak Passphrase:      "123456"
├─ Derivation: 100,000 iterations
├─ Time to crack:    2 seconds (dictionary attack)
└─ Attacker gain:    Full vault access

Strong Passphrase:    "Tr0p1cal$Sunset#42!"
├─ Derivation: 100,000 iterations
├─ Time to crack:    10^12 years (with brute force)
└─ Attacker gain:    Nothing feasible
```

---

## Part 3: Encryption at Rest (AES-256-GCM)

### What is AES-256-GCM?

- **AES**: Advanced Encryption Standard (industry standard)
- **256**: 256-bit key length (extremely secure)
- **GCM**: Galois/Counter Mode (provides authentication)

### The Encryption Flow

```typescript
async function encryptVaultData(
  plaintext: Record<string, unknown>,
  encryptionKey: CryptoKey
): Promise<{ ciphertext: string; iv: string; tag: string }> {
  // Step 1: Generate random IV (Initialization Vector)
  // IV ensures same plaintext produces different ciphertext
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Step 2: Convert plaintext to JSON bytes
  const plaintextBuffer = new TextEncoder().encode(
    JSON.stringify(plaintext)
  );

  // Step 3: Encrypt with AES-256-GCM
  // GCM mode also produces an authentication tag
  const encryptedBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv // Unique for each encryption
    },
    encryptionKey,
    plaintextBuffer
  );

  // Step 4: Extract authentication tag (last 16 bytes)
  const ciphertext = encryptedBuffer.slice(0, -16);
  const tag = encryptedBuffer.slice(-16);

  return {
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
    iv: btoa(String.fromCharCode(...new Uint8Array(iv))),
    tag: btoa(String.fromCharCode(...new Uint8Array(tag)))
  };
}
```

### Why Random IV?

```
Same passphrase, same key, different IVs:

Plaintext: { "password": "secret123" }

Encryption 1 (IV=random₁):  → Ciphertext₁
Encryption 2 (IV=random₂):  → Ciphertext₂

Even though ciphertext₁ ≠ ciphertext₂,
both decrypt to the same plaintext.

Benefit: Prevents attackers from pattern-matching
encrypted values across vault snapshots.
```

### Why GCM Mode (Authentication)?

GCM provides **authenticated encryption**:

```
Attacker Scenario:

┌─────────────────────────────────────┐
│  Attacker intercepts ciphertext:    │
│  {                                   │
│    "holdings": "AAPL,100"           │
│  }                                   │
│                                       │
│  Attacker flips some bits:          │
│  holdings": "AAPL,999"  ← CHANGED   │
└─────────────────────────────────────┘
          ↓ Sent to server
┌─────────────────────────────────────┐
│  Backend attempts decryption:       │
│                                       │
│  AES-GCM detects tampering!         │
│  Authentication tag fails            │
│  Decryption aborted with error       │
│                                       │
│  Result: Attack blocked ✓            │
└─────────────────────────────────────┘
```

---

## Part 4: Backend Storage

### What Hussh Stores

After encryption, the backend stores:

```sql
-- hussh_vaults table
CREATE TABLE vaults (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  ciphertext TEXT NOT NULL,           -- ✓ Encrypted data
  iv TEXT NOT NULL,                   -- ✓ Random IV (safe to store)
  tag TEXT NOT NULL,                  -- ✓ Auth tag (safe to store)
  schema_version INT DEFAULT 1,       -- ✓ Metadata (unencrypted)
  created_at TIMESTAMP DEFAULT NOW(), -- ✓ Metadata
  updated_at TIMESTAMP DEFAULT NOW()  -- ✓ Metadata
);
```

**Never Stored**:
- ✗ User's passphrase
- ✗ User's encryption key
- ✗ Plaintext vault data
- ✗ Decrypted secrets

---

## Part 5: Decryption During Agent Access

### Scenario: Agent Requests Vault Data

```
┌──────────────────────────────────────────┐
│  Step 1: User grants consent             │
│  → Consent token issued to agent        │
│  → Token scopes: ["attr.portfolio.*"]    │
└──────────────────────────────────────────┘
           ↓
┌──────────────────────────────────────────┐
│  Step 2: Agent calls /api/vault          │
│  → Sends consent token                   │
│  → Requests: { vault_path: "attr.portfolio.holdings" }
└──────────────────────────────────────────┘
           ↓
┌──────────────────────────────────────────┐
│  Step 3: Backend processes request       │
│  1. Validate consent token               │
│     → Check if "attr.portfolio.*" is in scopes
│  2. If NOT user's own request:           │
│     → Decrypt vault with SERVICE KEY     │
│     → Agent never sees encryption key    │
│  3. Extract scoped data                  │
│  4. Return only authorized fields        │
└──────────────────────────────────────────┘
           ↓
┌──────────────────────────────────────────┐
│  Step 4: Agent receives scoped data      │
│  { "holdings": [{"ticker": "AAPL", ...}] }
│  ✗ Cannot see other vault sections       │
└──────────────────────────────────────────┘
```

### Key Points

1. **User's Client Decrypts**:
   - User unlocks vault on their device
   - Client has encryption key in memory
   - Plaintext only exists on user's device

2. **Agent Access Uses Service Key**:
   - Backend decrypts using a separate service encryption key
   - Service key is rotate-only, never exposed to agents
   - Agents never receive encryption keys

3. **Consent Enforcement**:
   - Agent can only access scopes in consent token
   - Backend enforces scoped decryption
   - Consent can be revoked at any time

---

## Part 6: Troubleshooting Common Errors

### Error: "Decryption failed: invalid key"

**Causes**:
1. Wrong passphrase entered
2. Vault was encrypted with different key
3. Corruption in stored ciphertext/IV

**Debug**:

```typescript
// Check 1: Verify IV and tag integrity
const vaultBlob = await api.get(`/vaults/${vaultId}`);
console.log({
  has_iv: !!vaultBlob.iv,
  has_tag: !!vaultBlob.tag,
  has_ciphertext: !!vaultBlob.ciphertext,
  iv_length: vaultBlob.iv.length,     // Should be 16 (base64)
  tag_length: vaultBlob.tag.length    // Should be 24 (base64)
});

// Check 2: Verify key derivation
const key1 = await deriveKeyFromPassphrase(passphrase, salt);
const key2 = await deriveKeyFromPassphrase(passphrase, salt);
// key1 and key2 should be identical

// Check 3: Try a known plaintext
try {
  const decrypted = await decryptVaultData(
    vaultBlob.ciphertext,
    vaultBlob.iv,
    vaultBlob.tag,
    key1
  );
  console.log('Decryption succeeded:', decrypted);
} catch (error) {
  console.error('Decryption failed:', error.message);
}
```

**Solutions**:
- Verify passphrase is correct
- Reset vault if lost (creates new encryption)
- Contact support if data corruption suspected

### Error: "Authentication tag verification failed"

**Causes**:
1. Ciphertext was modified in transit/storage
2. IV or tag doesn't match ciphertext
3. Encryption key is wrong

**Debug**:

```typescript
// Verify tag integrity
const { ciphertext, iv, tag } = vaultBlob;
try {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv) },
    encryptionKey,
    combineWithTag(base64ToBytes(ciphertext), base64ToBytes(tag))
  );
  console.log('Authentication successful');
} catch (error) {
  if (error.name === 'OperationError') {
    console.error('Authentication tag failed - data corrupted or wrong key');
  }
}
```

### Error: "Key derivation timeout"

**Causes**:
1. Too many PBKDF2 iterations (>500,000)
2. Device performance issue
3. Browser limiting WebCrypto operations

**Solutions**:

```typescript
// Reduce iterations for faster derivation (less secure)
const key = await deriveKeyFromPassphrase(
  passphrase,
  salt,
  50_000  // Faster, but less secure
);

// Or use a Web Worker to avoid blocking UI
const worker = new Worker('pbkdf2-worker.js');
worker.postMessage({ passphrase, salt });
const key = await new Promise(resolve => {
  worker.onmessage = (e) => resolve(e.data);
});
```

---

## Part 7: Security Best Practices

### For Users

1. **Use a strong passphrase**:
   - ✅ "Tr0p1cal$Sunset#42!" (18+ characters)
   - ❌ "password123"
   - ❌ Dictionary words

2. **Don't share your passphrase**:
   - Your passphrase unlocks everything
   - Hussh cannot recover it if lost

3. **Rotate your passphrase annually**:
   - Generate new key derivation salt
   - Re-encrypt vault with new key

### For Developers

1. **Never log encryption keys**:
   ```typescript
   // ❌ BAD
   console.log('Key:', encryptionKey); // Never!
   
   // ✅ GOOD
   console.log('Key exists:', !!encryptionKey);
   ```

2. **Always use PBKDF2 for passphrase derivation**:
   ```typescript
   // ❌ BAD - Too fast for passwords
   const key = await crypto.subtle.digest('SHA-256', passphrase);
   
   // ✅ GOOD
   const key = await deriveKeyFromPassphrase(passphrase, salt);
   ```

3. **Test authentication tag verification**:
   ```typescript
   // Your tests should verify tampering is detected
   it('should reject tampered ciphertext', async () => {
     const encrypted = await encryptVaultData(data, key);
     const tampered = flipBit(encrypted.ciphertext, 0);
     
     expect(async () => {
       await decryptVaultData(tampered, encrypted.iv, encrypted.tag, key);
     }).toThrow('Authentication tag verification failed');
   });
   ```

---

## Summary

| Concept | What It Does | Key Insight |
|---------|------------|-------------|
| **PBKDF2** | Derives encryption key from passphrase | Makes brute-force attacks infeasible |
| **AES-256-GCM** | Encrypts vault data | Provides both confidentiality and authentication |
| **Random IV** | Makes same plaintext produce different ciphertext | Prevents pattern matching attacks |
| **Auth Tag** | Verifies data hasn't been tampered | Detects man-in-the-middle attacks |
| **BYOK** | You hold the encryption key | Hussh backend cannot decrypt your data |

---

## Next Steps

- Review the [vault service code](../../consent-protocol/hushh_mcp/services/vault_keys_service.py)
- Check out [crypto utilities](../../consent-protocol/hushh_mcp/vault/encrypt.py)
- Test encryption locally with the [crypto test suite](../../consent-protocol/tests/test_vault.py)
