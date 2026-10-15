"""Signed synthetic evidence for the hosted memory key-release boundary."""

from __future__ import annotations

import base64
import json
from dataclasses import replace

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from hushh_mcp.services import hosted_memory_attestation as attestation

NOW = 2_000_000_000
DIGEST = "sha256:" + "a" * 64


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _token(private_key, claims, header=None) -> str:
    header = header or {"alg": "RS256", "kid": "synthetic-google-key", "typ": "JWT"}
    signing_input = ".".join(
        _b64(json.dumps(part, sort_keys=True, separators=(",", ":")).encode())
        for part in (header, claims)
    )
    signature = private_key.sign(signing_input.encode("ascii"), padding.PKCS1v15(), hashes.SHA256())
    return f"{signing_input}.{_b64(signature)}"


@pytest.fixture
def signed_evidence(monkeypatch):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_numbers = private_key.public_key().public_numbers()
    jwks = {
        "keys": [
            {
                "kid": "synthetic-google-key",
                "kty": "RSA",
                "alg": "RS256",
                "use": "sig",
                "n": _b64(public_numbers.n.to_bytes(256, "big")),
                "e": _b64(public_numbers.e.to_bytes(3, "big")),
            }
        ]
    }
    challenge = attestation.ReleaseChallenge(
        owner_id="owner-a",
        grant_id="grant-1",
        grant_generation=3,
        source_kind="curated_oauth_connector",
        source_id="gmail-provider",
        challenge_id="challenge-1",
        challenge_random=b"c" * 32,
        tls_exporter=b"t" * 32,
        issued_at=NOW - 20,
        expires_at=NOW + 120,
    )
    policy = attestation.AttestationPolicy(
        audience="https://memory.example.test/attestation",
        image_digest=DIGEST,
        project_number="123456789",
        workload_service_account="memory-worker@example.iam.gserviceaccount.com",
        hardware_model="GCP_AMD_SEV",
        argv=("/app/worker",),
    )
    claims = {
        "iss": attestation.GOOGLE_ATTESTATION_ISSUER,
        "aud": policy.audience,
        "sub": "https://www.googleapis.com/compute/v1/projects/example/zones/us-central1-a/instances/123",
        "iat": NOW - 10,
        "nbf": NOW - 10,
        "exp": NOW + 3600,
        "swname": "CONFIDENTIAL_SPACE",
        "dbgstat": "disabled-since-boot",
        "secboot": True,
        "oemid": 11129,
        "hwmodel": policy.hardware_model,
        "eat_nonce": attestation._nonce_for(challenge),
        "google_service_accounts": [policy.workload_service_account],
        "submods": {
            "container": {
                "image_digest": policy.image_digest,
                "args": list(policy.argv),
                "env": {},
                "cmd_override": [],
                "env_override": {},
                "restart_policy": "Never",
            },
            "gce": {"project_number": policy.project_number},
            "confidential_space": {
                "support_attributes": ["STABLE"],
                "monitoring_enabled": {"memory": False},
            },
        },
    }
    monkeypatch.setattr(attestation, "_fetch_google_jwks", lambda: jwks)
    return private_key, claims, challenge, policy, jwks


def _claim_once():
    used: set[tuple[str, int, str]] = set()

    def claim(proof: attestation.VerifiedHostedMemoryAttestation, now: int) -> bool:
        key = (proof.grant_id, proof.grant_generation, proof.nonce_digest)
        if now >= proof.expires_at or key in used:
            return False
        used.add(key)
        return True

    return claim


def test_valid_signed_evidence_claims_once_and_carries_only_proof(signed_evidence):
    private_key, claims, challenge, policy, _jwks = signed_evidence
    token = _token(private_key, claims)
    claim = _claim_once()
    proof = attestation.verify_and_claim_synthetic_release(
        token=token,
        challenge=challenge,
        policy=policy,
        atomic_claim=claim,
        now=NOW,
        synthetic_test_only=True,
    )
    assert proof == attestation.VerifiedHostedMemoryAttestation(
        owner_id="owner-a",
        grant_id="grant-1",
        grant_generation=3,
        source_kind="curated_oauth_connector",
        source_id="gmail-provider",
        challenge_id="challenge-1",
        nonce_digest=attestation._nonce_for(challenge),
        attested_subject=claims["sub"],
        image_digest=DIGEST,
        expires_at=challenge.expires_at,
    )
    with pytest.raises(attestation.HostedMemoryAttestationRejected):
        attestation.verify_and_claim_synthetic_release(
            token=token,
            challenge=challenge,
            policy=policy,
            atomic_claim=claim,
            now=NOW,
            synthetic_test_only=True,
        )


def test_synthetic_protocol_is_disabled_by_default(signed_evidence):
    private_key, claims, challenge, policy, _jwks = signed_evidence
    invoked = False

    def claim(_proof, _now):
        nonlocal invoked
        invoked = True
        return True

    with pytest.raises(attestation.HostedMemoryAttestationRejected):
        attestation.verify_and_claim_synthetic_release(
            token=_token(private_key, claims),
            challenge=challenge,
            policy=policy,
            atomic_claim=claim,
            now=NOW,
        )
    assert invoked is False


