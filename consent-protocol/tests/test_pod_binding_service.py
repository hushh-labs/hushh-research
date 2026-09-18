"""The hub issues bindings and publishes the endpoint; the pod verifies them.

The load-bearing test is the round trip: a binding the hub signs here is accepted
by a real ``PodSessionAuthority`` over a real log, with nothing shared between the
two sides but the public key map every pod is rendered with. The rest pins the
version order, the role and scope rules, the refusals, and the endpoint version
that only moves forward.
"""

from __future__ import annotations

import base64
import json
import time
from typing import Any

import pytest

from hushh_mcp.consent import token_signing
from hushh_mcp.services import pod_binding_service as pbs
from hushh_mcp.services import pod_session_authority as psa
from hushh_mcp.services.pod_access_audit import PodAccessDenied
from hushh_mcp.services.trusted_device_service import TrustedDeviceError

OWNER = "ha1_owner"
USER = "uid-1"
POD_KEY_ID = "podk_hub_test"
POD_PUBLIC_KEY = base64.b64encode(b"H" * 32).decode()
POD_URL = "https://one-pod-ha1-owner-abc.a.run.app"
KID = "hushh-consent-hub"


@pytest.fixture
def hub_key(monkeypatch):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    private = Ed25519PrivateKey.generate()
    seed = private.private_bytes(
        serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()
    )
    public = private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    monkeypatch.setenv("CONSENT_ED25519_PRIVATE_KEY", base64.b64encode(seed).decode())
    monkeypatch.setenv("CONSENT_ED25519_KID", KID)
    monkeypatch.setenv(
        "CONSENT_ED25519_PUBLIC_KEYS", json.dumps({KID: base64.b64encode(public).decode()})
    )
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    token_signing.reset_caches()
    yield
    token_signing.reset_caches()


def _p256_public_b64():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    key = ec.generate_private_key(ec.SECP256R1())
    return key, base64.b64encode(
        key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
    ).decode()


class _Registry:
    def __init__(self, row: dict | None) -> None:
        self.row = row
        self.bindings: list[tuple[str, dict]] = []
        self.endpoints: list[dict] = []
        self.pending: list[dict] = []

    async def get(self, user_id: str):
        return self.row if self.row and self.row.get("user_id") == user_id else None

    async def record_binding(self, *, user_id, device_id, record):
        self.bindings.append((device_id, record))
        meta = self.row.setdefault("backend_metadata", {})
        meta.setdefault("bindings", {})[device_id] = record

    async def record_endpoint(self, *, user_id, endpoint):
        self.endpoints.append(endpoint)
        self.row.setdefault("backend_metadata", {})["endpoint"] = endpoint

    async def append_pending_tombstone(self, *, user_id, entry):
        self.pending.append(entry)
        self.row.setdefault("backend_metadata", {}).setdefault("pendingTombstones", []).append(
            entry
        )


class _Devices:
    def __init__(self, rows: dict[str, dict]) -> None:
        self.rows = rows
        self.audited: list[dict] = []

    def active_device(self, *, user_id, device_id):
        row = self.rows.get(device_id)
        return dict(row) if row and row.get("status", "active") == "active" else None

    def audit_event(self, **kwargs):
        self.audited.append(kwargs)


class _Audit:
    def __init__(self, *, deny: str | None = None) -> None:
        self.deny = deny
        self.calls: list[dict] = []

    async def authorize_owner_read(self, **kwargs):
        self.calls.append(kwargs)
        if self.deny:
            raise PodAccessDenied(self.deny)
        return {"authorized": True}


def _row(**overrides) -> dict:
    row = {
        "user_id": USER,
        "hushh_id": OWNER,
        "status": "provisioned",
        "pod_key_id": POD_KEY_ID,
        "pod_pubkey": POD_PUBLIC_KEY,
        "backend_metadata": {"url": POD_URL},
    }
    row.update(overrides)
    return row


