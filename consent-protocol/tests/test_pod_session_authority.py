"""Owner-local admission: the eleven negative controls, each with its exact refusal.

The ledger item ``local-authority-refuses-foreign-and-stale`` points here. Every
control below asserts two things: the refusal code the authority gives, and that
NO trust record reached the log. A refusal that leaked a record would be a
refusal in name only.
"""

from __future__ import annotations

import base64
import json
import time

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from hushh_mcp.consent import token_signing
from hushh_mcp.services import pod_session_authority as psa
from hushh_mcp.services.pod_authority_store import (
    IncarnationLease,
    PodAuthorityStore,
    claim_incarnation,
)
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog

OWNER = "ha1_owner"
USER = "firebase-uid-1"
ENV = "dev"
POD_KEY_ID = "podk_0123456789abcdef"
POD_PUBLIC_KEY = base64.b64encode(b"P" * 32).decode("ascii")
POD_URL = "https://one-pod-ha1-owner-abc.a.run.app"
DEK = b"D" * 32
KID = "hushh-consent-test"


# -- fixtures ----------------------------------------------------------------------------


@pytest.fixture
def hub_key(monkeypatch):
    """The hub's Ed25519 signing key, and the public map every pod is rendered with."""
    private = Ed25519PrivateKey.generate()
    seed = private.private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )
    public = private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    monkeypatch.setenv("CONSENT_ED25519_PRIVATE_KEY", base64.b64encode(seed).decode())
    monkeypatch.setenv("CONSENT_ED25519_KID", KID)
    monkeypatch.setenv(
        "CONSENT_ED25519_PUBLIC_KEYS", json.dumps({KID: base64.b64encode(public).decode()})
    )
    monkeypatch.delenv("CONSENT_TOKEN_SIGNING_ALG", raising=False)
    token_signing.reset_caches()
    yield private
    token_signing.reset_caches()


class Subject:
    """A device or app installation holding a P-256 key, like a trusted device."""

    def __init__(self, subject_id: str, platform: str) -> None:
        self.subject_id = subject_id
        self.platform = platform
        self._key = ec.generate_private_key(ec.SECP256R1())
        self.public_key_b64 = base64.b64encode(
            self._key.public_key().public_bytes(
                serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
            )
        ).decode("ascii")

    def sign(self, payload: str) -> str:
        return base64.b64encode(
            self._key.sign(payload.encode("utf-8"), ec.ECDSA(hashes.SHA256()))
        ).decode("ascii")


def _binding(subject: Subject, *, version=1, role=None, scopes=None, **overrides) -> dict:
    now = int(time.time() * 1000)
    inferred_role = psa.role_for_platform(subject.platform)
    body = {
        "kind": psa.BINDING_KIND,
        "hushh_id": OWNER,
        "user_id": USER,
        "environment": ENV,
        "pod_key_id": POD_KEY_ID,
        "pod_public_key": POD_PUBLIC_KEY,
        "url": POD_URL,
        "subject_id": subject.subject_id,
        "subject_kind": role or inferred_role,
        "subject_public_key": subject.public_key_b64,
        "platform": subject.platform,
        "role": role or inferred_role,
        "scopes": list(
            scopes
            if scopes is not None
            else (psa.APP_SCOPES if inferred_role == "app" else psa.DEVICE_INFERENCE_SCOPES)
        ),
        "version": version,
        "issued_at_ms": now,
        "expires_at_ms": now + 30 * 24 * 3600 * 1000,
    }
    body.update(overrides)
    return body


def _sign(binding: dict) -> str:
    return token_signing.sign_payload(
        psa.canonical_json(binding), hmac_key="unused", require_asymmetric=True
    )


class World:
    """One pod, one log, one incarnation, and the helpers to drive admission."""

    def __init__(self, tmp_path, *, name="pod", environment=ENV) -> None:
        self.object_store = LocalObjectStore(str(tmp_path / name))
        self.log = PodCommitLog(self.object_store, DEK, owner_id=OWNER)
        self.store = PodAuthorityStore(self.log, hushh_id=OWNER)
        self.environment = environment
        self.authority: psa.PodSessionAuthority | None = None

    async def boot(self, *, instance="rev-a") -> psa.PodSessionAuthority:
        incarnation = await claim_incarnation(self.object_store, DEK, instance_id=instance)
        await self.store.load()
        self.authority = psa.PodSessionAuthority(
            store=self.store,
            lease=IncarnationLease(self.object_store, incarnation),
            dek=DEK,
            pod_key_id=POD_KEY_ID,
            pod_public_key=POD_PUBLIC_KEY,
            environment=self.environment,
        )
        return self.authority

    async def records(self) -> int:
        return len(await self.log.replay())

    async def admit(self, subject: Subject, binding: dict, signature: str | None = None, **kw):
        authority = self.authority
        assert authority is not None
        challenge = authority.create_challenge(subject.subject_id)
        proof = subject.sign(challenge["signing_payload"])
        args = {
            "binding": binding,
            "signature": signature if signature is not None else _sign(binding),
            "challenge_id": challenge["challenge_id"],
            "nonce": challenge["nonce"],
            "proof": proof,
            "epoch": authority.epoch,
        }
        args.update(kw)
        return await authority.admit(**args)


