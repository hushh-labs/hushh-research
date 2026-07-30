# Trusted-Device Vault Handoff

## Visual Context

Visual owner: [Hussh IAM Reference](../../../docs/reference/iam/README.md).
Canonical cross-cutting contract:
[Hermes Trusted-Device Vault Enrollment](../../../docs/reference/iam/hermes-trusted-device-vault-enrollment.md).
This page documents the narrower backend implementation.

## Boundary

This is an account/vault onboarding contract, not an MCP contract.

The backend registers and revokes trusted devices, enforces PKCE and replay
protection, stores short-lived ciphertext, and issues device-bound action
capabilities. It never unwraps a vault key and never maps a developer token to
`VAULT_OWNER`.

## Stored Authorization State

`trusted_device_authorizations` contains:

- authorization, device, and owner identifiers;
- hash of the one-time code;
- PKCE challenge;
- normalized loopback redirect;
- public P-256 device key and non-secret label;
- OAuth state, creation/expiry/consumption timestamps;
- optional bounded X25519/AES-GCM ciphertext JSON.

Migration `124_trusted_device_vault_handoff.sql` is additive. The ciphertext
column never contains a passphrase, recovery key, PRF result, plaintext vault
key, Firebase refresh credential, or decrypted PKM information.

## Route Sequence

1. Authenticated browser approval calls
   `POST /api/account/trusted-device-authorizations`.
2. If a compatible passkey locally unlocks the vault, the browser calls
   `POST /api/account/trusted-device-authorizations/{authorization_id}/vault-handoff`.
3. The store accepts the ciphertext only for the same authenticated owner,
   before expiry, before code consumption, and only once.
4. Hermes calls
   `POST /api/account/trusted-device-authorizations/exchange` with the
   one-time code and PKCE verifier.
5. One Postgres statement consumes the grant, activates or repairs the device,
   revokes the replaced device when applicable, and returns the optional
   ciphertext.

The exchange remains valid when no ciphertext is attached; Hermes then uses
its native protected passphrase or first-vault ceremony.

## Validation and Audit

The route accepts only:

- `X25519-AES256-GCM`;
- a 32-byte wrapped key;
- a 12-byte IV;
- a 16-byte authentication tag;
- a 32-byte sender public key;
- a lowercase 64-character vault-key hash;
- bounded wrapper and RP identifiers.

Authorization approval, handoff attachment, exchange, capability issuance,
write outcome, and revocation use metadata-only audit events. The handoff
event records the authorization identifier and algorithm, never ciphertext or
vault material.

`TrustedDeviceStore` remains the replaceable state port. Postgres is canonical
today; Redis or Memorystore can later handle high-volume nonce/revocation
fan-out without changing the HTTP contract.

## Verification Owners

- `tests/test_trusted_device_routes.py`: request and identity boundaries.
- `tests/test_trusted_device_service.py`: single-use attach, PKCE exchange,
  device activation, replacement, nonce replay, and revocation.
- `tests/test_trusted_device_migration.py`: migration and schema contracts.
- Web and Hermes suites own cross-runtime X25519/AES-GCM parity and local
  vault-key validation.
