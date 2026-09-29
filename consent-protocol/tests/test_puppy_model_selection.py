"""The owner command cannot be applied by a Firebase session without its device key."""

from __future__ import annotations

import base64
from copy import deepcopy

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from hushh_mcp.services.pod_binding_service import PodBindingError
from hushh_mcp.services.puppy_model_selection import (
    PuppyModelSelectionService,
    acknowledgement_payload,
    pending_for_device,
)

OWNER = "owner-1"
DEVICE = "tdv_" + "d" * 32
CATALOG = "a" * 64


def _key() -> tuple[ec.EllipticCurvePrivateKey, str]:
    private = ec.generate_private_key(ec.SECP256R1())
    public = private.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return private, base64.b64encode(public).decode()


def _row() -> dict:
    return {
        "user_id": OWNER,
        "hushh_id": "ha1_owner",
        "status": "provisioned",
        "deployment_target": "user_gcp",
        "pod_key_id": "pod-key-1",
        "backend_metadata": {
            "url": "https://pod.example",
            "ingress": "direct",
            "serviceUid": "service-1",
            "directReadiness": {
                "verified": True,
                "url": "https://pod.example",
                "podKeyId": "pod-key-1",
                "serviceUid": "service-1",
            },
            "puppyAccess": {
                DEVICE: {"enabled": True, "podKeyId": "pod-key-1", "serviceUid": "service-1"}
            },
        },
    }


class _Registry:
    def __init__(self, row: dict) -> None:
        self.row = row
        self.writes = 0

    async def get(self, user_id: str) -> dict | None:
        return deepcopy(self.row) if user_id == OWNER else None

    async def record_puppy_model_selection(
        self,
        *,
        user_id: str,
        device_id: str,
        command: dict,
        expected_version: int,
        approval: dict,
        readiness: dict,
    ) -> dict | None:
        if user_id != OWNER or self.row["backend_metadata"]["puppyAccess"][device_id] != approval:
            return None
        if self.row["backend_metadata"]["directReadiness"] != readiness:
            return None
        previous = self.row["backend_metadata"].setdefault("puppyModelSelection", {}).get(device_id)
        if previous and previous["id"] == command["id"]:
            return deepcopy(previous) if previous["model"] == command["model"] else None
        if int((previous or {}).get("version") or 0) != expected_version:
            return None
        self.row["backend_metadata"]["puppyModelSelection"][device_id] = deepcopy(command)
        self.writes += 1
        return deepcopy(command)

    async def ack_puppy_model_selection(
        self,
        *,
        user_id: str,
        device_id: str,
        previous: dict,
        settled: dict,
        approval: dict,
        readiness: dict,
    ) -> dict | None:
        metadata = self.row["backend_metadata"]
        if (
            user_id != OWNER
            or metadata["puppyAccess"][device_id] != approval
            or metadata["directReadiness"] != readiness
            or metadata["puppyModelSelection"][device_id] != previous
        ):
            return None
        metadata["puppyModelSelection"][device_id] = deepcopy(settled)
        self.writes += 1
        return deepcopy(settled)


class _Devices:
    def __init__(self, public: str) -> None:
        self.public = public

    def active_device(self, *, user_id: str, device_id: str) -> dict | None:
        if user_id != OWNER or device_id != DEVICE:
            return None
        return {"platform": "macos", "device_public_key": self.public}


class _Audit:
    async def authorize_owner_read(self, **kwargs) -> None:
        assert kwargs["user_id"] == OWNER


def _service(registry: _Registry, public: str, *, now: float = 100.0) -> PuppyModelSelectionService:
    return PuppyModelSelectionService(
        registry=registry, devices=_Devices(public), audit=_Audit(), clock=lambda: now
    )


def _proof(key: ec.EllipticCurvePrivateKey, command: dict, result: str, reason: str = "") -> str:
    signed = key.sign(
        acknowledgement_payload(command, result, reason).encode(), ec.ECDSA(hashes.SHA256())
    )
    return base64.b64encode(signed).decode()