async def _refused(world: World, subject: Subject, binding: dict, code: str, **kw) -> None:
    before = await world.records()
    with pytest.raises(psa.PodSessionRefused) as caught:
        await world.admit(subject, binding, **kw)
    assert caught.value.code == code, (caught.value.code, caught.value.detail)
    assert await world.records() == before, "a refusal must append nothing"
    assert world.store.subject(subject.subject_id).state != "trusted" or code in {
        "stale_version",
        "replayed_proof",
    }


# -- the happy path first, so the controls below are measured against it -------------


async def test_a_signed_binding_and_a_fresh_proof_open_a_session(tmp_path, hub_key):
    world = World(tmp_path)
    await world.boot()
    app = Subject("tdv_app_web_1", "web")

    token, claims = await world.admit(app, _binding(app))

    assert token.startswith(psa.SESSION_PREFIX)
    assert claims["role"] == "app" and claims["user_id"] == USER
    assert world.store.subject(app.subject_id).state == "trusted"
    verified = world.authority.verify_session(token, expected_role="app")
    assert verified["sid"] == claims["sid"]

    verdict = await world.authority.local_verifier(claims)(
        world.authority.local_token(claims), expected_scope="pkm.read"
    )
    assert verdict.valid and verdict.available
    assert verdict.user_id == USER and verdict.hushh_id == OWNER


async def test_the_trust_survives_a_restart_and_the_session_still_verifies(tmp_path, hub_key):
    world = World(tmp_path)
    await world.boot()
    app = Subject("tdv_app_web_1", "web")
    token, _ = await world.admit(app, _binding(app))

    again = World(tmp_path)
    await again.boot(instance="rev-b")
    assert again.store.subject(app.subject_id).state == "trusted"
    assert again.authority.verify_session(token)["subject_id"] == app.subject_id


# -- K2: the eleven negative controls ---------------------------------------------------


async def test_foreign_owner_is_refused(tmp_path, hub_key):
    world = World(tmp_path)
    await world.boot()
    app = Subject("tdv_app_web_1", "web")
    await _refused(world, app, _binding(app, hushh_id="ha1_someone_else"), "foreign_owner")


async def test_foreign_environment_is_refused(tmp_path, hub_key):
    world = World(tmp_path)
    await world.boot()
    app = Subject("tdv_app_web_1", "web")
    await _refused(world, app, _binding(app, environment="uat"), "foreign_environment")


async def test_foreign_deployment_is_refused(tmp_path, hub_key):
    world = World(tmp_path)
    await world.boot()
    app = Subject("tdv_app_web_1", "web")
    await _refused(world, app, _binding(app, pod_key_id="podk_other"), "foreign_deployment")
    other_key = base64.b64encode(b"Q" * 32).decode("ascii")
    await _refused(world, app, _binding(app, pod_public_key=other_key), "foreign_deployment")


async def test_a_forged_role_is_refused(tmp_path, hub_key):
    world = World(tmp_path)
    await world.boot()
    device = Subject("tdv_mac_1", "macos")
    # A device that talked the hub into signing it as an app: platform says otherwise.
    await _refused(world, device, _binding(device, role="app", subject_kind="app"), "forged_role")
    # A role edited after signing is a signature failure, never a role decision.
    honest = _binding(device)
    signature = _sign(honest)
    tampered = {**honest, "role": "app", "subject_kind": "app"}
    await _refused(world, device, tampered, "bad_signature", signature=signature)
    # Scopes edited after signing fall the same way.
    widened = {**honest, "scopes": [*honest["scopes"], "pkm.read"]}
    await _refused(world, device, widened, "bad_signature", signature=signature)


async def test_an_unknown_key_id_is_refused(tmp_path, hub_key):
    world = World(tmp_path)
    await world.boot()
    app = Subject("tdv_app_web_1", "web")
    binding = _binding(app)
    signature = _sign(binding).replace(f"ed25519.{KID}.", "ed25519.hushh-consent-rogue.")
    await _refused(world, app, binding, "unknown_key_id", signature=signature)


