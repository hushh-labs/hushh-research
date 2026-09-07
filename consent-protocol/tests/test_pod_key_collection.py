"""The deferred-key provisioning path: connecting -> hub collects key -> provisioned.

A pod provisioned automatically off phone verification has no public key when it
is created, because the pod generates its own inside its runtime. These tests pin
the three properties that makes load-bearing:

1. ``provision()`` without a key stops at ``connecting`` and mints NOTHING;
2. the hub collects the key by PULLING from the URL it recorded itself, so no
   caller can nominate the address it fetches from;
3. adopting the key is what mints the standing read -- and a second, different
   key is refused rather than silently rebinding the agent's identity.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest

from hushh_mcp.services.compute_backend import BackendHandle, PodSpec
from hushh_mcp.services.personal_agent_provisioning_service import (
    PersonalAgentProvisioningService,
)
from hushh_mcp.services.pod_connector_keypair_service import generate_pod_keypair
from hushh_mcp.services.pod_key_collector import (
    collect_pod_key_if_pending,
    fetch_pod_public_key,
)

_UID = "firebase-uid-0123456789abcdefghij"
_PHONE = "+14155550123"
_POD_URL = "https://pod-abc-uc.a.run.app"


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


class _FakeBackend:
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
    def __init__(self, status_code: int, body: Any = None) -> None:
        self.status_code = status_code
        self._body = body

    def json(self) -> Any:
        if self._body is None:
            raise ValueError("no body")
        return self._body


class _Session:
    """Records every URL fetched, so a test can assert WHERE the hub went."""

    def __init__(self, response: _Response) -> None:
        self.response = response
        self.urls: list[str] = []

    def get(self, url: str, **_: Any) -> _Response:
        self.urls.append(url)
        return self.response


def _service(registry: _FakeRegistry, grant: _FakeGrant) -> PersonalAgentProvisioningService:
    return PersonalAgentProvisioningService(registry=registry, grant=grant, backend=_FakeBackend())


@pytest.fixture(autouse=True)
def _enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")


@pytest.mark.asyncio
async def test_provision_without_a_key_stops_at_connecting_and_mints_nothing():
    registry, grant = _FakeRegistry(), _FakeGrant()

    result = await _service(registry, grant).provision(user_id=_UID, phone_e164=_PHONE)

    assert result["status"] == "connecting"
    assert registry.rows[_UID]["status"] == "connecting"
    # The whole point of stopping: read authority is not granted to a pod that has
    # not yet proved it exists by publishing a key.
    assert grant.issued == 0
    assert result["standingReadExpiresAt"] is None
    assert "pod_pubkey" not in registry.rows[_UID]


@pytest.mark.asyncio
async def test_supplying_a_key_still_provisions_in_one_pass():
    """The owner-authorized route's behaviour must be completely unchanged."""
    registry, grant = _FakeRegistry(), _FakeGrant()
    keypair = generate_pod_keypair()

    result = await _service(registry, grant).provision(
        user_id=_UID,
        phone_e164=_PHONE,
        pod_public_key_b64=keypair.public_key_b64,
        pod_key_id=keypair.key_id,
    )

    assert result["status"] == "provisioned"
    assert registry.rows[_UID]["status"] == "provisioned"
    assert grant.issued == 1


@pytest.mark.asyncio
async def test_half_a_keypair_is_a_caller_bug_not_a_deferred_key():
    """Silently treating this as 'deferred' would drop a key the caller sent."""
    registry, grant = _FakeRegistry(), _FakeGrant()

    with pytest.raises(ValueError):
        await _service(registry, grant).provision(
            user_id=_UID, phone_e164=_PHONE, pod_public_key_b64="abc"
        )


@pytest.mark.asyncio
async def test_a_failed_provision_marks_the_row_failed():
    """Without this writer 'provisioning_failed' is a state nothing can ever reach."""

    class _ExplodingBackend(_FakeBackend):
        async def provision(self, spec: PodSpec) -> BackendHandle:
            raise RuntimeError("no capacity")

    registry, grant = _FakeRegistry(), _FakeGrant()
    service = PersonalAgentProvisioningService(
        registry=registry, grant=grant, backend=_ExplodingBackend()
    )

    with pytest.raises(RuntimeError):
        await service.provision(user_id=_UID, phone_e164=_PHONE)

    assert registry.rows[_UID]["status"] == "provisioning_failed"


