"""Pod key custody: durable sources, ephemeral rotation, and the vault-key scope cut.

Three properties, each load-bearing for "PKM native to the pod":

1. **A pod may hold strictly what its surface uses.** ``get_core_security_settings``
   no longer demands ``VAULT_DATA_KEY`` in pod mode -- every consumer of that key is
   hub-only -- and the renderer no longer mounts it. Hub behaviour is unchanged.
2. **A durable key source survives restarts and keeps a stable identity.** Same
   material in, same public key AND same key id out, across process lifetimes.
   Garbage or missing sources degrade to ephemeral, loudly, never to a crash.
3. **Rotation is the hub's decision, taken only on its own pull.** A restarted
   ephemeral pod presents a new key; the collector's rotation path updates the
   registry without double-minting, while every push-shaped caller keeps the
   refuse-rebind default.
"""

from __future__ import annotations

import base64
from typing import Any, Optional

import pytest
from cryptography.hazmat.primitives import serialization

import hushh_mcp.services.pod_self_registration as psr
from hushh_mcp.services.personal_agent_provisioning_service import (
    PersonalAgentProvisioningService,
)
from hushh_mcp.services.pod_connector_keypair_service import generate_pod_keypair
from hushh_mcp.services.pod_key_collector import (
    collect_pod_key_if_pending,
    refresh_pod_key,
)

_UID = "firebase-uid-0123456789abcdefghij"
_PHONE = "+14155550123"
_POD_URL = "https://pod-abc-uc.a.run.app"


# --- fakes shared with test_pod_key_collection ---------------------------------------


class _FakeRegistry:
    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}

    async def upsert(self, **fields: Any) -> None:
        row = self.rows.setdefault(fields["user_id"], {})
        row.update({k: v for k, v in fields.items() if v is not None})

    async def get(self, user_id: str) -> Optional[dict]:
        return self.rows.get(user_id)

    async def tombstone_exists(self, hushh_id: str) -> bool:
        return False


class _FakeGrant:
    def __init__(self) -> None:
        self.issued = 0

    async def issue_standing_pkm_read(self, user_id: str, ledger: Any = None) -> dict:
        self.issued += 1
        return {"expiresAt": "2030-01-01T00:00:00Z"}


class _Response:
    def __init__(self, status_code: int, body: Any = None) -> None:
        self.status_code = status_code
        self._body = body

    def json(self) -> Any:
        return self._body


class _Session:
    def __init__(self, response: _Response) -> None:
        self.response = response

    def get(self, url: str, **_: Any) -> _Response:
        return self.response


@pytest.fixture(autouse=True)
def _enabled(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    psr._STATE = None
    yield
    psr._STATE = None


def _service(registry: _FakeRegistry, grant: _FakeGrant) -> PersonalAgentProvisioningService:
    class _NullBackendish:
        backend_id = "fake"

        async def provision(self, spec: Any) -> Any:
            from hushh_mcp.services.compute_backend import BackendHandle

            return BackendHandle(
                external_agent_id="pod-abc",
                a2a_route="a2a://x",
                status="live",
                backend="fake",
                backend_metadata={"url": _POD_URL},
            )

    return PersonalAgentProvisioningService(
        registry=registry, grant=grant, backend=_NullBackendish()
    )


# --- 1. vault-key scope cut -----------------------------------------------------------


def test_pod_mode_tolerates_an_absent_vault_key(monkeypatch: pytest.MonkeyPatch):
    from hushh_mcp.runtime_settings import get_core_security_settings

    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("APP_SIGNING_KEY", "test-signing-key-that-is-32-chars!!")
    monkeypatch.delenv("VAULT_DATA_KEY", raising=False)
    get_core_security_settings.cache_clear()
    try:
        settings = get_core_security_settings()
        # Resolves to "" so any accidental use fails LOUDLY at the call site.
        assert settings.vault_data_key == ""
        assert settings.app_signing_key
    finally:
        get_core_security_settings.cache_clear()


def test_hub_mode_still_refuses_to_boot_without_a_vault_key(monkeypatch: pytest.MonkeyPatch):
    from hushh_mcp.runtime_settings import get_core_security_settings

    monkeypatch.delenv("HUSSH_POD_MODE", raising=False)
    monkeypatch.setenv("APP_SIGNING_KEY", "test-signing-key-that-is-32-chars!!")
    monkeypatch.delenv("VAULT_DATA_KEY", raising=False)
    get_core_security_settings.cache_clear()
    try:
        with pytest.raises(ValueError):
            get_core_security_settings()
    finally:
        get_core_security_settings.cache_clear()


# --- 2. durable key source ------------------------------------------------------------


def test_a_mounted_private_key_is_durable_and_stable_across_restarts(
    monkeypatch: pytest.MonkeyPatch,
):
    raw = generate_pod_keypair()
    material = base64.b64encode(
        raw.private_key.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        )
    ).decode("ascii")
    monkeypatch.setenv(psr.POD_PRIVATE_KEY_ENV, material)

    psr._STATE = None
    first = psr.pod_keypair()
    assert psr.pod_key_is_durable() is True
    assert first.public_key_b64 == raw.public_key_b64

    # Simulated restart: same env, fresh process state -> identical identity.
    psr._STATE = None
    second = psr.pod_keypair()
    assert second.public_key_b64 == first.public_key_b64
    assert second.key_id == first.key_id


