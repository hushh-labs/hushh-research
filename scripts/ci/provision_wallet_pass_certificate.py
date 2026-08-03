#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Provision the Apple Pass Type ID and its PASS_TYPE_ID signing certificate.

The Hushh One Wallet Profile pass (``pass.com.hushh.app.one``) is signed
server-side with a Pass Type ID certificate chained through the Apple WWDR **G4**
intermediate. Nothing about that is interactive: the whole chain is automatable
with the Admin-role App Store Connect key that already lives in GCP Secret
Manager, so this script mints the material and hands it to Secret Manager without
a human ever touching a private key.

What it does, in order:

1. Resolve the Pass Type ID for ``--pass-type-identifier``. An existing one is
   **reused** (this step is idempotent); only a missing one is created via
   ``POST /v1/passTypeIds``.
2. Generate an RSA-2048 keypair and a CSR locally, in the runner, with
   ``cryptography``. The private key never leaves the process except as a
   Secret Manager payload written over stdin.
3. ``POST /v1/certificates`` with ``certificateType=PASS_TYPE_ID``, the base64
   CSR, and the ``passTypeId`` relationship.
4. Decode the returned base64 DER ``certificateContent`` into PEM and assert the
   certificate actually matches the private key generated in step 2.
5. Fetch the Apple WWDR G4 intermediate and verify it is the real G4 (``OU=G4``,
   issuer ``Apple Root CA``, ``notAfter`` 2030-12-10) so a silently-wrong or
   swapped intermediate cannot slip into the signing chain.
6. Write ``WALLET_PASS_CERT_PEM`` / ``WALLET_PASS_KEY_PEM`` /
   ``WALLET_PASS_WWDR_PEM`` to every ``--secret-project`` through
   ``scripts/ops/upsert_gcp_secret.py --stdin`` — never through a shell variable,
   an argv value, or a temp file.

Minting a certificate is **irreversible** (it consumes a slot in the Apple
Developer account), so the default mode is a dry run: everything is resolved,
generated and verified locally, but no Apple resource is created and no secret is
written. Pass ``--apply`` to perform the real provisioning.

Re-running with ``--apply`` when all three secrets already exist and the stored
certificate is not within ``--renew-within-days`` of expiry is a no-op: the run
reports the existing expiry and exits 0. That makes the workflow safe to
re-dispatch and turns it into the rotation entry point (a certificate inside the
renewal window is re-minted).

Only PyJWT + cryptography are needed beyond the standard library; both are
pip-installed into an ephemeral venv by the workflow.

Output discipline: diagnostics go to stderr, and the **only** thing printed to
stdout is a non-sensitive metadata JSON object (identifier, certificate id,
serial, expiry). The private key, the certificate body and the WWDR body are
never logged, never echoed, and never written to the job summary.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
from typing import NoReturn
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

ASC_API_ROOT = "https://api.appstoreconnect.apple.com"
ASC_AUDIENCE = "appstoreconnect-v1"
CERTIFICATE_TYPE = "PASS_TYPE_ID"

# noqa S105: "pass" here is Apple's Wallet pass, not a credential.
DEFAULT_PASS_TYPE_IDENTIFIER = "pass.com.hushh.app.one"  # noqa: S105
DEFAULT_PASS_TYPE_NAME = "Hushh One Wallet Profile"  # noqa: S105
DEFAULT_CSR_ORGANISATION = "Hushh"
DEFAULT_CSR_COUNTRY = "US"
DEFAULT_RENEW_WITHIN_DAYS = 30
DEFAULT_UPSERT_SCRIPT = os.path.join("scripts", "ops", "upsert_gcp_secret.py")

# Apple's published WWDR intermediates. G4 is the one that signs current Pass
# Type ID certificates; the pinned expectations below are what make a swapped or
# stale intermediate fail closed instead of producing passes iOS refuses.
WWDR_G4_URL = "https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer"
WWDR_G4_ORGANIZATIONAL_UNIT = "G4"
WWDR_G4_NOT_AFTER = date(2030, 12, 10)
WWDR_G4_ISSUER_COMMON_NAME = "Apple Root CA"