@pytest.mark.asyncio
async def test_the_hub_fetches_from_the_url_it_recorded_itself():
    """The security property: the address is ours, so there is no identity to forge."""
    keypair = generate_pod_keypair()
    session = _Session(
        _Response(
            200,
            {
                "podPublicKey": keypair.public_key_b64,
                "podKeyId": keypair.key_id,
                "podKeyWrappingAlg": keypair.wrapping_alg,
            },
        )
    )
    row = {"backend_metadata": {"url": _POD_URL}}

    payload = await fetch_pod_public_key(row, session=session)

    assert payload is not None
    assert payload["podPublicKey"] == keypair.public_key_b64
    assert session.urls == [f"{_POD_URL}/pod/public-key"]


@pytest.mark.asyncio
async def test_a_non_https_recorded_url_is_refused():
    """Our own adapter always writes https; anything else means something is wrong."""
    session = _Session(_Response(200, {"podPublicKey": "x", "podKeyId": "y"}))

    result = await fetch_pod_public_key(
        {"backend_metadata": {"url": "http://pod"}}, session=session
    )

    assert result is None
    # Refused before any request left the process, not after reading the answer.
    assert session.urls == []


@pytest.mark.asyncio
async def test_a_pod_that_is_not_up_yet_changes_nothing():
    registry, grant = _FakeRegistry(), _FakeGrant()
    await _service(registry, grant).provision(user_id=_UID, phone_e164=_PHONE)
    row = dict(registry.rows[_UID], user_id=_UID)

    session = _Session(_Response(503))
    result = await collect_pod_key_if_pending(
        row, service=_service(registry, grant), session=session
    )

    assert result is None
    assert registry.rows[_UID]["status"] == "connecting"
    assert grant.issued == 0


@pytest.mark.asyncio
async def test_collecting_the_key_mints_the_grant_and_provisions():
    registry, grant = _FakeRegistry(), _FakeGrant()
    service = _service(registry, grant)
    await service.provision(user_id=_UID, phone_e164=_PHONE)
    row = dict(registry.rows[_UID], user_id=_UID)

    keypair = generate_pod_keypair()
    session = _Session(
        _Response(200, {"podPublicKey": keypair.public_key_b64, "podKeyId": keypair.key_id})
    )

    status = await collect_pod_key_if_pending(row, service=service, session=session)

    assert status == "provisioned"
    assert registry.rows[_UID]["status"] == "provisioned"
    assert registry.rows[_UID]["pod_pubkey"] == keypair.public_key_b64
    assert grant.issued == 1


@pytest.mark.asyncio
async def test_only_a_connecting_row_is_collected():
    """A provisioned row must not be re-fetched; a provisioning one has no host yet."""
    session = _Session(_Response(200, {"podPublicKey": "x", "podKeyId": "y"}))

    for status in ("pending", "provisioning", "provisioned", "provisioning_failed"):
        row = {"user_id": _UID, "status": status, "backend_metadata": {"url": _POD_URL}}
        assert await collect_pod_key_if_pending(row, session=session) is None
    assert session.urls == []


@pytest.mark.asyncio
async def test_re_registering_the_same_key_is_idempotent_and_mints_once():
    registry, grant = _FakeRegistry(), _FakeGrant()
    service = _service(registry, grant)
    await service.provision(user_id=_UID, phone_e164=_PHONE)
    keypair = generate_pod_keypair()

    first = await service.attach_pod_public_key(
        user_id=_UID, pod_public_key_b64=keypair.public_key_b64, pod_key_id=keypair.key_id
    )
    second = await service.attach_pod_public_key(
        user_id=_UID, pod_public_key_b64=keypair.public_key_b64, pod_key_id=keypair.key_id
    )

    assert first["status"] == "provisioned"
    assert second["status"] == "provisioned"
    # A restarting pod re-presenting its key must not accumulate standing grants.
    assert grant.issued == 1


@pytest.mark.asyncio
async def test_a_different_key_is_refused_rather_than_rebound():
    """Rebinding would let whoever reached this path take over the agent's identity."""
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
    assert grant.issued == 1