def _service(row=None, devices=None, audit=None, **kw) -> pbs.PodBindingService:
    return pbs.PodBindingService(
        registry=_Registry(row if row is not None else _row()),
        devices=devices or _Devices({}),
        audit=audit or _Audit(),
        **kw,
    )


# -- issuance ---------------------------------------------------------------------


async def test_the_hub_issues_a_binding_the_pod_accepts(tmp_path, hub_key):
    """The round trip that matters: signed here, verified there, nothing shared but public keys."""
    from hushh_mcp.services.pod_authority_store import (
        IncarnationLease,
        PodAuthorityStore,
        claim_incarnation,
    )
    from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog

    app_key, app_public = _p256_public_b64()
    devices = _Devices({"tdv_web_1": {"platform": "web", "device_public_key": app_public}})
    service = _service(devices=devices)

    issued = await service.issue(user_id=USER, device_id="tdv_web_1")

    assert issued["version"] == 1 and issued["role"] == "app"
    assert set(issued["scopes"]) == set(psa.APP_SCOPES)
    assert issued["signature"].startswith(f"ed25519.{KID}.")

    store_backend = LocalObjectStore(str(tmp_path / "pod"))
    log = PodCommitLog(store_backend, b"P" * 32, owner_id=OWNER)
    incarnation = await claim_incarnation(store_backend, b"P" * 32, instance_id="a")
    store = PodAuthorityStore(log, hushh_id=OWNER)
    await store.load()
    authority = psa.PodSessionAuthority(
        store=store,
        lease=IncarnationLease(store_backend, incarnation),
        dek=b"P" * 32,
        pod_key_id=POD_KEY_ID,
        pod_public_key=POD_PUBLIC_KEY,
        environment="dev",
    )
    verified = authority.verify_binding(issued["binding"], issued["signature"])
    assert verified.subject_id == "tdv_web_1" and verified.url == POD_URL
    # ...and a real proof of possession with the app key opens a session.
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec

    challenge = authority.create_challenge("tdv_web_1")
    proof = base64.b64encode(
        app_key.sign(challenge["signing_payload"].encode(), ec.ECDSA(hashes.SHA256()))
    ).decode()
    token, claims = await authority.admit(
        binding=issued["binding"],
        signature=issued["signature"],
        challenge_id=challenge["challenge_id"],
        nonce=challenge["nonce"],
        proof=proof,
        epoch=authority.epoch,
    )
    assert claims["role"] == "app" and authority.verify_session(token)["user_id"] == USER


async def test_versions_only_move_forward_and_are_recorded(hub_key):
    _, public = _p256_public_b64()
    devices = _Devices({"tdv_mac_1": {"platform": "macos", "device_public_key": public}})
    registry = _Registry(_row())
    service = pbs.PodBindingService(registry=registry, devices=devices, audit=_Audit())

    first = await service.issue(user_id=USER, device_id="tdv_mac_1")
    second = await service.issue(user_id=USER, device_id="tdv_mac_1", puppy_inference=True)
    third = await service.issue(user_id=USER, device_id="tdv_mac_1")

    assert [b["version"] for b in (first, second, third)] == [1, 2, 3]
    assert first["scopes"] == [] and second["scopes"] == ["puppy.inference"]
    assert third["scopes"] == []  # the owner turned it back off: a new version, no scope
    assert [r["version"] for _, r in registry.bindings] == [1, 2, 3]
    assert (await service.latest(user_id=USER, device_id="tdv_mac_1"))["version"] == 3
    assert [a["event_type"] for a in devices.audited] == ["pod_binding_issued"] * 3


