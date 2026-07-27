# WebAuthn AAL3 via FIDO-MDS attestation (IA-2 / NIST 800-63B)

**Status:** in pursuit, dev-branch only, feature-flagged **OFF**
(`WEBAUTHN_MDS_ENABLED`, default off). The WebAuthn/FIDO2 ceremony itself remains
gated by `WEBAUTHN_ENABLED` (also default off). Enabling AAL3 elevation additionally
requires a provisioned, verified FIDO MDS extract at `WEBAUTHN_MDS_BLOB_PATH`.

## Why

The server-side WebAuthn ceremony already verifies attestation/assertion and the
AAL classifier honestly maps a hardware security key + user verification to
**`AAL3-candidate`** — deliberately *not* claiming hard AAL3, because true AAL3
(NIST 800-63B / phishing-resistant IA-2) also requires the authenticator model to
be verified against the **FIDO Metadata Service (MDS)**. This change makes that
verification real, so a verified hardware key elevates to genuine **AAL3**.

## How it works

- `hushh_mcp/services/webauthn_mds.py` — `mds_verified_aaguid(aaguid)` decides
  whether an authenticator model (by AAGUID) is FIDO-certified and free of any
  compromise/revocation status. `evaluate_entry` is the pure decision: any
  `REVOKED` / `USER_VERIFICATION_BYPASS` / `*_COMPROMISE` status disqualifies the
  model regardless of certification; certification requires a `FIDO_CERTIFIED*`
  status.
- `webauthn_aal.classify(..., mds_verified=...)` — when a hardware key + user
  verification is `mds_verified is True`, the AAL is **`AAL3`**; otherwise it stays
  the honest **`AAL3-candidate`**. The result carries an `mdsVerified` field for
  transparency.
- `webauthn_service` passes `mds_verified_aaguid(aaguid)` at both the registration
  and authentication classify sites. With the flag off it returns `None`, so the
  classifier output is **byte-for-byte unchanged** (still `AAL3-candidate`).

## Pluggable MDS source (why this is honest)

The status-processing **decision** is real and unit-tested. The **source** of MDS
entries is injectable; the default lazy-loads a verified entries file from
`WEBAUTHN_MDS_BLOB_PATH`. Producing that file — fetching the signed FIDO MDS BLOB
and verifying its JWT signature against the FIDO root certificate — is the
enablement-time step and is intentionally kept outside this module's trust
decision. Fail-safe: an unknown AAGUID, a load error, or a disabled flag never
grants AAL3.

## Enabling (dev only)

1. `WEBAUTHN_ENABLED=1` (the ceremony) and `WEBAUTHN_MDS_ENABLED=1` (this elevation).
2. Fetch + verify the FIDO MDS BLOB, extract the verified entries to a JSON file,
   and set `WEBAUTHN_MDS_BLOB_PATH` to it.
3. Optionally extend the hardware-key AAGUID seed via `WEBAUTHN_HARDWARE_KEY_AAGUIDS`.

## Honest limitations (what this is NOT — yet)

- **BLOB signature verification is enablement-time.** This module consumes a
  *verified* MDS extract; it does not itself fetch and JWT-verify the FIDO BLOB.
- **Cohort enablement + step-up are follow-ups.** Requiring WebAuthn (and an AAL
  floor) for a privileged/federal cohort, and forcing a fresh AAL2/AAL3 assertion
  before sensitive actions, are separate rollout steps — each a real behavior
  change for live users, so they are gated on a cohort definition and founder
  sign-off, not shipped here.

Posture stays **"in pursuit"** — the control is real in code before any 3PAO / ATO
says otherwise; a certification we do not hold is never claimed.
