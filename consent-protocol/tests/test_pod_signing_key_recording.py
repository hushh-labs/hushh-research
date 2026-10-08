"""Recording the pod's signing key: only from the hub's own pull, only with its pod key.

The hub learns a pod's signing key exactly one way: it GETs ``/pod/public-key`` from
the address it recorded when it created the pod. These tests pin what that pull may
record and where: in the same write as the pod key, never for another HusshID, never
with a kid the key does not derive, never where the dev-only flag (and its migration)
is absent, and never silently replaced for an unchanged pod key.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from hushh_mcp.services import pod_key_collector
from hushh_mcp.services import pod_request_identity_store as identity_store
from hushh_mcp.services import pod_request_signing as prs
from hushh_mcp.services.compute_backend import BackendHandle, PodSpec
from hushh_mcp.services.personal_agent_provisioning_service import (
    PersonalAgentProvisioningService,
)
from hushh_mcp.services.pod_connector_keypair_service import generate_pod_keypair
from hushh_mcp.services.pod_key_collector import collect_pod_key_if_pending, fetch_pod_public_key
from tests.personal_agent_registry_fake import ProvisionAdmissionFake

_UID = "firebase-uid-0123456789abcdefghij"
_PHONE = "+14155550123"
_POD_URL = "https://pod-abc-uc.a.run.app"


def _signing(seed: int) -> tuple[str, str]:
    key = Ed25519PrivateKey.from_private_bytes(bytes([seed]) * 32)
    public = prs.public_key_b64(key)
    return public, prs.signing_key_id(public)


class _Registry(ProvisionAdmissionFake):
    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}
        self.upserts: list[dict] = []

    async def upsert(self, **fields: Any) -> None:
        self.upserts.append(fields)
        row = self.rows.setdefault(fields["user_id"], {})
        row.update({k: v for k, v in fields.items() if v is not None})

    async def get(self, user_id: str) -> Optional[dict]:
        row = self.rows.get(user_id)
        return dict(row, user_id=user_id) if row else None

    async def tombstone_exists(self, hushh_id: str) -> bool:
        return False


class _Store:
    """The conditional UPDATE in pod_request_identity_store.bind_signing_key."""

    def __init__(self, registry: _Registry) -> None:
        self.registry = registry
        self.calls: list[dict] = []

    async def bind_signing_key(self, **kwargs: Any) -> bool:
        self.calls.append(kwargs)
        row = self.registry.rows.get(kwargs["user_id"]) or {}
        if row.get("pod_pubkey") != kwargs["pod_pubkey"]:
            return False
        recorded = row.get("pod_signing_key_id")
        if recorded and recorded != kwargs["signing_key_id"] and not kwargs["allow_rotation"]:
            return False
        row.update(
            pod_signing_pubkey=kwargs["signing_pubkey"],
            pod_signing_key_id=kwargs["signing_key_id"],
        )
        return True


class _Grant:
    async def issue_standing_pkm_read(self, user_id: str, ledger: Any = None) -> dict:
        return {"expiresAt": "2030-01-01T00:00:00Z"}


class _Backend:
    backend_id = "fake"

    async def provision(self, spec: PodSpec) -> BackendHandle:
        return BackendHandle(
            external_agent_id="pod-abc",
            a2a_route=f"a2a://{spec.hushh_id}",
            status="live",
            backend=self.backend_id,
            backend_metadata={"url": _POD_URL, "ready": True},
        )


class _Response:
    def __init__(self, body: dict) -> None:
        self.status_code = 200
        self._body = body

    def json(self) -> dict:
        return self._body


class _Session:
    def __init__(self, body: dict) -> None:
        self.body = body

    def get(self, url: str, **_: Any) -> _Response:
        assert url == f"{_POD_URL}/pod/public-key", "the hub pulls only from its own record"
        return _Response(self.body)


@pytest.fixture
def world(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setattr(pod_key_collector, "pod_hub_identity_auth_enabled", lambda: True)
    # The hub's own ID token for the pod: not under test, and minting it off GCP waits
    # out the metadata-server timeout.
    monkeypatch.setattr(pod_key_collector, "_identity_token", lambda _audience: None)
    registry = _Registry()
    store = _Store(registry)
    monkeypatch.setattr(identity_store, "default_store", lambda: store)
    service = PersonalAgentProvisioningService(
        registry=registry, grant=_Grant(), backend=_Backend()
    )
    return registry, store, service


def _published(keypair, hushh_id: Optional[str], signing: tuple[str, str]) -> dict:
    return {
        "hushhId": hushh_id,
        "podPublicKey": keypair.public_key_b64,
        "podKeyId": keypair.key_id,
        "podKeyWrappingAlg": keypair.wrapping_alg,
        "podSigningKey": signing[0],
        "podSigningKeyId": signing[1],
        "podSigningAlg": "ed25519",
    }


async def _provisioned_row(registry: _Registry, service) -> dict:
    await service.provision(user_id=_UID, phone_e164=_PHONE)
    registry.rows[_UID]["pod_signing_key_id"] = None  # read from a schema with 947
    return dict(registry.rows[_UID], user_id=_UID)


def _row_after_947() -> dict:
    """A row as ``SELECT *`` returns it once migration 947 added the columns."""
    return {"hushh_id": "ha1_me", "backend_metadata": {"url": _POD_URL}, "pod_signing_key_id": None}


# -- what the pull may carry -----------------------------------------------------------


async def test_the_pull_carries_the_signing_key_only_for_this_rows_husshid(world):
    keypair, signing = generate_pod_keypair(), _signing(1)
    row = _row_after_947()

    mine = await fetch_pod_public_key(row, session=_Session(_published(keypair, "ha1_me", signing)))
    assert mine["podSigningKey"] == signing[0] and mine["podSigningKeyId"] == signing[1]

    theirs = _Session(_published(keypair, "ha1_someone_else", signing))
    assert await fetch_pod_public_key(row, session=theirs) is None


async def test_a_kid_that_the_key_does_not_derive_is_dropped(world):
    keypair, signing = generate_pod_keypair(), _signing(1)
    body = _published(keypair, "ha1_me", (signing[0], _signing(2)[1]))
    payload = await fetch_pod_public_key(_row_after_947(), session=_Session(body))
    assert payload["podPublicKey"] == keypair.public_key_b64
    assert "podSigningKey" not in payload


async def test_without_the_dev_flag_the_signing_key_is_never_recorded(world, monkeypatch):
    """UAT/production have no migration 947: the pull must not name its columns."""
    monkeypatch.setattr(pod_key_collector, "pod_hub_identity_auth_enabled", lambda: False)
    keypair = generate_pod_keypair()
    payload = await fetch_pod_public_key(
        _row_after_947(), session=_Session(_published(keypair, "ha1_me", _signing(1)))
    )
    assert set(payload) == {"podPublicKey", "podKeyId", "podKeyWrappingAlg"}


async def test_a_row_read_before_migration_947_never_records_the_signing_key(world):
    """The flag on ahead of its migration must not fail the pod key write."""
    keypair = generate_pod_keypair()
    row = {"hushh_id": "ha1_me", "backend_metadata": {"url": _POD_URL}}
    payload = await fetch_pod_public_key(
        row, session=_Session(_published(keypair, "ha1_me", _signing(1)))
    )
    assert set(payload) == {"podPublicKey", "podKeyId", "podKeyWrappingAlg"}


# -- how it is recorded ----------------------------------------------------------------


async def test_a_first_registration_records_both_keys_in_the_same_upsert(world):
    registry, store, service = world
    registry.rows[_UID] = {
        "hushh_id": "ha1_me",
        "phone_e164_hash": "h",
        "status": "connecting",
        "pod_signing_key_id": None,
    }
    keypair, signing = generate_pod_keypair(), _signing(1)
    row = dict(registry.rows[_UID], user_id=_UID, backend_metadata={"url": _POD_URL})

    status = await collect_pod_key_if_pending(
        row, service=service, session=_Session(_published(keypair, "ha1_me", signing))
    )

    assert status == "provisioned"
    written = [u for u in registry.upserts if u.get("pod_pubkey") == keypair.public_key_b64]
    assert written and all(u["pod_signing_key_id"] == signing[1] for u in written)
    assert store.calls == []


async def test_the_exact_attempt_path_binds_the_signing_key_to_the_published_pod_key(world):
    registry, store, service = world
    row = await _provisioned_row(registry, service)
    keypair, signing = generate_pod_keypair(), _signing(1)

    status = await collect_pod_key_if_pending(
        row, service=service, session=_Session(_published(keypair, row["hushh_id"], signing))
    )

    assert status == "provisioned"
    assert store.calls[-1]["pod_pubkey"] == keypair.public_key_b64
    assert registry.rows[_UID]["pod_signing_key_id"] == signing[1]


async def test_an_existing_pod_with_the_same_key_gains_its_signing_key(world):
    """The GCP transition: a durable pod key already on the row, no signing key yet."""
    registry, store, service = world
    keypair, signing = generate_pod_keypair(), _signing(1)
    registry.rows[_UID] = {
        "hushh_id": "ha1_me",
        "phone_e164_hash": "h",
        "status": "provisioned",
        "pod_pubkey": keypair.public_key_b64,
        "pod_key_id": keypair.key_id,
    }

    await service.attach_pod_public_key(
        user_id=_UID,
        pod_public_key_b64=keypair.public_key_b64,
        pod_key_id=keypair.key_id,
        pod_signing_public_key_b64=signing[0],
        pod_signing_key_id=signing[1],
    )

    assert registry.rows[_UID]["pod_signing_key_id"] == signing[1]
    assert store.calls[0]["allow_rotation"] is False


async def test_an_unchanged_pod_key_never_silently_swaps_its_signing_key(world):
    registry, _, service = world
    keypair = generate_pod_keypair()
    registry.rows[_UID] = {
        "hushh_id": "ha1_me",
        "phone_e164_hash": "h",
        "status": "provisioned",
        "pod_pubkey": keypair.public_key_b64,
        "pod_key_id": keypair.key_id,
        "pod_signing_pubkey": _signing(1)[0],
        "pod_signing_key_id": _signing(1)[1],
    }
    swap = dict(
        user_id=_UID,
        pod_public_key_b64=keypair.public_key_b64,
        pod_key_id=keypair.key_id,
        pod_signing_public_key_b64=_signing(2)[0],
        pod_signing_key_id=_signing(2)[1],
    )

    with pytest.raises(ValueError, match="signing key"):
        await service.attach_pod_public_key(**swap)
    assert registry.rows[_UID]["pod_signing_key_id"] == _signing(1)[1]

    await service.attach_pod_public_key(**swap, allow_rotation=True)  # the pull path
    assert registry.rows[_UID]["pod_signing_key_id"] == _signing(2)[1]


async def test_a_rotated_pod_key_moves_its_signing_key_in_the_same_upsert(world):
    registry, store, service = world
    old, new = generate_pod_keypair(), generate_pod_keypair()
    registry.rows[_UID] = {
        "hushh_id": "ha1_me",
        "phone_e164_hash": "h",
        "status": "provisioned",
        "pod_pubkey": old.public_key_b64,
        "pod_key_id": old.key_id,
        "pod_signing_pubkey": _signing(1)[0],
        "pod_signing_key_id": _signing(1)[1],
    }

    result = await service.attach_pod_public_key(
        user_id=_UID,
        pod_public_key_b64=new.public_key_b64,
        pod_key_id=new.key_id,
        allow_rotation=True,
        pod_signing_public_key_b64=_signing(2)[0],
        pod_signing_key_id=_signing(2)[1],
    )

    assert result["rotated"] is True
    last = registry.upserts[-1]
    assert last["pod_pubkey"] == new.public_key_b64
    assert last["pod_signing_key_id"] == _signing(2)[1]
    assert store.calls == []


async def test_a_malformed_signing_key_is_refused_before_anything_is_written(world):
    registry, _, service = world
    keypair = generate_pod_keypair()
    registry.rows[_UID] = {"hushh_id": "ha1_me", "phone_e164_hash": "h", "status": "connecting"}
    with pytest.raises(ValueError, match="invalid pod signing key"):
        await service.attach_pod_public_key(
            user_id=_UID,
            pod_public_key_b64=keypair.public_key_b64,
            pod_key_id=keypair.key_id,
            pod_signing_public_key_b64=_signing(1)[0],
            pod_signing_key_id="pods_" + "0" * 32,
        )
    assert registry.upserts == []
