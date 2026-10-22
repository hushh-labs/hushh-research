"""Synthetic-only Confidential Space attestation and release-claim boundary.

No production route imports this module. A successful result is proof metadata,
not a vault token, KMS credential, decryption key, or active hosted grant. A
future caller must derive ``tls_exporter`` from its end-to-end TLS connection
to the workload (never an HTTP header) and atomically claim the challenge while
rechecking the current owner/grant generation and paired source authorization.

Google's documented OIDC issuer, signing keys and claims:
https://docs.cloud.google.com/confidential-computing/confidential-space/docs/reference/token-validation-endpoint-fields
https://docs.cloud.google.com/confidential-computing/confidential-space/docs/reference/token-claims
https://docs.cloud.google.com/confidential-computing/confidential-space/docs/connect-external-resources
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import http.client
import inspect
import json
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, NoReturn

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

GOOGLE_ATTESTATION_ISSUER = "https://confidentialcomputing.googleapis.com"
GOOGLE_ATTESTATION_JWKS_HOST = "www.googleapis.com"
GOOGLE_ATTESTATION_JWKS_PATH = (
    "/service_accounts/v1/metadata/jwk/signer@confidentialspace-sign.iam.gserviceaccount.com"
)
MAX_CHALLENGE_SECONDS = 300
MAX_TOKEN_AGE_SECONDS = 300
_MAX_JWT_BYTES = 64 * 1024
_MAX_JWKS_BYTES = 64 * 1024
_BASE64URL = re.compile(r"^[A-Za-z0-9_-]+$")
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


class HostedMemoryAttestationRejected(ValueError):
    """Evidence or its single-use synthetic release claim failed closed."""


@dataclass(frozen=True)
class ReleaseChallenge:
    owner_id: str
    grant_id: str
    grant_generation: int
    source_kind: str
    source_id: str
    challenge_id: str
    challenge_random: bytes
    tls_exporter: bytes
    issued_at: int
    expires_at: int


@dataclass(frozen=True)
class AttestationPolicy:
    audience: str
    image_digest: str
    project_number: str
    workload_service_account: str
    hardware_model: str
    argv: tuple[str, ...]
    environment: Mapping[str, str] = field(default_factory=dict)
    restart_policy: str = "Never"


@dataclass(frozen=True)
class VerifiedHostedMemoryAttestation:
    """Verifier result, never standalone authority for a key or worker lease."""

    owner_id: str
    grant_id: str
    grant_generation: int
    source_kind: str
    source_id: str
    challenge_id: str
    nonce_digest: str
    attested_subject: str
    image_digest: str
    expires_at: int


def _reject() -> NoReturn:
    # Do not copy a token, claim, key, owner identifier, or source value into
    # an exception that may be logged by an API boundary later.
    raise HostedMemoryAttestationRejected("hosted memory attestation rejected")


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _reject()
        result[key] = value
    return result


def _decode_json(raw: bytes) -> dict[str, Any]:
    try:
        parsed = json.loads(raw, object_pairs_hook=_strict_object)
    except (ValueError, UnicodeError):
        _reject()
    if not isinstance(parsed, dict):
        _reject()
    return parsed


def _decode_base64url(value: Any) -> bytes:
    if not isinstance(value, str) or not value or not _BASE64URL.fullmatch(value):
        _reject()
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, binascii.Error):
        _reject()
    if base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=") != value:
        _reject()
    return decoded


def _nonce_for(challenge: ReleaseChallenge) -> str:
    fields: tuple[bytes, ...] = (
        b"hosted-memory-release-v1",
        challenge.owner_id.encode("utf-8"),
        challenge.grant_id.encode("utf-8"),
        str(challenge.grant_generation).encode("ascii"),
        challenge.source_kind.encode("utf-8"),
        challenge.source_id.encode("utf-8"),
        challenge.challenge_id.encode("utf-8"),
        challenge.challenge_random,
        challenge.tls_exporter,
    )
    digest = hashlib.sha256()
    for value in fields:
        digest.update(len(value).to_bytes(4, "big"))
        digest.update(value)
    # A 64-byte ASCII value fits Google's documented nonce bound.
    return digest.hexdigest()


def _validate_inputs(challenge: ReleaseChallenge, policy: AttestationPolicy, now: int) -> None:
    if (
        not all(
            isinstance(value, str) and 0 < len(value) <= 128
            for value in (
                challenge.owner_id,
                challenge.grant_id,
                challenge.source_kind,
                challenge.source_id,
                challenge.challenge_id,
            )
        )
        or type(challenge.grant_generation) is not int
        or challenge.grant_generation < 1
        or not isinstance(challenge.challenge_random, bytes)
        or len(challenge.challenge_random) < 32
        or not isinstance(challenge.tls_exporter, bytes)
        or len(challenge.tls_exporter) < 32
        or type(challenge.issued_at) is not int
        or type(challenge.expires_at) is not int
        or type(now) is not int
        or challenge.issued_at > now
        or challenge.expires_at <= now
        or not 0 < challenge.expires_at - challenge.issued_at <= MAX_CHALLENGE_SECONDS
    ):
        _reject()
    if (
        not isinstance(policy.audience, str)
        or not policy.audience.startswith("https://")
        or policy.audience in {"https://sts.googleapis.com", "https://sts.google.com"}
        or not isinstance(policy.image_digest, str)
        or not _DIGEST.fullmatch(policy.image_digest)
        or not isinstance(policy.project_number, str)
        or not policy.project_number.isdecimal()
        or not policy.project_number
        or not isinstance(policy.workload_service_account, str)
        or not policy.workload_service_account.endswith(".gserviceaccount.com")
        or policy.hardware_model not in {"GCP_AMD_SEV", "GCP_AMD_SEV_ES", "GCP_INTEL_TDX"}
        or not isinstance(policy.argv, tuple)
        or not policy.argv
        or not all(isinstance(arg, str) and arg for arg in policy.argv)
        or not isinstance(policy.environment, Mapping)
        or not all(
            isinstance(key, str) and isinstance(value, str)
            for key, value in policy.environment.items()
        )
        or policy.restart_policy not in {"Never", "OnFailure", "Always"}
    ):
        _reject()


def _fetch_google_jwks() -> dict[str, Any]:
    # The key source is fixed. In particular, no token header may supply jku,
    # x5u or a caller-selected JWK set. Reject redirects rather than following
    # one to another host or resource.
    connection = http.client.HTTPSConnection(GOOGLE_ATTESTATION_JWKS_HOST, timeout=4)
    try:
        connection.request(
            "GET", GOOGLE_ATTESTATION_JWKS_PATH, headers={"Accept": "application/json"}
        )
        response = connection.getresponse()
        if response.status != 200:
            _reject()
        raw = response.read(_MAX_JWKS_BYTES + 1)
    except (OSError, ValueError, http.client.HTTPException):
        _reject()
    finally:
        connection.close()
    if len(raw) > _MAX_JWKS_BYTES:
        _reject()
    return _decode_json(raw)


def _verified_claims(token: str, jwks: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(token, str) or len(token) > _MAX_JWT_BYTES:
        _reject()
    parts = token.split(".")
    if len(parts) != 3:
        _reject()
    header = _decode_json(_decode_base64url(parts[0]))
    if (
        header.get("alg") != "RS256"
        or not isinstance(header.get("kid"), str)
        or not header["kid"]
        or header.get("typ", "JWT") != "JWT"
        or any(key in header for key in ("jwk", "jku", "x5u", "x5c", "crit"))
    ):
        _reject()
    keys = jwks.get("keys")
    if not isinstance(keys, list) or len(keys) > 32:
        _reject()
    matching = [key for key in keys if isinstance(key, dict) and key.get("kid") == header["kid"]]
    if len(matching) != 1:
        _reject()
    key = matching[0]
    if (
        key.get("kty") != "RSA"
        or key.get("alg", "RS256") != "RS256"
        or key.get("use", "sig") != "sig"
    ):
        _reject()
    n = int.from_bytes(_decode_base64url(key.get("n", "")), "big")
    e = int.from_bytes(_decode_base64url(key.get("e", "")), "big")
    if n.bit_length() < 2048 or e < 3 or e > 2**32 or e % 2 == 0:
        _reject()
    try:
        public_key = rsa.RSAPublicNumbers(e, n).public_key()
        public_key.verify(
            _decode_base64url(parts[2]),
            f"{parts[0]}.{parts[1]}".encode("ascii"),
            padding.PKCS1v15(),
            hashes.SHA256(),
        )
    except (InvalidSignature, ValueError, TypeError):
        _reject()
    return _decode_json(_decode_base64url(parts[1]))


def _check_claims(
    claims: Mapping[str, Any],
    challenge: ReleaseChallenge,
    policy: AttestationPolicy,
    now: int,
) -> VerifiedHostedMemoryAttestation:
    iat, nbf, exp = (claims.get(name) for name in ("iat", "nbf", "exp"))
    if type(iat) is not int or type(nbf) is not int or type(exp) is not int:
        _reject()
    if (
        iat > now + 30
        or iat < challenge.issued_at - 30
        or now - iat > MAX_TOKEN_AGE_SECONDS
        or nbf > now
        or exp <= now
        or exp <= iat
        or exp - iat > 3660
        or claims.get("iss") != GOOGLE_ATTESTATION_ISSUER
        or claims.get("aud") != policy.audience
        or claims.get("swname") != "CONFIDENTIAL_SPACE"
        or claims.get("dbgstat") != "disabled-since-boot"
        or claims.get("secboot") is not True
        or claims.get("oemid") != 11129
        or claims.get("hwmodel") != policy.hardware_model
        or not isinstance(claims.get("sub"), str)
        or not claims["sub"].startswith("https://www.googleapis.com/compute/v1/projects/")
    ):
        _reject()
    nonce = _nonce_for(challenge)
    signed_nonce = claims.get("eat_nonce")
    if signed_nonce != nonce and signed_nonce != [nonce]:
        _reject()
    submods = claims.get("submods")
    if not isinstance(submods, dict):
        _reject()
    container = submods.get("container")
    gce = submods.get("gce")
    confidential_space = submods.get("confidential_space")
    if (
        not isinstance(container, dict)
        or not isinstance(gce, dict)
        or not isinstance(confidential_space, dict)
    ):
        _reject()
    support_attributes = confidential_space.get("support_attributes")
    service_accounts = claims.get("google_service_accounts")
    if not isinstance(support_attributes, list) or not isinstance(service_accounts, list):
        _reject()
    if (
        container.get("image_digest") != policy.image_digest
        or container.get("args") != list(policy.argv)
        or container.get("env", {}) != dict(policy.environment)
        or container.get("cmd_override", []) != []
        or container.get("env_override", {}) != {}
        or container.get("restart_policy", "Never") != policy.restart_policy
        or gce.get("project_number") != policy.project_number
        or "STABLE" not in support_attributes
        or confidential_space.get("monitoring_enabled") != {"memory": False}
        or policy.workload_service_account not in service_accounts
    ):
        _reject()
    return VerifiedHostedMemoryAttestation(
        owner_id=challenge.owner_id,
        grant_id=challenge.grant_id,
        grant_generation=challenge.grant_generation,
        source_kind=challenge.source_kind,
        source_id=challenge.source_id,
        challenge_id=challenge.challenge_id,
        nonce_digest=nonce,
        attested_subject=claims["sub"],
        image_digest=policy.image_digest,
        expires_at=min(exp, challenge.expires_at),
    )


def _verify_with_jwks(
    *,
    token: str,
    challenge: ReleaseChallenge,
    policy: AttestationPolicy,
    jwks: Mapping[str, Any],
    now: int,
) -> VerifiedHostedMemoryAttestation:
    """Deterministic seam for signed synthetic fixtures; not a public key source."""
    _validate_inputs(challenge, policy, now)
    return _check_claims(_verified_claims(token, jwks), challenge, policy, now)


def verify_and_claim_synthetic_release(
    *,
    token: str,
    challenge: ReleaseChallenge,
    policy: AttestationPolicy,
    atomic_claim: Callable[[VerifiedHostedMemoryAttestation, int], bool],
    now: int | None = None,
    synthetic_test_only: bool = False,
) -> VerifiedHostedMemoryAttestation:
    """Verify a Google token, then atomically consume a synthetic challenge.

    ``atomic_claim`` must recheck the authoritative owner, active paired grant,
    grant generation, selected source kind and ID, challenge expiry, and unused
    nonce in one transaction before marking it consumed. This helper returns no
    key bytes.
    It has no production route or KMS integration. The explicit test-only gate
    keeps it disabled by default until a separately reviewed runtime exists.
    """
    if synthetic_test_only is not True:
        _reject()
    observed_at = int(time.time()) if now is None else now
    _validate_inputs(challenge, policy, observed_at)
    proof = _verify_with_jwks(
        token=token,
        challenge=challenge,
        policy=policy,
        jwks=_fetch_google_jwks(),
        now=observed_at,
    )
    claimed = atomic_claim(proof, observed_at)
    if type(claimed) is not bool or claimed is not True:
        # A coroutine is truthy without executing its transaction. Reject it
        # and close it so the failed synthetic call does not leak a warning.
        if inspect.iscoroutine(claimed):
            claimed.close()
        _reject()
    return proof