@pytest.mark.parametrize(
    ("mutate", "value"),
    [
        ("image_digest", "sha256:" + "b" * 64),
        ("dbgstat", "enabled"),
        ("swname", "GCE"),
        ("aud", "https://other.example.test/attestation"),
        ("iss", "https://not-google.example.test"),
        ("exp", NOW - 1),
        ("iat", NOW - 500),
        ("monitoring_enabled", {"memory": True}),
        ("cmd_override", ["/bin/sh"]),
        ("env_override", {"LOG_VALUES": "true"}),
        ("project_number", "987654321"),
        ("service_accounts", ["other@example.iam.gserviceaccount.com"]),
    ],
)
def test_signed_wrong_workload_or_expired_evidence_never_claims(signed_evidence, mutate, value):
    private_key, original, challenge, policy, _jwks = signed_evidence
    claims = json.loads(json.dumps(original))
    if mutate == "image_digest":
        claims["submods"]["container"]["image_digest"] = value
    elif mutate == "monitoring_enabled":
        claims["submods"]["confidential_space"]["monitoring_enabled"] = value
    elif mutate in {"cmd_override", "env_override"}:
        claims["submods"]["container"][mutate] = value
    elif mutate == "project_number":
        claims["submods"]["gce"]["project_number"] = value
    elif mutate == "service_accounts":
        claims["google_service_accounts"] = value
    else:
        claims[mutate] = value
    invoked = False

    def claim(_proof, _now):
        nonlocal invoked
        invoked = True
        return True

    with pytest.raises(attestation.HostedMemoryAttestationRejected):
        attestation.verify_and_claim_synthetic_release(
            token=_token(private_key, claims),
            challenge=challenge,
            policy=policy,
            atomic_claim=claim,
            now=NOW,
            synthetic_test_only=True,
        )
    assert invoked is False


@pytest.mark.parametrize(
    "change",
    [
        {"owner_id": "owner-b"},
        {"grant_id": "grant-2"},
        {"grant_generation": 4},
        {"source_kind": "document_earning"},
        {"source_id": "drive-provider"},
        {"tls_exporter": b"u" * 32},
        {"challenge_random": b"d" * 32},
    ],
)
def test_signed_nonce_is_bound_to_owner_grant_generation_source_and_tls_channel(
    signed_evidence, change
):
    private_key, claims, challenge, policy, _jwks = signed_evidence
    with pytest.raises(attestation.HostedMemoryAttestationRejected):
        attestation.verify_and_claim_synthetic_release(
            token=_token(private_key, claims),
            challenge=replace(challenge, **change),
            policy=policy,
            atomic_claim=lambda _proof, _now: True,
            now=NOW,
            synthetic_test_only=True,
        )


def test_expired_challenge_and_tampered_signature_fail_closed(signed_evidence):
    private_key, claims, challenge, policy, _jwks = signed_evidence
    token = _token(private_key, claims)
    with pytest.raises(attestation.HostedMemoryAttestationRejected):
        attestation.verify_and_claim_synthetic_release(
            token=token,
            challenge=replace(challenge, expires_at=NOW),
            policy=policy,
            atomic_claim=lambda _proof, _now: True,
            now=NOW,
            synthetic_test_only=True,
        )
    signing_input, encoded_signature = token.rsplit(".", 1)
    signature = bytearray(base64.urlsafe_b64decode(encoded_signature + "=="))
    signature[0] ^= 1
    tampered = f"{signing_input}.{_b64(signature)}"
    with pytest.raises(attestation.HostedMemoryAttestationRejected):
        attestation.verify_and_claim_synthetic_release(
            token=tampered,
            challenge=challenge,
            policy=policy,
            atomic_claim=lambda _proof, _now: True,
            now=NOW,
            synthetic_test_only=True,
        )


def test_untrusted_header_key_and_missing_google_key_fail_closed(signed_evidence):
    private_key, claims, challenge, policy, jwks = signed_evidence
    token = _token(
        private_key,
        claims,
        header={"alg": "RS256", "kid": "synthetic-google-key", "jku": "https://attacker.test/keys"},
    )
    with pytest.raises(attestation.HostedMemoryAttestationRejected):
        attestation._verify_with_jwks(
            token=token, challenge=challenge, policy=policy, jwks=jwks, now=NOW
        )
    with pytest.raises(attestation.HostedMemoryAttestationRejected):
        attestation._verify_with_jwks(
            token=_token(private_key, claims),
            challenge=challenge,
            policy=policy,
            jwks={"keys": []},
            now=NOW,
        )


@pytest.mark.parametrize(
    ("claim", "value"),
    [
        ("support_attributes", None),
        ("service_accounts", None),
    ],
)
def test_malformed_signed_claims_reject_cleanly(signed_evidence, claim, value):
    private_key, original, challenge, policy, _jwks = signed_evidence
    claims = json.loads(json.dumps(original))
    if claim == "support_attributes":
        claims["submods"]["confidential_space"][claim] = value
    else:
        claims["google_service_accounts"] = value
    with pytest.raises(attestation.HostedMemoryAttestationRejected):
        attestation.verify_and_claim_synthetic_release(
            token=_token(private_key, claims),
            challenge=challenge,
            policy=policy,
            atomic_claim=lambda _proof, _now: True,
            now=NOW,
            synthetic_test_only=True,
        )


def test_claim_callback_must_return_synchronous_true_bool(signed_evidence):
    private_key, claims, challenge, policy, _jwks = signed_evidence

    async def unexecuted_claim(_proof, _now):
        return False

    for claim in (unexecuted_claim, lambda _proof, _now: 1):
        with pytest.raises(attestation.HostedMemoryAttestationRejected):
            attestation.verify_and_claim_synthetic_release(
                token=_token(private_key, claims),
                challenge=challenge,
                policy=policy,
                atomic_claim=claim,
                now=NOW,
                synthetic_test_only=True,
            )