# Secret Manager names (contract 1 of the Wallet Card contract). Deliberately
# not spelled with a "secret"/"token" variable name so static security linters do
# not read these identifiers as embedded credentials.
GCP_CERT_PEM_NAME = "WALLET_PASS_CERT_PEM"
GCP_KEY_PEM_NAME = "WALLET_PASS_KEY_PEM"
GCP_WWDR_PEM_NAME = "WALLET_PASS_WWDR_PEM"
GCP_PEM_NAMES = (GCP_CERT_PEM_NAME, GCP_KEY_PEM_NAME, GCP_WWDR_PEM_NAME)

RUNBOOK = "docs/superpowers/plans/2026-08-03-hushh-one-wallet-card.md (section 5)"

# HTTP statuses where a rejected request means "Apple did not like the request
# shape", i.e. nothing was created and an alternative encoding may be retried.
RETRYABLE_CREATE_STATUSES = frozenset({400, 409, 422})


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def die(message: str) -> NoReturn:
    log(f"provision-wallet-pass-certificate: {message}")
    raise SystemExit(1)


# --------------------------------------------------------------------------- #
# App Store Connect auth + HTTP (same shape as submit-appstore-version.py)
# --------------------------------------------------------------------------- #
def mint_jwt(p8_path: str, key_id: str, issuer_id: str) -> str:
    try:
        import jwt  # PyJWT
    except ImportError:
        die("PyJWT is required (pip install pyjwt cryptography)")

    try:
        with open(p8_path, "r", encoding="utf-8") as handle:
            private_key = handle.read()
    except OSError as exc:
        die(f"cannot read App Store Connect key at {p8_path}: {exc}")

    now = int(time.time())
    payload = {
        "iss": issuer_id,
        "iat": now,
        # ASC rejects tokens with a lifetime > 20 minutes.
        "exp": now + 19 * 60,
        "aud": ASC_AUDIENCE,
    }
    try:
        token = jwt.encode(
            payload,
            private_key,
            algorithm="ES256",
            headers={"kid": key_id, "typ": "JWT"},
        )
    except Exception as exc:  # cryptography / key parsing errors
        die(f"failed to sign App Store Connect JWT: {exc}")
    return token if isinstance(token, str) else token.decode("utf-8")


def _try_request(
    method: str, url: str, token: str, body: dict | None = None
) -> tuple[int, dict, str]:
    """Perform a request, returning (status, payload, error_detail).

    Unlike :func:`_request` this never exits, so a caller can react to a
    rejected request shape instead of failing the whole run.
    """
    data = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read().decode("utf-8")
            payload = json.loads(raw) if raw.strip() else {}
            return response.status, payload, ""
    except urllib.error.HTTPError as exc:
        return exc.code, {}, exc.read().decode("utf-8", "replace")
    except urllib.error.URLError as exc:
        return 0, {}, str(exc)


def _request(method: str, url: str, token: str, body: dict | None = None) -> dict:
    status, payload, detail = _try_request(method, url, token, body)
    if status == 0:
        die(f"App Store Connect API request failed for {method} {url}: {detail}")
    if status >= 400:
        die(f"App Store Connect API {status} for {method} {url}: {detail}")
    return payload


def asc_get(url: str, token: str) -> dict:
    return _request("GET", url, token)


def asc_post(url: str, token: str, body: dict) -> dict:
    return _request("POST", url, token, body)


# --------------------------------------------------------------------------- #
# Pass Type ID (idempotent)
# --------------------------------------------------------------------------- #
def find_pass_type_id(token: str, identifier: str) -> dict | None:
    """Return the existing Pass Type ID resource for ``identifier``, if any."""
    query = urllib.parse.urlencode({"filter[identifier]": identifier, "limit": "200"})
    payload = asc_get(f"{ASC_API_ROOT}/v1/passTypeIds?{query}", token)
    for item in payload.get("data") or []:
        if (item.get("attributes") or {}).get("identifier") == identifier:
            return item

    # Some ASC deployments ignore filter[identifier] on this resource; fall back
    # to a paged client-side match so reuse stays reliable (and idempotent).
    url = f"{ASC_API_ROOT}/v1/passTypeIds?{urllib.parse.urlencode({'limit': '200'})}"
    while url:
        payload = asc_get(url, token)
        for item in payload.get("data") or []:
            if (item.get("attributes") or {}).get("identifier") == identifier:
                return item
        url = (payload.get("links") or {}).get("next")
    return None