async def test_role_follows_the_platform_and_puppy_is_a_device_scope(hub_key):
    _, public = _p256_public_b64()
    devices = _Devices(
        {
            "tdv_web": {"platform": "web", "device_public_key": public},
            "tdv_ios": {"platform": "ios", "device_public_key": public},
            "tdv_mac": {"platform": "macos", "device_public_key": public},
            "tdv_odd": {"platform": "windows", "device_public_key": public},
        }
    )
    service = _service(devices=devices)
    assert (await service.issue(user_id=USER, device_id="tdv_web"))["role"] == "app"
    assert (await service.issue(user_id=USER, device_id="tdv_ios"))["role"] == "app"
    assert (await service.issue(user_id=USER, device_id="tdv_mac"))["role"] == "device"
    with pytest.raises(pbs.PodBindingError) as caught:
        await service.issue(user_id=USER, device_id="tdv_web", puppy_inference=True)
    assert caught.value.code == "PUPPY_INFERENCE_IS_A_DEVICE_SCOPE"
    with pytest.raises(pbs.PodBindingError) as caught:
        await service.issue(user_id=USER, device_id="tdv_odd")
    assert caught.value.code == "TRUSTED_DEVICE_UNSUPPORTED_PLATFORM"


async def test_refusals_are_exact_and_record_nothing(hub_key):
    _, public = _p256_public_b64()
    devices = _Devices({"tdv_web": {"platform": "web", "device_public_key": public}})

    denied = _service(devices=devices, audit=_Audit(deny="hushh_id_mismatch"))
    with pytest.raises(pbs.PodBindingError) as caught:
        await denied.issue(user_id=USER, device_id="tdv_web")
    assert caught.value.code == "POD_NOT_AUTHORIZED" and caught.value.status == 403

    no_key = _service(row=_row(pod_key_id=None), devices=devices)
    with pytest.raises(pbs.PodBindingError) as caught:
        await no_key.issue(user_id=USER, device_id="tdv_web")
    assert caught.value.code == "POD_IDENTITY_NOT_DURABLE" and caught.value.status == 409

    no_url = _service(row=_row(backend_metadata={}), devices=devices)
    with pytest.raises(pbs.PodBindingError) as caught:
        await no_url.issue(user_id=USER, device_id="tdv_web")
    assert caught.value.code == "POD_ENDPOINT_UNAVAILABLE"

    with pytest.raises(pbs.PodBindingError) as caught:
        await _service(devices=devices).issue(user_id=USER, device_id="tdv_unknown")
    assert caught.value.code == "TRUSTED_DEVICE_NOT_ACTIVE"
    assert no_key._registry.bindings == [] and no_url._registry.bindings == []


async def test_a_hub_without_an_asymmetric_key_cannot_issue(monkeypatch):
    monkeypatch.delenv("CONSENT_ED25519_PRIVATE_KEY", raising=False)
    monkeypatch.setenv("APP_SIGNING_KEY", "hub-hmac-key-that-must-never-sign-a-binding")
    token_signing.reset_caches()
    _, public = _p256_public_b64()
    service = _service(
        devices=_Devices({"tdv_web": {"platform": "web", "device_public_key": public}})
    )
    with pytest.raises(pbs.PodBindingError) as caught:
        await service.issue(user_id=USER, device_id="tdv_web")
    assert caught.value.code == "BINDING_SIGNING_UNAVAILABLE" and caught.value.status == 503
    assert service._registry.bindings == []
    token_signing.reset_caches()


# -- endpoint discovery -------------------------------------------------------------


async def test_the_endpoint_version_bumps_only_when_the_address_or_key_changes(hub_key):
    registry = _Registry(_row())
    service = pbs.PodBindingService(registry=registry, devices=_Devices({}), audit=_Audit())

    first = await service.endpoint(user_id=USER)
    again = await service.endpoint(user_id=USER)
    assert first["endpointVersion"] == 1 and again["endpointVersion"] == 1
    assert first["url"] == POD_URL and first["podKeyId"] == POD_KEY_ID
    assert first["environment"] == "dev" and first["kind"] == pbs.ENDPOINT_KIND
    assert token_signing.verify_payload(
        psa.canonical_json({k: v for k, v in first.items() if k != "signature"}),
        first["signature"],
        hmac_key="",
        require_asymmetric=True,
    )

    registry.row["backend_metadata"]["url"] = "https://one-pod-ha1-owner-xyz.a.run.app"
    moved = await service.endpoint(user_id=USER)
    assert moved["endpointVersion"] == 2

    registry.row["pod_key_id"] = "podk_rotated"
    rotated = await service.endpoint(user_id=USER)
    assert rotated["endpointVersion"] == 3 and rotated["podKeyId"] == "podk_rotated"
    assert [e["version"] for e in registry.endpoints] == [1, 2, 3]


