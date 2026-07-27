# Identity & Authenticator Assurance — biometric, passkeys, WebAuthn/FIDO2, hardware keys

> **Status:** design + developer reference for elevating 🤫 hussh authentication to a
> platform-wide, standards-compliant posture. Dev-branch only; nothing here changes
> live auth until explicitly built and enabled. Companion:
> [`../personal-agent/ROADMAP.md`](../personal-agent/ROADMAP.md) (M14).
>
> **Built so far (M14, flag-off behind `WEBAUTHN_ENABLED`):** the server-side WebAuthn
> ceremony engine (`hushh_mcp/services/webauthn_service.py`, wrapping py_webauthn) that
> mints + one-time-consumes challenges and **verifies** attestation/assertion; the
> credential public-key store (migration 903); the flag-gated endpoints
> (`api/routes/one/webauthn.py`); **passkey-login session minting** — a user-verified
> assertion mints a Firebase custom token (UV-gated: an assertion without user
> verification is verified but not a login); and **AAL classification**
> (`webauthn_aal.py`): Google Titan / YubiKey via AAGUID → AAL3-candidate, platform
> authenticator + UV → AAL2. **Not yet wired:** WebAuthn **step-up** on sensitive
> personal-agent actions, and **MDS-verified attestation** to promote AAL3-candidate to
> a hard AAL3 (both flagged in §3/§5).
>
> **Scope:** `hushh-research` only (the app is `hushh-webapp/`, the backend is
> `consent-protocol/`). The `ENTERPRISE_SSO.md` / `sso-providers.ts` surfaces
> live in the separate `hushh-search-console` repo and are **not** part of this.

## 1. The honest current state (what "biometric/FaceID" means today)

**hussh supports biometric + FaceID + passkeys for *vault unlock*, not for *login*.**
That distinction is the whole story, and every developer + customer statement must
respect it:

- **Login / identity** = Firebase Auth (Google, Apple, email/password, custom token)
  + **phone‑number SMS OTP** as the verified identity attribute (`hushh-webapp/lib/
  services/auth-service.ts`, `lib/firebase/auth-context.tsx`). No biometric, passkey,
  or WebAuthn participates in authenticating to the account.