def test_garbage_material_degrades_to_ephemeral_not_a_crash(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(psr.POD_PRIVATE_KEY_ENV, "not-a-key")
    psr._STATE = None
    assert psr.pod_keypair() is not None
    assert psr.pod_key_is_durable() is False


def test_no_source_means_ephemeral_and_a_restart_rotates(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv(psr.POD_PRIVATE_KEY_ENV, raising=False)
    monkeypatch.delenv(psr.POD_PRIVATE_KEY_FILE_ENV, raising=False)
    psr._STATE = None
    first = psr.pod_keypair()
    assert psr.pod_key_is_durable() is False
    psr._STATE = None
    second = psr.pod_keypair()
    assert second.public_key_b64 != first.public_key_b64


# --- 3. rotation ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rotation_updates_the_key_without_double_minting():
    registry, grant = _FakeRegistry(), _FakeGrant()
    service = _service(registry, grant)
    await service.provision(user_id=_UID, phone_e164=_PHONE)

    original = generate_pod_keypair()
    await service.attach_pod_public_key(
        user_id=_UID, pod_public_key_b64=original.public_key_b64, pod_key_id=original.key_id
    )
    assert registry.rows[_UID]["status"] == "provisioned"
    assert grant.issued == 1

    restarted = generate_pod_keypair()
    result = await service.attach_pod_public_key(
        user_id=_UID,
        pod_public_key_b64=restarted.public_key_b64,
        pod_key_id=restarted.key_id,
        allow_rotation=True,
    )

    assert result["status"] == "provisioned"
    assert result.get("rotated") is True
    assert registry.rows[_UID]["pod_pubkey"] == restarted.public_key_b64
    # The rotation is a key refresh, never a second grant.
    assert grant.issued == 1


@pytest.mark.asyncio
async def test_without_the_flag_a_different_key_is_still_refused():
    registry, grant = _FakeRegistry(), _FakeGrant()
    service = _service(registry, grant)
    await service.provision(user_id=_UID, phone_e164=_PHONE)
    original = generate_pod_keypair()
    await service.attach_pod_public_key(
        user_id=_UID, pod_public_key_b64=original.public_key_b64, pod_key_id=original.key_id
    )

    impostor = generate_pod_keypair()
    with pytest.raises(ValueError):
        await service.attach_pod_public_key(
            user_id=_UID, pod_public_key_b64=impostor.public_key_b64, pod_key_id=impostor.key_id
        )
    assert registry.rows[_UID]["pod_pubkey"] == original.public_key_b64


@pytest.mark.asyncio
async def test_the_status_poll_never_rotates_a_provisioned_row():
    """The cheap path keeps the conservative default; only the sweep rotates."""
    registry, grant = _FakeRegistry(), _FakeGrant()
    service = _service(registry, grant)
    await service.provision(user_id=_UID, phone_e164=_PHONE)
    original = generate_pod_keypair()
    await service.attach_pod_public_key(
        user_id=_UID, pod_public_key_b64=original.public_key_b64, pod_key_id=original.key_id
    )

    restarted = generate_pod_keypair()
    session = _Session(
        _Response(200, {"podPublicKey": restarted.public_key_b64, "podKeyId": restarted.key_id})
    )
    row = dict(registry.rows[_UID], user_id=_UID)

    assert await collect_pod_key_if_pending(row, service=service, session=session) is None
    assert registry.rows[_UID]["pod_pubkey"] == original.public_key_b64


@pytest.mark.asyncio
async def test_the_reconcile_refresh_rotates_a_restarted_pod():
    registry, grant = _FakeRegistry(), _FakeGrant()
    service = _service(registry, grant)
    await service.provision(user_id=_UID, phone_e164=_PHONE)
    original = generate_pod_keypair()
    await service.attach_pod_public_key(
        user_id=_UID, pod_public_key_b64=original.public_key_b64, pod_key_id=original.key_id
    )

    restarted = generate_pod_keypair()
    session = _Session(
        _Response(200, {"podPublicKey": restarted.public_key_b64, "podKeyId": restarted.key_id})
    )
    row = dict(registry.rows[_UID], user_id=_UID)

    status = await refresh_pod_key(row, service=service, session=session)

    assert status == "provisioned"
    assert registry.rows[_UID]["pod_pubkey"] == restarted.public_key_b64
    assert grant.issued == 1