async def test_a_replayed_proof_is_refused(tmp_path, hub_key):
    world = World(tmp_path)
    await world.boot()
    app = Subject("tdv_app_web_1", "web")
    authority = world.authority
    challenge = authority.create_challenge(app.subject_id)
    proof = app.sign(challenge["signing_payload"])
    args = {
        "binding": _binding(app),
        "signature": _sign(_binding(app)),
        "challenge_id": challenge["challenge_id"],
        "nonce": challenge["nonce"],
        "proof": proof,
        "epoch": authority.epoch,
    }
    args["signature"] = _sign(args["binding"])
    await authority.admit(**args)
    after_first = await world.records()

    # The same binding again is stale by version; that refusal comes first and is
    # its own control above. A NEWER binding with the consumed challenge isolates
    # the replay: the proof was spent the moment it was accepted.
    newer = _binding(app, version=2)
    with pytest.raises(psa.PodSessionRefused) as caught:
        await authority.admit(**{**args, "binding": newer, "signature": _sign(newer)})
    assert caught.value.code == "replayed_proof"
    assert await world.records() == after_first
    assert world.store.subject(app.subject_id).trust.version == 1


async def test_a_proof_from_another_incarnation_is_refused(tmp_path, hub_key):
    old = World(tmp_path)
    await old.boot(instance="rev-a")
    app = Subject("tdv_app_web_1", "web")
    stale_challenge = old.authority.create_challenge(app.subject_id)
    stale_proof = app.sign(stale_challenge["signing_payload"])

    new = World(tmp_path)
    await new.boot(instance="rev-b")
    assert new.authority.epoch == old.authority.epoch + 1
    before = await new.records()
    binding = _binding(app)
    with pytest.raises(psa.PodSessionRefused) as caught:
        await new.authority.admit(
            binding=binding,
            signature=_sign(binding),
            challenge_id=stale_challenge["challenge_id"],
            nonce=stale_challenge["nonce"],
            proof=stale_proof,
            epoch=old.authority.epoch,
        )
    assert caught.value.code == "foreign_incarnation"
    assert await new.records() == before
    # The same stale challenge with the new epoch stamped on it is simply unknown here.
    with pytest.raises(psa.PodSessionRefused) as caught:
        await new.authority.admit(
            binding=binding,
            signature=_sign(binding),
            challenge_id=stale_challenge["challenge_id"],
            nonce=stale_challenge["nonce"],
            proof=stale_proof,
            epoch=new.authority.epoch,
        )
    assert caught.value.code == "replayed_proof"
    assert await new.records() == before


async def test_an_expired_binding_and_an_expired_session_are_refused(tmp_path, hub_key):
    world = World(tmp_path)
    await world.boot()
    app = Subject("tdv_app_web_1", "web")
    await _refused(world, app, _binding(app, expires_at_ms=int(time.time() * 1000) - 1), "expired")

    clock = {"now": time.time()}
    world.authority._clock = lambda: clock["now"]
    token, _ = await world.admit(app, _binding(app))
    clock["now"] += psa.SESSION_TTL_SECONDS + 1
    with pytest.raises(psa.PodSessionRefused) as caught:
        world.authority.verify_session(token)
    assert caught.value.code == "expired"


async def test_a_revoked_subject_is_refused_everywhere(tmp_path, hub_key):
    world = World(tmp_path)
    await world.boot()
    app = Subject("tdv_app_web_1", "web")
    token, claims = await world.admit(app, _binding(app, version=2))
    verifier = world.authority.local_verifier(claims)

    await world.authority.revoke_subject(app.subject_id, reason="owner_revoked")

    with pytest.raises(psa.PodSessionRefused) as caught:
        world.authority.verify_session(token)
    assert caught.value.code == "revoked"
    verdict = await verifier(world.authority.local_token(claims), expected_scope="pkm.read")
    assert verdict.valid is False and verdict.available is True
    # Re-presenting the binding that was revoked appends nothing.
    await _refused(world, app, _binding(app, version=2), "revoked")
    await _refused(world, app, _binding(app, version=1), "revoked")
    # A newer hub-signed binding re-admits: owner recovery.
    token3, _ = await world.admit(app, _binding(app, version=3))
    assert world.authority.verify_session(token3)["version"] == 3


async def test_a_stale_binding_version_is_refused(tmp_path, hub_key):
    world = World(tmp_path)
    await world.boot()
    app = Subject("tdv_app_web_1", "web")
    await world.admit(app, _binding(app, version=2))
    await _refused(world, app, _binding(app, version=2), "stale_version")
    await _refused(world, app, _binding(app, version=1), "stale_version")


async def test_a_hub_consent_token_is_never_local_authority(tmp_path, hub_key):
    world = World(tmp_path)
    await world.boot()
    app = Subject("tdv_app_web_1", "web")
    hct = "HCT:" + base64.urlsafe_b64encode(b"uid|agent|scope|1|2").decode() + ".deadbeef"

    with pytest.raises(psa.PodSessionRefused) as caught:
        world.authority.verify_session(hct)
    assert caught.value.code == "not_local_authority"

    _, claims = await world.admit(app, _binding(app))
    verdict = await world.authority.local_verifier(claims)(hct, expected_scope="pkm.read")
    assert verdict.valid is False and verdict.available is True

    # An HMAC-signed binding (the hub's symmetric algorithm) is a downgrade, refused.
    binding = _binding(Subject("tdv_app_web_2", "web"))
    hmac_signature = token_signing.hmac_signature(psa.canonical_json(binding), "hub-key")
    await _refused(
        world, Subject("tdv_app_web_2", "web"), binding, "bad_signature", signature=hmac_signature
    )