# -- the courier ----------------------------------------------------------------------


def _intent(**overrides) -> dict:
    intent = {
        "kind": pbs.TOMBSTONE_INTENT_KIND,
        "intentId": "pti_1",
        "hushhId": OWNER,
        "subjectId": "tdv_mac_1",
        "atVersion": 2,
        "issuedAtMs": int(time.time() * 1000),
        "signerSubjectId": "tdv_web_1",
    }
    intent.update(overrides)
    return intent


def _signed(key, intent: dict) -> str:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec

    return base64.b64encode(
        key.sign(psa.canonical_json(intent).encode(), ec.ECDSA(hashes.SHA256()))
    ).decode()


async def test_the_courier_verifies_the_app_signature_and_queues_once(hub_key):
    app_key, app_public = _p256_public_b64()
    mac_key, mac_public = _p256_public_b64()
    devices = _Devices(
        {
            "tdv_web_1": {"platform": "web", "device_public_key": app_public},
            "tdv_mac_1": {"platform": "macos", "device_public_key": mac_public},
        }
    )
    registry = _Registry(_row())
    service = pbs.PodBindingService(registry=registry, devices=devices, audit=_Audit())
    intent = _intent()

    queued = await service.courier_tombstone(
        user_id=USER, device_id="tdv_mac_1", intent=intent, signature=_signed(app_key, intent)
    )
    assert queued == {"queued": True, "intentId": "pti_1", "pending": 1}
    assert registry.pending[0]["intent"] == intent
    # Idempotent on the intent id.
    again = await service.courier_tombstone(
        user_id=USER, device_id="tdv_mac_1", intent=intent, signature=_signed(app_key, intent)
    )
    assert again["pending"] == 1 and len(registry.pending) == 1

    # A device-role signer, a bad signature, another pod, another subject: refused.
    for kwargs, code in (
        (
            {
                "intent": _intent(intentId="pti_2"),
                "signature": _signed(mac_key, _intent(intentId="pti_2")),
            },
            "TOMBSTONE_SIGNATURE_INVALID",
        ),
        (
            {
                "intent": _intent(intentId="pti_3", signerSubjectId="tdv_mac_1"),
                "signature": _signed(
                    mac_key, _intent(intentId="pti_3", signerSubjectId="tdv_mac_1")
                ),
            },
            "TOMBSTONE_SIGNER_NOT_TRUSTED",
        ),
        (
            {
                "intent": _intent(intentId="pti_4", hushhId="ha1_other"),
                "signature": _signed(app_key, _intent(intentId="pti_4", hushhId="ha1_other")),
            },
            "TOMBSTONE_INTENT_INVALID",
        ),
        (
            {
                "intent": _intent(intentId="pti_5", subjectId="tdv_other"),
                "signature": _signed(app_key, _intent(intentId="pti_5", subjectId="tdv_other")),
            },
            "TOMBSTONE_INTENT_INVALID",
        ),
        (
            {"intent": {**_intent(intentId="pti_6"), "extra": 1}, "signature": "x"},
            "TOMBSTONE_INTENT_INVALID",
        ),
    ):
        with pytest.raises(pbs.PodBindingError) as caught:
            await service.courier_tombstone(user_id=USER, device_id="tdv_mac_1", **kwargs)
        assert caught.value.code == code, code
    assert len(registry.pending) == 1


# -- the routes -------------------------------------------------------------------------


