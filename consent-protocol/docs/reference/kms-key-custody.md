# KMS key custody — envelope-encrypted core keys (SC-12 / SC-13 / SC-28)

**Status:** in pursuit, dev-branch only, feature-flagged **OFF**
(`KMS_KEY_RESOLUTION_ENABLED`, default off). Enabling it also requires the
`google-cloud-kms` dependency (lazy-imported only when the flag is on) and a
provisioned Cloud KMS key — none of which a normal process needs today.

## Why

Today the core data-encryption keys (DEKs) — `APP_SIGNING_KEY` (HMAC token +
receipt-chain signing) and `VAULT_DATA_KEY` (AES-256-GCM vault) — are resolved
from **plaintext environment variables** (populated from Secret Manager at
deploy). That is a single static key with no envelope encryption and no managed
rotation — the gap against **NIST 800-53 SC-12 (key establishment & management)**,
**SC-13 (cryptographic protection)**, and **SC-28 (protection of information at
rest)**.

## How it works

Only **key resolution at startup** changes; the hot path (HMAC/AES on the
in-memory DEK) is untouched.

- **OFF (default):** `get_core_security_settings()` reads the plaintext env var,
  exactly as before — byte-for-byte unchanged.
- **ON:** the DEK is stored only as a **KMS-wrapped ciphertext**
  (`APP_SIGNING_KEY_CIPHERTEXT` / `VAULT_DATA_KEY_CIPHERTEXT`, base64) and unwrapped
  once at startup via a **key-encryption-key (KEK)** in Cloud KMS
  (`KMS_KEK_RESOURCE`). The KEK is HSM-backed and FIPS 140-validated at the
  platform; it never leaves KMS. `hushh_mcp/kms_key_resolver.resolve_key` performs
  the unwrap; `default_kms_decryptor` lazy-imports `google-cloud-kms`.

Because the KEK wraps the DEK, **KEK rotation is transparent** — KMS rotates the
KEK on its schedule and the ciphertext is re-wrapped; the DEK is unchanged, so
existing HMAC signatures and vault ciphertext remain valid (SC-12 rotation without
a flag day).

## Fail-closed vs fail-safe

`KMS_KEY_RESOLUTION_STRICT` (default off) governs failure:

- **strict (production):** if enabled but unconfigured, or if the KMS unwrap
  fails, startup **fails closed** — the process will not run on a fallback key.
- **default (dev):** the resolver falls back to the plaintext env var with a
  warning, so turning the flag on for dev experimentation cannot brick startup. In
  production the plaintext env is typically empty, so a fallback still surfaces as
  the existing key-length validation error rather than silently using a bad key.

## Enabling (dev only)

1. Add `google-cloud-kms` to the environment.
2. Provision a KMS key ring + key; wrap each DEK: `kms encrypt` the plaintext key,
   base64 the ciphertext into `APP_SIGNING_KEY_CIPHERTEXT` / `VAULT_DATA_KEY_CIPHERTEXT`.
3. Set `KMS_KEK_RESOURCE` to the key resource name, `KMS_KEY_RESOLUTION_ENABLED=1`
   (and `KMS_KEY_RESOLUTION_STRICT=1` for a fail-closed posture).
4. Grant the runtime service account `roles/cloudkms.cryptoKeyDecrypter` on the key.

## Honest limitations (what this is NOT — yet)

- **KEK rotation, not DEK rotation.** Rotating the actual signing key (a new DEK)
  would invalidate existing HMAC signatures unless verification tries current +
  previous keys. Version-aware verification is a separate, larger step; today the
  DEK is stable and only the KEK rotates.
- **Envelope at rest, not KMS-side signing.** Signing/encryption still happen in
  process with the in-memory DEK (no hot-path latency or availability coupling to
  KMS). Moving HMAC into KMS MAC keys (`macSign`/`macVerify`) is a heavier future
  option.
- **Dependency + provisioning are enablement-time.** `google-cloud-kms` is
  lazy-imported and the KMS key is provisioned only when the flag is turned on.

Posture stays **"in pursuit"** — the control is real in code before any 3PAO /
ATO says otherwise; it is never presented as a held certification. Pairs with the
consent-audit receipt chain (AU-9/AU-10), whose signatures now rest on a
KMS-custodied key when this is enabled.