async def test_roles_do_not_cross_surfaces(tmp_path, hub_key):
    world = World(tmp_path)
    await world.boot()
    device = Subject("tdv_mac_1", "macos")
    app = Subject("tdv_app_web_1", "web")
    device_token, _ = await world.admit(device, _binding(device))
    app_token, _ = await world.admit(app, _binding(app))

    with pytest.raises(psa.PodSessionRefused) as caught:
        world.authority.verify_session(device_token, expected_role="app")
    assert caught.value.code == "role_mismatch"
    with pytest.raises(psa.PodSessionRefused) as caught:
        world.authority.verify_session(app_token, expected_role="device")
    assert caught.value.code == "role_mismatch"


# -- the session and verifier details ------------------------------------------------------


async def test_a_scope_the_binding_did_not_grant_is_an_invalid_verdict(tmp_path, hub_key):
    world = World(tmp_path)
    await world.boot()
    device = Subject("tdv_mac_1", "macos")
    _, claims = await world.admit(device, _binding(device))
    verify = world.authority.local_verifier(claims)
    verdict = await verify(world.authority.local_token(claims), expected_scope="pkm.read")
    assert verdict.valid is False and verdict.available is True
    granted = await verify(world.authority.local_token(claims), expected_scope="puppy.inference")
    assert granted.valid is True


async def test_a_tampered_session_is_refused(tmp_path, hub_key):
    world = World(tmp_path)
    await world.boot()
    app = Subject("tdv_app_web_1", "web")
    token, claims = await world.admit(app, _binding(app))
    body = {**claims, "role": "device", "scopes": ["puppy.inference"]}
    encoded = base64.urlsafe_b64encode(psa.canonical_json(body).encode()).decode().rstrip("=")
    forged = f"{psa.SESSION_PREFIX}{encoded}.{token.rsplit('.', 1)[1]}"
    with pytest.raises(psa.PodSessionRefused) as caught:
        world.authority.verify_session(forged)
    assert caught.value.code == "bad_signature"


async def test_renew_issues_a_fresh_session_for_a_still_trusted_subject(tmp_path, hub_key):
    world = World(tmp_path)
    await world.boot()
    app = Subject("tdv_app_web_1", "web")
    token, claims = await world.admit(app, _binding(app))
    renewed, renewed_claims = await world.authority.renew(token)
    assert renewed != token and renewed_claims["sid"] != claims["sid"]
    assert world.authority.verify_session(renewed)["subject_id"] == app.subject_id


async def test_a_fenced_incarnation_refuses_admission_and_renewal(tmp_path, hub_key):
    old = World(tmp_path)
    await old.boot(instance="rev-a")
    app = Subject("tdv_app_web_1", "web")
    token, _ = await old.admit(app, _binding(app))
    new = World(tmp_path)
    await new.boot(instance="rev-b")  # claims the fence away from rev-a
    # The lease re-reads on its own cadence; the next re-read is what fences rev-a.
    assert await old.authority.lease.is_current(force=True) is False

    before = await old.records()
    other = Subject("tdv_app_web_2", "web")
    with pytest.raises(psa.PodSessionRefused) as caught:
        await old.admit(other, _binding(other))
    assert caught.value.code == "fenced" and caught.value.status == 503
    assert await old.records() == before
    with pytest.raises(psa.PodSessionRefused) as caught:
        await old.authority.renew(token)
    assert caught.value.code == "fenced"


def test_the_challenge_payload_is_byte_exact_and_carries_pod_and_epoch():
    payload = psa.challenge_signing_payload(
        challenge_id="psc_1",
        nonce="n",
        hushh_id=OWNER,
        subject_id="tdv_1",
        pod_key_id=POD_KEY_ID,
        epoch=7,
    )
    assert payload == (
        '{"challenge_id":"psc_1","epoch":7,"hushh_id":"ha1_owner","nonce":"n",'
        f'"pod_key_id":"{POD_KEY_ID}","purpose":"pod-session-admission","subject_id":"tdv_1"}}'
    )


def test_the_session_key_is_derived_not_the_dek():
    assert psa.derive_session_key(DEK) != DEK
    assert psa.derive_session_key(DEK) == psa.derive_session_key(DEK)
    assert psa.derive_session_key(b"E" * 32) != psa.derive_session_key(DEK)