class _FakeService:
    calls: list[dict] = []

    def self_enroll(self, **kwargs):
        _FakeService.calls.append(kwargs)
        if kwargs["platform"] == "windows":
            raise TrustedDeviceError(
                "TRUSTED_DEVICE_UNSUPPORTED_PLATFORM", "Self-enrolment is for the app."
            )
        return {"device_id": "tdv_new", "platform": kwargs["platform"], "status": "active"}


async def test_the_self_enroll_route_enrols_the_app_without_puppy_or_vault_authority(monkeypatch):
    from fastapi import HTTPException

    from api.routes import account

    async def _run_in_threadpool(function, **kwargs):
        return function(**kwargs)

    async def _guard(_uid=None):
        return None

    _FakeService.calls = []
    monkeypatch.setattr(account, "TrustedDeviceService", _FakeService)
    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)
    monkeypatch.setattr(account, "_trusted_device_guard", _guard)

    result = await account.trusted_device_self_enroll(
        account.TrustedDeviceSelfEnrollRequest(
            devicePublicKey="AAAA", deviceName="Safari on Mac", platform="web"
        ),
        firebase_uid="uid-1",
    )
    assert result["device_id"] == "tdv_new" and result["platform"] == "web"
    assert _FakeService.calls[0]["user_id"] == "uid-1"
    assert "puppy" not in json.dumps(result) and "vault" not in json.dumps(result)

    with pytest.raises(HTTPException) as caught:
        await account.trusted_device_self_enroll(
            account.TrustedDeviceSelfEnrollRequest(
                devicePublicKey="AAAA", deviceName="x", platform="windows"
            ),
            firebase_uid="uid-1",
        )
    assert caught.value.status_code == 400
    assert caught.value.detail["code"] == "TRUSTED_DEVICE_UNSUPPORTED_PLATFORM"


async def test_the_binding_and_endpoint_routes_delegate_to_the_service(monkeypatch):
    from fastapi import HTTPException

    from api.routes import account
    from api.routes.one import personal_agent

    class _Service:
        def __init__(self, **_kw: Any) -> None:
            pass

        async def issue(self, *, user_id, device_id, puppy_inference):
            return {
                "binding": {"subject_id": device_id},
                "signature": "ed25519.k.s",
                "version": 1,
                "puppy": puppy_inference,
            }

        async def latest(self, *, user_id, device_id):
            return None if device_id == "tdv_none" else {"version": 2}

        async def endpoint(self, *, user_id):
            if user_id == "uid-nokey":
                raise pbs.PodBindingError("POD_IDENTITY_NOT_DURABLE", "no key", status=409)
            return {"url": POD_URL, "endpointVersion": 1}

    monkeypatch.setattr(pbs, "PodBindingService", _Service)

    issued = await account.issue_pod_binding(
        "tdv_mac_1", account.PodBindingIssueRequest(puppyInference=True), firebase_uid="uid-1"
    )
    assert issued["puppy"] is True and issued["binding"]["subject_id"] == "tdv_mac_1"
    assert (await account.read_pod_binding("tdv_mac_1", firebase_uid="uid-1"))["version"] == 2
    with pytest.raises(HTTPException) as caught:
        await account.read_pod_binding("tdv_none", firebase_uid="uid-1")
    assert caught.value.status_code == 404

    assert (await personal_agent.personal_agent_endpoint_route(user_id="uid-1"))["url"] == POD_URL
    with pytest.raises(HTTPException) as caught:
        await personal_agent.personal_agent_endpoint_route(user_id="uid-nokey")
    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "POD_IDENTITY_NOT_DURABLE"


def test_the_stale_allowlist_line_is_gone_from_the_env_reference():
    from pathlib import Path

    text = Path(__file__).resolve().parents[1].joinpath("docs/reference/env-vars.md").read_text()
    assert "HUSHH_TRUSTED_DEVICE_UAT_ALLOWLIST" not in text