@pytest.mark.asyncio
async def test_owner_command_requires_device_proof_and_settles_once() -> None:
    key, public = _key()
    registry = _Registry(_row())
    svc = _service(registry, public)
    command = await svc.request(
        user_id=OWNER,
        device_id=DEVICE,
        request_id="request_1234",
        model="gemma-4-26b",
        catalog_version=CATALOG,
        expected_version=0,
    )
    assert command["status"] == "pending" and command["version"] == 1
    assert pending_for_device(registry.row, DEVICE, now_ms=100_000)["id"] == command["id"]
    retried = await svc.request(
        user_id=OWNER,
        device_id=DEVICE,
        request_id="request_1234",
        model="gemma-4-26b",
        catalog_version=CATALOG,
        expected_version=0,
    )
    assert retried == command and registry.writes == 1
    with pytest.raises(PodBindingError) as invalid:
        await svc.acknowledge(
            user_id=OWNER,
            device_id=DEVICE,
            request_id=command["id"],
            version=1,
            result="applied",
            reason="",
            proof=_proof(_key()[0], command, "applied"),
        )
    assert invalid.value.code == "PUPPY_MODEL_ACK_UNAUTHORIZED"
    assert registry.writes == 1
    ack = dict(
        user_id=OWNER,
        device_id=DEVICE,
        request_id=command["id"],
        version=1,
        result="applied",
        reason="",
        proof=_proof(key, command, "applied"),
    )
    applied = await svc.acknowledge(**ack)
    assert applied["status"] == "applied"
    assert (await svc.acknowledge(**ack)) == applied
    assert registry.writes == 2
    assert pending_for_device(registry.row, DEVICE, now_ms=100_000) is None


@pytest.mark.asyncio
async def test_replacement_withdrawal_expiry_and_replay_refuse_application() -> None:
    key, public = _key()
    registry = _Registry(_row())
    svc = _service(registry, public)
    first = await svc.request(
        user_id=OWNER,
        device_id=DEVICE,
        request_id="request_1234",
        model="gemma-4-26b",
        catalog_version=CATALOG,
        expected_version=0,
    )
    second = await svc.request(
        user_id=OWNER,
        device_id=DEVICE,
        request_id="request_5678",
        model="llama-3.2",
        catalog_version=CATALOG,
        expected_version=1,
    )
    with pytest.raises(PodBindingError) as replay:
        await svc.acknowledge(
            user_id=OWNER,
            device_id=DEVICE,
            request_id=first["id"],
            version=1,
            result="applied",
            reason="",
            proof=_proof(key, first, "applied"),
        )
    assert replay.value.code == "PUPPY_MODEL_COMMAND_CHANGED"
    registry.row["backend_metadata"]["serviceUid"] = "service-replaced"
    assert pending_for_device(registry.row, DEVICE, now_ms=100_000) is None
    with pytest.raises(PodBindingError) as replaced:
        await svc.acknowledge(
            user_id=OWNER,
            device_id=DEVICE,
            request_id=second["id"],
            version=2,
            result="applied",
            reason="",
            proof=_proof(key, second, "applied"),
        )
    assert replaced.value.code == "PUPPY_MODEL_COMMAND_CHANGED"
    registry.row["backend_metadata"]["serviceUid"] = "service-1"
    registry.row["backend_metadata"]["puppyAccess"][DEVICE]["enabled"] = False
    assert pending_for_device(registry.row, DEVICE, now_ms=100_000) is None
    registry.row["backend_metadata"]["puppyAccess"][DEVICE]["enabled"] = True
    assert pending_for_device(registry.row, DEVICE, now_ms=second["expiresAt"]) is None
    with pytest.raises(PodBindingError) as expired:
        await _service(registry, public, now=second["expiresAt"] / 1000).acknowledge(
            user_id=OWNER,
            device_id=DEVICE,
            request_id=second["id"],
            version=2,
            result="applied",
            reason="",
            proof=_proof(key, second, "applied"),
        )
    assert expired.value.code == "PUPPY_MODEL_COMMAND_CHANGED"


@pytest.mark.asyncio
async def test_device_can_refuse_stale_catalog_without_changing_default() -> None:
    key, public = _key()
    registry = _Registry(_row())
    svc = _service(registry, public)
    command = await svc.request(
        user_id=OWNER,
        device_id=DEVICE,
        request_id="request_1234",
        model="gemma-4-26b",
        catalog_version=CATALOG,
        expected_version=0,
    )
    refused = await svc.acknowledge(
        user_id=OWNER,
        device_id=DEVICE,
        request_id=command["id"],
        version=1,
        result="refused",
        reason="STALE_MODEL_CATALOG",
        proof=_proof(key, command, "refused", "STALE_MODEL_CATALOG"),
    )
    assert refused["status"] == "refused"
    assert refused["reason"] == "STALE_MODEL_CATALOG"