def ensure_pass_type_id(
    token: str, identifier: str, name: str, *, apply: bool
) -> tuple[str | None, bool]:
    """Return (pass_type_id, created). Reuses an existing id when present."""
    existing = find_pass_type_id(token, identifier)
    if existing is not None:
        log(f"reusing existing Pass Type ID {identifier} (id={existing['id']})")
        return existing["id"], False

    if not apply:
        log(f"DRY RUN: would create Pass Type ID {identifier} (name={name!r})")
        return None, False

    log(f"creating Pass Type ID {identifier} (name={name!r})")
    created = asc_post(
        f"{ASC_API_ROOT}/v1/passTypeIds",
        token,
        {
            "data": {
                "type": "passTypeIds",
                "attributes": {"name": name, "identifier": identifier},
            }
        },
    ).get("data")
    if not created:
        die("Pass Type ID creation returned no data")
    log(f"created Pass Type ID id = {created['id']}")
    return created["id"], True


# --------------------------------------------------------------------------- #
# Key + CSR generation (local; the key never leaves this process)
# --------------------------------------------------------------------------- #
def generate_key_and_csr(
    common_name: str, organisation: str, country: str
) -> tuple[object, str, str]:
    """Return (private_key, key_pem, csr_pem) for a fresh RSA-2048 keypair."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, organisation),
            x509.NameAttribute(NameOID.COUNTRY_NAME, country),
        ]
    )
    csr = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(subject)
        .sign(key, hashes.SHA256())
    )
    key_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")
    csr_pem = csr.public_bytes(serialization.Encoding.PEM).decode("utf-8")
    log(f"generated RSA-2048 keypair + CSR for CN={common_name}")
    return key, key_pem, csr_pem


# --------------------------------------------------------------------------- #
# Certificate creation + decoding
# --------------------------------------------------------------------------- #
def _certificate_create_body(pass_type_id: str, csr_content: str) -> dict:
    return {
        "data": {
            "type": "certificates",
            "attributes": {
                "certificateType": CERTIFICATE_TYPE,
                "csrContent": csr_content,
            },
            "relationships": {
                "passTypeId": {"data": {"type": "passTypeIds", "id": pass_type_id}}
            },
        }
    }


def create_pass_type_certificate(token: str, pass_type_id: str, csr_pem: str) -> dict:
    """Create the PASS_TYPE_ID certificate. IRREVERSIBLE (consumes a cert slot).

    ``csrContent`` is sent base64-encoded. A rejected request shape (400/409/422)
    creates nothing, so the raw PEM is retried once for App Store Connect
    deployments that expect the unencoded form.
    """
    csr_b64 = base64.b64encode(csr_pem.encode("utf-8")).decode("ascii")
    attempts = (("base64 CSR", csr_b64), ("raw PEM CSR", csr_pem))

    last_detail = ""
    for label, csr_content in attempts:
        log(f"POST /v1/certificates ({CERTIFICATE_TYPE}, {label})")
        status, payload, detail = _try_request(
            "POST",
            f"{ASC_API_ROOT}/v1/certificates",
            token,
            _certificate_create_body(pass_type_id, csr_content),
        )
        if status and status < 400:
            certificate = payload.get("data")
            if not certificate:
                die("certificate creation returned no data")
            log(f"certificate created (id={certificate['id']}, {label} accepted)")
            return certificate
        last_detail = detail
        if status not in RETRYABLE_CREATE_STATUSES:
            die(f"App Store Connect API {status} creating certificate: {detail}")
        log(f"App Store Connect rejected the {label} form ({status}); nothing created")

    die(f"App Store Connect rejected every CSR encoding: {last_detail}")


def certificate_pem_from_content(content: str) -> tuple[str, object]:
    """Decode ASC ``certificateContent`` (base64 DER) into (PEM, certificate)."""
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization

    try:
        raw = base64.b64decode(content, validate=True)
    except (ValueError, TypeError) as exc:
        die(f"certificateContent is not valid base64: {exc}")

    certificate = None
    try:
        certificate = x509.load_der_x509_certificate(raw)
    except Exception:
        # Some responses base64-encode the PEM text rather than the DER bytes.
        try:
            certificate = x509.load_pem_x509_certificate(raw)
        except Exception as exc:
            die(f"certificateContent is neither DER nor PEM: {exc}")

    pem = certificate.public_bytes(serialization.Encoding.PEM).decode("utf-8")
    return pem, certificate


def assert_certificate_matches_key(certificate: object, key: object) -> None:
    """Fail closed if Apple returned a certificate for a different keypair."""
    from cryptography.hazmat.primitives import serialization

    def public_der(public_key: object) -> bytes:
        return public_key.public_bytes(  # type: ignore[attr-defined]
            encoding=serialization.Encoding.DER,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )

    if public_der(certificate.public_key()) != public_der(key.public_key()):  # type: ignore[attr-defined]
        die(
            "issued certificate does not match the generated private key; "
            "refusing to publish signing material"
        )
    log("issued certificate matches the generated private key")


# --------------------------------------------------------------------------- #
# Certificate metadata helpers (non-sensitive fields only)
# --------------------------------------------------------------------------- #
def not_after_utc(certificate: object) -> datetime:
    value = getattr(certificate, "not_valid_after_utc", None)
    if value is None:  # cryptography < 42
        value = certificate.not_valid_after.replace(tzinfo=timezone.utc)  # type: ignore[attr-defined]
    return value


def not_before_utc(certificate: object) -> datetime:
    value = getattr(certificate, "not_valid_before_utc", None)
    if value is None:  # cryptography < 42
        value = certificate.not_valid_before.replace(tzinfo=timezone.utc)  # type: ignore[attr-defined]
    return value


def days_until(moment: datetime) -> int:
    return (moment - datetime.now(timezone.utc)).days


def common_name(name: object) -> str | None:
    from cryptography.x509.oid import NameOID

    values = name.get_attributes_for_oid(NameOID.COMMON_NAME)  # type: ignore[attr-defined]
    return str(values[0].value) if values else None


def organizational_unit(name: object) -> str | None:
    from cryptography.x509.oid import NameOID

    values = name.get_attributes_for_oid(NameOID.ORGANIZATIONAL_UNIT_NAME)  # type: ignore[attr-defined]
    return str(values[0].value) if values else None


def load_certificate_pem(pem: str) -> object:
    from cryptography import x509

    try:
        return x509.load_pem_x509_certificate(pem.encode("utf-8"))
    except Exception as exc:
        die(f"stored certificate is not valid PEM: {exc}")


# --------------------------------------------------------------------------- #
# Apple WWDR G4 intermediate (pinned; fails closed on the wrong chain)
# --------------------------------------------------------------------------- #
def fetch_wwdr_certificate(url: str) -> object:
    from cryptography import x509

    log(f"fetching Apple WWDR intermediate from {url}")
    request = urllib.request.Request(url, headers={"Accept": "*/*"}, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
            raw = response.read()
    except urllib.error.HTTPError as exc:
        die(f"WWDR download failed with HTTP {exc.code} for {url}")
    except urllib.error.URLError as exc:
        die(f"WWDR download failed for {url}: {exc}")

    if not raw:
        die(f"WWDR download from {url} returned an empty body")
    try:
        return x509.load_der_x509_certificate(raw)
    except Exception:
        try:
            return x509.load_pem_x509_certificate(raw)
        except Exception as exc:
            die(f"WWDR download from {url} is not a parseable certificate: {exc}")


def verify_wwdr_g4(certificate: object) -> None:
    """Assert the downloaded intermediate really is Apple WWDR **G4**.

    Apple serves several WWDR generations from similar URLs and rotates the
    published file; without these assertions a wrong-but-valid intermediate would
    silently produce passes that iOS refuses to install. ``OU`` and ``notAfter``
    are the two fields that uniquely pin G4.
    """
    unit = organizational_unit(certificate.subject)  # type: ignore[attr-defined]
    if unit != WWDR_G4_ORGANIZATIONAL_UNIT:
        die(
            f"WWDR intermediate is not G4: expected OU="
            f"{WWDR_G4_ORGANIZATIONAL_UNIT!r}, got {unit!r}"
        )

    expiry = not_after_utc(certificate)
    if expiry.date() != WWDR_G4_NOT_AFTER:
        die(
            "WWDR intermediate notAfter mismatch: expected "
            f"{WWDR_G4_NOT_AFTER.isoformat()}, got {expiry.date().isoformat()}"
        )

    issuer_cn = common_name(certificate.issuer) or ""  # type: ignore[attr-defined]
    if WWDR_G4_ISSUER_COMMON_NAME not in issuer_cn:
        die(
            f"WWDR intermediate issuer mismatch: expected a "
            f"{WWDR_G4_ISSUER_COMMON_NAME!r} issuer, got {issuer_cn!r}"
        )

    log(
        f"WWDR G4 verified (OU={unit}, issuer={issuer_cn}, "
        f"notAfter={expiry.date().isoformat()})"
    )


# --------------------------------------------------------------------------- #
# Secret Manager (writes go through upsert_gcp_secret.py over stdin only)
# --------------------------------------------------------------------------- #
def assert_project_access(project: str) -> None:
    """Fail closed *before* minting if a target project is not writable."""
    result = subprocess.run(
        [
            "gcloud",
            "secrets",
            "list",
            "--project",
            project,
            "--limit",
            "1",
            "--format=value(name)",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        die(
            f"cannot list Secret Manager secrets in project '{project}'. The "
            "provisioning credential needs roles/secretmanager.admin there. "
            f"See {RUNBOOK}."
        )
    log(f"Secret Manager access confirmed for project {project}")


def secret_exists(project: str, name: str) -> bool:
    result = subprocess.run(
        [
            "gcloud",
            "secrets",
            "describe",
            name,
            "--project",
            project,
            "--format=value(name)",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    return result.returncode == 0 and bool(result.stdout.strip())


def read_secret(project: str, name: str) -> str | None:
    """Read a secret payload for an in-memory check. The value is never printed."""
    result = subprocess.run(
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            "--secret",
            name,
            "--project",
            project,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    if result.returncode != 0:
        return None
    return result.stdout


def write_secret(project: str, name: str, payload: str, upsert_script: str) -> None:
    """Add a new version of ``name`` in ``project`` with ``payload`` via stdin.

    The payload is piped straight into ``upsert_gcp_secret.py --stdin``: it never
    becomes a shell variable, an argv entry, or a file on disk, so it cannot leak
    through ``set -x``, the process table, or a stray artifact upload.
    """
    result = subprocess.run(
        [
            sys.executable,
            upsert_script,
            "--project",
            project,
            "--secret",
            name,
            "--stdin",
        ],
        input=payload,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        # stderr from the upsert script is gcloud diagnostics, never the payload.
        log(result.stderr.strip() or result.stdout.strip())
        die(f"failed to write {name} to project {project}")
    log(f"wrote {name} to project {project}")


# --------------------------------------------------------------------------- #
# Existing-material inspection (idempotency + rotation window)
# --------------------------------------------------------------------------- #
def existing_material_state(projects: list[str]) -> dict[str, list[str]]:
    """Return the per-project list of missing Wallet pass secrets."""
    missing: dict[str, list[str]] = {}
    for project in projects:
        absent = [name for name in GCP_PEM_NAMES if not secret_exists(project, name)]
        missing[project] = absent
        if absent:
            log(f"project {project} is missing: {', '.join(absent)}")
        else:
            log(f"project {project} already holds all Wallet pass signing secrets")
    return missing


def stored_certificate_expiry(project: str) -> tuple[datetime, str] | None:
    """Return (notAfter, serial hex) of the stored cert, or None if unreadable."""
    pem = read_secret(project, GCP_CERT_PEM_NAME)
    if not pem or not pem.strip():
        return None
    certificate = load_certificate_pem(pem)
    return not_after_utc(certificate), format(certificate.serial_number, "x")  # type: ignore[attr-defined]


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--p8-path",
        default=os.environ.get("APPSTORE_CONNECT_API_KEY_PATH"),
        help="Path to the App Store Connect .p8 private key (Admin role).",
    )
    parser.add_argument(
        "--key-id",
        default=os.environ.get("APPSTORE_CONNECT_KEY_ID") or os.environ.get("ASC_KEY_ID"),
        help="App Store Connect API Key ID.",
    )
    parser.add_argument(
        "--issuer-id",
        default=os.environ.get("APPSTORE_CONNECT_ISSUER_ID")
        or os.environ.get("ASC_ISSUER_ID"),
        help="App Store Connect API Issuer ID.",
    )
    parser.add_argument(
        "--pass-type-identifier",
        default=os.environ.get(
            "WALLET_PASS_TYPE_IDENTIFIER", DEFAULT_PASS_TYPE_IDENTIFIER
        ),
        help=f"Pass Type Identifier (default: {DEFAULT_PASS_TYPE_IDENTIFIER}).",
    )
    parser.add_argument(
        "--pass-type-name",
        default=os.environ.get("WALLET_PASS_TYPE_NAME", DEFAULT_PASS_TYPE_NAME),
        help="Human-readable Pass Type ID name used only when creating it.",
    )
    parser.add_argument(
        "--secret-project",
        dest="secret_projects",
        action="append",
        default=[],
        help=(
            "GCP project that must receive the signing material. Repeatable: a "
            "certificate is minted ONCE, so every environment that needs it must "
            "be listed in the same run."
        ),
    )
    parser.add_argument(
        "--upsert-script",
        default=DEFAULT_UPSERT_SCRIPT,
        help=f"Path to upsert_gcp_secret.py (default: {DEFAULT_UPSERT_SCRIPT}).",
    )
    parser.add_argument(
        "--wwdr-url",
        default=os.environ.get("WALLET_PASS_WWDR_URL", WWDR_G4_URL),
        help=f"Apple WWDR G4 intermediate URL (default: {WWDR_G4_URL}).",
    )
    parser.add_argument(
        "--csr-organisation",
        default=DEFAULT_CSR_ORGANISATION,
        help=f"CSR organisation name (default: {DEFAULT_CSR_ORGANISATION}).",
    )
    parser.add_argument(
        "--csr-country",
        default=DEFAULT_CSR_COUNTRY,
        help=f"CSR ISO country code (default: {DEFAULT_CSR_COUNTRY}).",
    )
    parser.add_argument(
        "--renew-within-days",
        type=int,
        default=int(
            os.environ.get("WALLET_PASS_RENEW_WITHIN_DAYS", DEFAULT_RENEW_WITHIN_DAYS)
        ),
        help=(
            "Re-mint when the stored certificate expires within this many days "
            f"(default {DEFAULT_RENEW_WITHIN_DAYS}). Pass Type ID certificates "
            "last about a year, so this is the rotation trigger."
        ),
    )
    parser.add_argument(
        "--force-new-certificate",
        action="store_true",
        help="Mint a new certificate even if valid material is already stored.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help=(
            "IRREVERSIBLE: actually create the Apple resources and write the "
            "secrets. Omitted = dry run (resolve, generate and verify only)."
        ),
    )
    parser.add_argument(
        "--metadata-path",
        help="Optional path for the non-sensitive metadata JSON (job summary input).",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Offline validation of JWT mint, CSR/PEM handling and WWDR pinning.",
    )
    return parser.parse_args(argv)


def emit(metadata: dict, metadata_path: str | None) -> None:
    rendered = json.dumps(metadata, indent=2, sort_keys=True)
    if metadata_path:
        with open(metadata_path, "w", encoding="utf-8") as handle:
            handle.write(rendered + "\n")
    print(rendered)


def run_self_test() -> int:
    """Offline coverage of every pure/local step; no network, no real key."""
    import tempfile

    try:
        import jwt  # PyJWT
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.x509.oid import NameOID
    except ImportError as exc:
        die(f"self-test needs PyJWT + cryptography: {exc}")

    # 1. JWT minting matches the ASC contract (ES256, kid, <= 20 min lifetime).
    ec_key = ec.generate_private_key(ec.SECP256R1())
    pem = ec_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")
    with tempfile.NamedTemporaryFile("w", suffix=".p8", delete=False) as handle:
        handle.write(pem)
        p8_path = handle.name
    try:
        token = mint_jwt(p8_path, key_id="TESTKEYID01", issuer_id="test-issuer")
        header = jwt.get_unverified_header(token)
        assert header.get("alg") == "ES256", "expected ES256 header"
        assert header.get("kid") == "TESTKEYID01", "kid not propagated"
        decoded = jwt.decode(
            token, ec_key.public_key(), algorithms=["ES256"], audience=ASC_AUDIENCE
        )
        assert decoded["exp"] - decoded["iat"] <= 20 * 60, "token lifetime too long"
    finally:
        os.unlink(p8_path)

    # 2. Keypair + CSR generation produces a parseable, correctly-subjected CSR.
    key, key_pem, csr_pem = generate_key_and_csr(
        DEFAULT_PASS_TYPE_IDENTIFIER, DEFAULT_CSR_ORGANISATION, DEFAULT_CSR_COUNTRY
    )
    assert "PRIVATE" in key_pem, "private key must be PEM encoded"
    csr = x509.load_pem_x509_csr(csr_pem.encode("utf-8"))
    assert csr.is_signature_valid, "CSR signature must verify"
    assert common_name(csr.subject) == DEFAULT_PASS_TYPE_IDENTIFIER, "CSR CN wrong"
    assert key.key_size == 2048, "Pass Type ID keys must be RSA-2048"

    # 3. certificateContent decoding (base64 DER) round-trips to PEM, and the
    #    key-match assertion accepts the matching key.
    now = datetime.now(timezone.utc)
    leaf = (
        x509.CertificateBuilder()
        .subject_name(csr.subject)
        .issuer_name(csr.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now.replace(tzinfo=None))
        .not_valid_after(now.replace(tzinfo=None) + timedelta(days=365))
        .sign(key, hashes.SHA256())
    )
    content = base64.b64encode(leaf.public_bytes(serialization.Encoding.DER)).decode()
    decoded_pem, decoded_cert = certificate_pem_from_content(content)
    assert "CERTIFICATE" in decoded_pem, "decoded certificate must be PEM"
    assert decoded_cert.serial_number == leaf.serial_number, "serial mismatch"
    assert_certificate_matches_key(decoded_cert, key)
    assert days_until(not_after_utc(decoded_cert)) > 300, "expiry maths wrong"
    assert load_certificate_pem(decoded_pem).serial_number == leaf.serial_number

    # 4. WWDR pinning fails closed on a plausible-but-wrong intermediate.
    wrong = (
        x509.CertificateBuilder()
        .subject_name(
            x509.Name(
                [
                    x509.NameAttribute(NameOID.COMMON_NAME, "Not Apple WWDR"),
                    x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, "G3"),
                ]
            )
        )
        .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Fake Root")]))
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now.replace(tzinfo=None))
        .not_valid_after(now.replace(tzinfo=None) + timedelta(days=365))
        .sign(key, hashes.SHA256())
    )
    try:
        verify_wwdr_g4(wrong)
    except SystemExit:
        pass
    else:  # pragma: no cover - defensive
        die("WWDR pinning accepted a non-G4 intermediate")

    # 5. Argument parsing accepts the documented shape and defaults to dry run.
    ns = parse_args(
        [
            "--p8-path", "/dev/null",
            "--key-id", "K",
            "--issuer-id", "I",
            "--secret-project", "hushh-pda-uat",
            "--secret-project", "hushh-pda",
        ]
    )
    assert ns.apply is False, "provisioning must default to a dry run"
    assert ns.secret_projects == ["hushh-pda-uat", "hushh-pda"], "projects not parsed"
    assert ns.pass_type_identifier == DEFAULT_PASS_TYPE_IDENTIFIER, "identifier wrong"

    log("self-test OK: JWT, CSR, certificate decode, key match, WWDR pinning, args")
    return 0


def main(argv: list[str]) -> int:
    args = parse_args(argv)

    if args.self_test:
        return run_self_test()

    missing_args = [
        name
        for name, value in (
            ("--p8-path", args.p8_path),
            ("--key-id", args.key_id),
            ("--issuer-id", args.issuer_id),
        )
        if not value
    ]
    if missing_args:
        die(f"missing required argument(s): {', '.join(missing_args)}")

    projects = list(dict.fromkeys(args.secret_projects))
    if not projects:
        die("at least one --secret-project is required")
    if not os.path.exists(args.upsert_script):
        die(f"upsert script not found at {args.upsert_script}")

    mode = "apply" if args.apply else "dry-run"
    log(f"mode = {mode}; identifier = {args.pass_type_identifier}")

    # Access is asserted for EVERY target project before anything irreversible
    # happens: a certificate is minted once, so a project discovered to be
    # unwritable afterwards would strand that environment without signing
    # material and burn an Apple certificate slot.
    for project in projects:
        assert_project_access(project)

    missing_by_project = existing_material_state(projects)
    fully_provisioned = all(not absent for absent in missing_by_project.values())

    metadata: dict[str, object] = {
        "mode": mode,
        "pass_type_identifier": args.pass_type_identifier,
        "projects": projects,
        "secrets": list(GCP_PEM_NAMES),
        "renew_within_days": args.renew_within_days,
    }

    if fully_provisioned and not args.force_new_certificate:
        stored = stored_certificate_expiry(projects[0])
        if stored is None:
            log(
                "stored certificate could not be read for an expiry check; "
                "treating it as needing renewal"
            )
        else:
            expiry, serial = stored
            remaining = days_until(expiry)
            metadata.update(
                {
                    "certificate_serial": serial,
                    "not_after": expiry.isoformat(),
                    "days_until_expiry": remaining,
                }
            )
            if remaining > args.renew_within_days:
                metadata["mode"] = "already-provisioned"
                metadata["action"] = "none"
                log(
                    f"all secrets present and the stored certificate is valid for "
                    f"{remaining} more day(s); nothing to do"
                )
                emit(metadata, args.metadata_path)
                return 0
            log(
                f"stored certificate expires in {remaining} day(s) (<= "
                f"{args.renew_within_days}); provisioning a replacement"
            )

    token = mint_jwt(args.p8_path, args.key_id, args.issuer_id)
    pass_type_id, created_pass_type = ensure_pass_type_id(
        token, args.pass_type_identifier, args.pass_type_name, apply=args.apply
    )
    metadata["pass_type_id"] = pass_type_id
    metadata["created_pass_type_id"] = created_pass_type

    key, key_pem, csr_pem = generate_key_and_csr(
        args.pass_type_identifier, args.csr_organisation, args.csr_country
    )

    wwdr_certificate = fetch_wwdr_certificate(args.wwdr_url)
    verify_wwdr_g4(wwdr_certificate)
    wwdr_expiry = not_after_utc(wwdr_certificate)
    metadata["wwdr_not_after"] = wwdr_expiry.isoformat()

    if not args.apply:
        from cryptography.hazmat.primitives import serialization

        # Prove the WWDR PEM encoding works without publishing anything.
        wwdr_certificate.public_bytes(serialization.Encoding.PEM)  # type: ignore[attr-defined]
        metadata["action"] = "dry-run: nothing created, nothing written"
        log(
            "DRY RUN complete: no Apple resource was created and no secret was "
            "written. Re-dispatch with the apply confirmation to provision."
        )
        emit(metadata, args.metadata_path)
        return 0

    if not pass_type_id:
        die("no Pass Type ID resolved; cannot request a certificate")

    from cryptography.hazmat.primitives import serialization

    certificate_resource = create_pass_type_certificate(token, pass_type_id, csr_pem)
    attributes = certificate_resource.get("attributes") or {}
    content = attributes.get("certificateContent")
    if not content:
        die("certificate response carried no certificateContent")

    cert_pem, certificate = certificate_pem_from_content(content)
    assert_certificate_matches_key(certificate, key)
    wwdr_pem = wwdr_certificate.public_bytes(serialization.Encoding.PEM).decode("utf-8")  # type: ignore[attr-defined]

    expiry = not_after_utc(certificate)
    payloads = (
        (GCP_CERT_PEM_NAME, cert_pem),
        (GCP_KEY_PEM_NAME, key_pem),
        (GCP_WWDR_PEM_NAME, wwdr_pem),
    )
    for project in projects:
        for name, payload in payloads:
            write_secret(project, name, payload, args.upsert_script)

    for project in projects:
        absent = [name for name in GCP_PEM_NAMES if not secret_exists(project, name)]
        if absent:
            die(f"project {project} is still missing after write: {', '.join(absent)}")

    metadata.update(
        {
            "action": "provisioned",
            "certificate_id": certificate_resource.get("id"),
            "certificate_serial": format(certificate.serial_number, "x"),  # type: ignore[attr-defined]
            "certificate_name": attributes.get("name"),
            "not_before": not_before_utc(certificate).isoformat(),
            "not_after": expiry.isoformat(),
            "days_until_expiry": days_until(expiry),
        }
    )
    log(
        f"DONE: {args.pass_type_identifier} signing material provisioned to "
        f"{', '.join(projects)}; certificate expires {expiry.date().isoformat()} "
        f"({days_until(expiry)} day(s)). Pass Type ID certificates last about a "
        "year -- schedule the rotation now."
    )
    emit(metadata, args.metadata_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
