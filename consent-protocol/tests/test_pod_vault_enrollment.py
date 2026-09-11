"""Custody requires a fresh, purpose-bound owner proof and verified vault key."""

import asyncio
import base64
import hashlib
import time

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, x25519
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from hushh_mcp.services.pod_authority_store import PodAuthorityStore
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
from hushh_mcp.services.pod_session_authority import canonical_json
from hushh_mcp.services.pod_vault_custody import CustodyBinding, CustodyRefused, PodVaultCustody
from hushh_mcp.services.pod_vault_enrollment import PodVaultEnrollment, WrappedCustodyKey


def b64(raw):
    return base64.b64encode(raw).decode()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure", [None, "proof", "aad", "vault", "revoked", "device", "recipient", "async_validation"]
)
async def test_purpose_bound_enrollment(tmp_path, failure):
    log = PodCommitLog(LocalObjectStore(str(tmp_path)), b"d" * 32, owner_id="owner")
    custody = PodVaultCustody(
        log,
        dek=b"d" * 32,
        binding=CustodyBinding(owner_id="owner", environment="dev", deployment_id="pod"),
        epoch=1,
        instance_id="revision",
    )
    await custody.activate_writer()
    app_key = ec.generate_private_key(ec.SECP256R1())
    recipient = x25519.X25519PrivateKey.generate()
    authority = PodAuthorityStore(log, hushh_id="owner")
    await authority.record_trust(
        {
            "hushh_id": "owner",
            "user_id": "user",
            "subject_id": "app",
            "version": 1,
            "role": "app",
            "environment": "dev",
            "pod_key_id": "pod-key",
            "pod_public_key": b64(
                recipient.public_key().public_bytes(
                    serialization.Encoding.Raw, serialization.PublicFormat.Raw
                )
            ),
            "subject_public_key": b64(
                app_key.public_key().public_bytes(
                    serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
                )
            ),
        }
    )
    ceremony = PodVaultEnrollment(
        custody, recipient=recipient, pod_key_id="pod-key", user_id="user"
    )
    claims = {
        "role": "app",
        "user_id": "user",
        "hushh_id": "owner",
        "epoch": 1,
        "exp": int(time.time()) + 300,
        "subject_id": "app",
        "version": 1,
    }
    if failure == "recipient":
        ceremony = PodVaultEnrollment(
            custody,
            recipient=x25519.X25519PrivateKey.generate(),
            pod_key_id="pod-key",
            user_id="user",
        )
        with pytest.raises(CustodyRefused):
            await ceremony.challenge(claims=claims, key_version=1)
        return
    if failure == "device":
        with pytest.raises(CustodyRefused):
            await ceremony.challenge(claims={**claims, "role": "device"}, key_version=1)
        return
    challenge = await ceremony.challenge(claims=claims, key_version=1)
    ephemeral = x25519.X25519PrivateKey.generate()
    wrapping = hashlib.sha256(ephemeral.exchange(recipient.public_key())).digest()
    aad = canonical_json(challenge).encode() if failure != "aad" else b"other-purpose"
    sealed = AESGCM(wrapping).encrypt(b"n" * 12, b"v" * 32, aad)
    envelope = WrappedCustodyKey(
        sender_public_key=b64(
            ephemeral.public_key().public_bytes(
                serialization.Encoding.Raw, serialization.PublicFormat.Raw
            )
        ),
        wrapped_key=b64(sealed[:-16]),
        nonce=b64(b"n" * 12),
        tag=b64(sealed[-16:]),
    )
    payload = canonical_json(
        {
            "challenge": challenge,
            "envelope_sha256": hashlib.sha256(
                canonical_json(envelope.model_dump()).encode()
            ).hexdigest(),
        }
    )
    proof = b64(app_key.sign(payload.encode(), ec.ECDSA(hashes.SHA256())))
    if failure == "proof":
        proof = b64(app_key.sign(b"ordinary-session-proof", ec.ECDSA(hashes.SHA256())))
    if failure == "revoked":
        await authority.record_tombstone("app", at_version=1)
    validated = []

    def validate(key, version):
        if failure == "vault":
            raise CustodyRefused("vault_key_mismatch")
        assert key == b"v" * 32 and version == 1
        validated.append(True)

    before = len(await log.replay())

    async def async_validate(key, version):
        await asyncio.sleep(0)
        validate(key, version)

    async def enroll():
        return await ceremony.enroll(
            claims=claims,
            challenge_id=challenge["challenge_id"],
            envelope=envelope,
            proof=proof,
            validate_vault_key=async_validate if failure == "async_validation" else validate,
        )

    if failure == "async_validation":
        outcomes = await asyncio.gather(enroll(), enroll(), return_exceptions=True)
        successes = [item for item in outcomes if not isinstance(item, Exception)]
        refusals = [item for item in outcomes if isinstance(item, CustodyRefused)]
        assert len(successes) == 1
        assert len(refusals) == 1
        result = successes[0]
        assert result.active and result.generation == 1 and validated == [True]
    elif failure is not None:
        with pytest.raises(CustodyRefused):
            await enroll()
        assert len(await log.replay()) == before
    else:
        result = await enroll()
        assert result.active and result.generation == 1 and validated == [True]
        with pytest.raises(CustodyRefused, match="expired_or_used"):
            await enroll()