- **Biometric / passkey** = optional "faster unlock" wrappers over the end‑to‑end‑
  encrypted vault's Data Encryption Key (DEK). They wrap the *same* DEK a passphrase
  wraps (`docs/reference/architecture/api-contracts.md`: "Optional quick methods add
  wrappers for the same DEK").
- **Passkeys are used as a PRF key‑derivation device, not an auth credential.** The
  WebAuthn ceremony (`hushh-webapp/lib/vault/prf-auth.ts`; iOS `HushhVaultPlugin.swift`;
  Android `HushhVaultPlugin.kt`) mints its challenge **client‑side** and consumes only
  `prf.results.first` to derive the vault key via HKDF. **The assertion signature is
  never sent to or verified by a server.** There is **no server‑side WebAuthn ceremony.**

So the accurate phrasing is **"biometric / passkey vault unlock"** — never "biometric
login" or "passkey authentication" (yet). Positioning it as account‑auth assurance
would fail the Munger/Rude‑FAQ candor bar.

### The developer contract today

| Surface | Where | What it does |
|---|---|---|
| Native biometric (FaceID/TouchID) | `HushhKeychain.isBiometricAvailable → {available, type: faceId\|touchId\|none}`, `setBiometric`/`getBiometric` (`hushh-webapp/docs/plugin-api-reference.md`) | biometric‑gated Keychain/Keystore secret that wraps the vault DEK |
| Native passkey PRF | `HushhVault.isPasskeyAvailable/registerPasskeyPrf/authenticatePasskeyPrf` (iOS 18+; Android `androidx.credentials`) | platform‑authenticator PRF → vault key |
| Web passkey PRF | `lib/vault/prf-auth.ts` (Chrome/Edge/Safari; **Firefox + Windows Hello excluded**) | WebAuthn PRF extension → vault key |
| Credential storage | `consent-protocol/db/migrations/015_vault_multi_wrapper.sql`, `018_vault_wrapper_sets.sql` | `vault_key_wrappers(method, encrypted_vault_key, salt, iv, passkey_credential_id, passkey_prf_salt, passkey_rp_id, …)` — **no `public_key`, no `sign_count`, no `aaguid`** |
| Domain associations (RP `one.hushh.ai`) | `.well-known/apple-app-site-association` + `assetlinks.json` routes; `App.entitlements`; `scripts/ops/verify_passkey_domain_associations.py` | OS‑level plumbing so native passkeys resolve to the RP (fail‑closed 503 if unconfigured) |

Known weaknesses in the *unlock* feature itself (fix as part of any elevation):
- **Android `setBiometric` is not hardware‑bound** — stored in encrypted prefs, gated
  only by a `BiometricPrompt` on read, not by a biometric‑bound Keystore key
  (`HushhKeystorePlugin.kt` admits this in‑code).
- **Web has no biometric** and its fallback keystore is an in‑memory `Map` marked
  "NOT secure … development/testing only" (`keychain-web.ts`).
- Web passkey‑PRF is Chrome/Edge/Safari‑only; iOS native passkey needs iOS 18+.

## 2. The target — platform-wide, standards-compliant authenticator assurance

Give every human a **phishing‑resistant, passwordless** path to their account and to
sensitive actions, on any device, using the credentials they already carry — platform
biometrics (FaceID/TouchID/Android biometric), synced passkeys, and **hardware security
keys (Google Titan, YubiKey)** — mapped honestly to NIST 800‑63B assurance levels. This
is the identity spine under the consent‑first / FedRAMP posture (the personal‑agent
ARCHITECTURE §11 honesty ledger) and under "own your AI, own your data."

Standards we build to (state as **"in pursuit"** until a 3PAO/assessment says otherwise):
- **W3C WebAuthn Level 2 / FIDO2 CTAP2** — real registration + assertion ceremonies,
  server‑verified.
- **NIST SP 800‑63B**: **AAL2** = multi‑factor (something you have + a biometric/PIN
  user‑verification); **AAL3** = hardware‑based, phishing‑resistant (a Titan/YubiKey
  roaming authenticator with verified attestation).
- **FIDO Alliance** metadata (MDS) + **AAGUID** policy for device attestation and
  enterprise allow/deny lists.

## 3. What's missing (the gap list, grounded in the code)

To get from "PRF vault‑unlock" to "standards‑compliant authenticator assurance":

1. **No server‑side WebAuthn ceremony.** Challenges are client‑minted and assertions
   never verified. Need a backend that issues a random challenge, stores it bound to the
   user + a short TTL, and **verifies** the attestation (registration) and assertion
   (login/step‑up) — e.g. via `py_webauthn` (the `webauthn` PyPI package). No such
   dependency exists today.
2. **No credential / public‑key table.** `vault_key_wrappers` stores PRF metadata only.
   Need a real WebAuthn credential store: `credential_id` (unique), `public_key`,
   `sign_count`, `aaguid`, `transports`, `backup_eligible/backup_state`, `rp_id`,
   `user_id`, `created_at`, `last_used_at`.
3. **Passkey is bound to a vault key, not a session.** Need a "sign in with a passkey"
   path where a verified assertion mints a Firebase **custom token** (or a first‑party
   session), so a passkey/hardware key is a *login* method, not only an unlock.
4. **No MFA / step‑up / AAL2 machinery.** SMS OTP is not AAL2. Need step‑up: for
   sensitive actions (VAULT_OWNER issuance, personal‑agent provisioning, data‑rights /
   correction requests, account deletion) require a fresh phishing‑resistant assertion,
   recorded as a PCHP receipt.
5. **No hardware‑security‑key support.** Both current flows *require* the PRF/hmac‑secret
   extension and platform authenticators; roaming keys (Titan/YubiKey) are excluded. A
   **login‑grade** WebAuthn flow does **not** need PRF, so it can accept cross‑platform
   USB/NFC/BT keys — that is the path to Titan/YubiKey and AAL3.
6. **No AAGUID / attestation policy.** To assert AAL3 or run an enterprise allow‑list,
   verify attestation and check the AAGUID against FIDO MDS (e.g. gate on Titan/YubiKey
   AAGUIDs).

## 4. Google Titan Security Key — what it gives us (integration facts)

Titan (https://cloud.google.com/security/products/titan-security-key) is Google's FIDO
hardware key. Relevant facts for our WebAuthn integration:

- Implements **FIDO U2F** (2nd factor) and **FIDO2 / WebAuthn** (passwordless). Form
  factors: **USB‑A, USB‑C, NFC, Bluetooth**.
- **Phishing‑resistant by construction:** the key signs only when the origin/`rpId`
  matches the registered credential; the private key never leaves the device; physical
  user‑presence is required each time.
- **Assurance:** Titan + a password ⇒ **AAL2**; Titan as a hardware phishing‑resistant
  authenticator (Advanced Protection posture) ⇒ **AAL3**.
- **Engineering hooks:** WebAuthn Level 2; ECDSA (ES256) / RSA (RS256); **direct
  attestation** (device‑signed) — verifiable via the reported **AAGUID**; a **signature
  counter** enables cloned‑authenticator detection; credential is **origin‑bound** to
  the `rpId`. Works with existing libraries (`webauthn`/`py_webauthn` server‑side).
- For roaming keys set `authenticatorSelection.authenticatorAttachment =
  "cross-platform"` and do **not** require the PRF extension.

## 5. How a developer would enable it (target flows)

**Registration (add a passkey or a Titan/YubiKey):** `POST /api/one/auth/webauthn/
register/options` (server issues challenge, bound to the Firebase‑authenticated user) →
`navigator.credentials.create()` (or `HushhVault` native) → `POST …/register/verify`
(server verifies attestation, stores the credential public key + AAGUID + sign_count).

**Login with a passkey / hardware key:** `POST …/authenticate/options` (usernameless,
`residentKey`/discoverable creds) → `navigator.credentials.get()` → `POST …/authenticate/
verify` (server verifies the assertion + sign_count, then mints a Firebase custom token).

**Step‑up (AAL2/AAL3 for a sensitive action):** the action endpoint demands a fresh
assertion (short‑TTL challenge); on success it records a PCHP consent receipt noting the
authenticator + AAL reached, then proceeds. Hardware‑key (Titan) assertions with verified
attestation are marked AAL3.

**Vault unlock stays as‑is** (PRF‑derived DEK) — it is a *different, complementary*
capability. A device can both *log in* with a passkey and *unlock the vault* with the
same authenticator's PRF output; the two ceremonies remain distinct.

## 6. Compliance mapping (honest, "in pursuit")

| Control | Today | Target |
|---|---|---|
| NIST 800‑63B **AAL1** | ✅ Firebase social + SMS OTP | ✅ |
| **AAL2** (multi‑factor, biometric UV) | ❌ | passkey/biometric login + step‑up |
| **AAL3** (hardware, phishing‑resistant) | ❌ | Titan/YubiKey with verified attestation |
| WebAuthn L2 server ceremony | ❌ (client‑only PRF) | ✅ challenge + verify |
| Phishing‑resistant login | ❌ (SMS OTP) | ✅ origin‑bound WebAuthn |
| Enterprise AAGUID policy | ❌ | ✅ MDS check + allow‑list |

Never claim AAL2/AAL3/FedRAMP until a 3PAO/assessment confirms it; present as **"in
pursuit"** on any public surface (mirrors the personal‑agent honesty ledger).

## 7. Relationship to the sovereign agent

Step‑up authenticator assurance is the natural gate for the personal agent's most
sensitive control‑plane actions — VAULT_OWNER token issuance, personal‑agent
provision/deprovision, and outbound **data‑correction requests** — each already a
PCHP‑receipted action. Wiring WebAuthn step‑up in front of those raises the whole
consent posture toward AAL2/AAL3 without changing the consent model. See M14 in the
[ROADMAP](../personal-agent/ROADMAP.md).
