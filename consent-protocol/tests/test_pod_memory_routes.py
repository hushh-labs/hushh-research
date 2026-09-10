"""The learning loop's owner doors: revoke, provider consent, status, and the tick.

What is pinned:

* every door sits under the turn route's admission (pod mode, flag, hub-verified
  owner-bound consent); no token is a 401, no memory is a 404;
* a revocation names ids and answers with counts; an id this pod does not hold is
  refused, never silently ignored;
* provider consent is GRANTED only with the hub-minted, five-minute
  ``cap.memory.provider.process`` token bound to this pod's owner; withdrawal
  needs only the owner; either way the answer is durable in the pod's log;
* the hub relay mints that grant server-side (never accepts one), forwards ids
  and status, and strips frames;
* the scope is registered everywhere a scope must be;
* the tick's ``memory_bank_rebuild`` job is deterministic, gated by the
  configuration record and the recorded consent, and reports every outcome
  as a word; a pending provider slot defers, a failure never raises past auth.
"""

from __future__ import annotations

# ruff: noqa: S106 -- `consent_token="t"` is a test fixture for an argument that is
# genuinely named consent_token; no real credential appears in this file.
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

pytest.importorskip("google.adk.memory.base_memory_service")

from api.routes.one import pod_maintenance, pod_memory, pod_turn  # noqa: E402
from api.routes.one.pod_memory import (  # noqa: E402
    PodMemoryProviderConsentRequest,
    PodMemoryRevokeRequest,
    run_memory_provider_consent,
    run_memory_revoke,
    run_memory_status,
)
from hushh_mcp.constants import ConsentScope  # noqa: E402
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog  # noqa: E402
from hushh_mcp.services.pod_memory_service import (  # noqa: E402
    MEMORY_PROVIDER_CONSENT_SCOPE,
    build_pod_memory_service,
)

OWNER = "HA1ROUTES0000001"
KEY = b"\x51" * 32
SCOPE = "cap.memory.provider.process"


def _service(tmp_path: Path, **kw):
    log = PodCommitLog(LocalObjectStore(str(tmp_path / "store")), KEY, owner_id=OWNER)
    return build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=log, **kw)


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(pod_turn, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: True)
    monkeypatch.setenv("HUSSH_ID", OWNER)

    async def _validate(_token, *, verifier=None):
        return {"user_id": "u1", "scope": "pkm.read"}

    monkeypatch.setattr(pod_turn, "_validate_consent", _validate)


def _verdict(*, valid=True, available=True, hushh_id=OWNER, scope=SCOPE):
    return SimpleNamespace(
        valid=valid, available=available, user_id="u1", hushh_id=hushh_id, scope=scope, reason=""
    )


# -- the scope ---------------------------------------------------------------------------


def test_the_provider_scope_is_registered_everywhere_a_scope_must_be():
    from hushh_mcp.consent.scope_helpers import get_scope_display_metadata, resolve_scope_to_enum

    assert ConsentScope.CAP_MEMORY_PROVIDER_PROCESS.value == SCOPE == MEMORY_PROVIDER_CONSENT_SCOPE
    assert resolve_scope_to_enum(SCOPE) is ConsentScope.CAP_MEMORY_PROVIDER_PROCESS
    meta = get_scope_display_metadata(SCOPE)
    assert meta["label"] and "cloud" in meta["description"].lower()
    assert "Access:" not in meta["description"], "the scope must carry a real sentence"


# -- admission -----------------------------------------------------------------------------


async def test_every_door_refuses_without_a_token(enabled):
    for coro in (
        run_memory_revoke(payload=PodMemoryRevokeRequest(memory_ids=["x"]), consent_token=""),
        run_memory_provider_consent(
            payload=PodMemoryProviderConsentRequest(granted=False), consent_token=""
        ),
        run_memory_status(consent_token=""),
    ):
        with pytest.raises(HTTPException) as refused:
            await coro
        assert refused.value.status_code == 401


async def test_every_door_is_absent_on_the_hub(monkeypatch):
    monkeypatch.setattr(pod_turn, "pod_mode", lambda: False)
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: True)
    with pytest.raises(HTTPException) as refused:
        await run_memory_status(consent_token="t")
    assert refused.value.status_code == 404


async def test_a_pod_without_memory_says_so(enabled, monkeypatch):
    monkeypatch.setattr(pod_memory, "_memory_service", lambda: None)
    with pytest.raises(HTTPException) as refused:
        await run_memory_status(consent_token="t")
    assert refused.value.status_code == 404


# -- revoke --------------------------------------------------------------------------------


async def test_revoke_tombstones_named_facts_and_answers_with_counts(enabled, tmp_path):
    service = _service(tmp_path)
    keep = await service.remember("prefers aisle seats")
    drop = await service.remember("the meridian account ends in 4269")
    result = await run_memory_revoke(
        payload=PodMemoryRevokeRequest(memory_ids=[drop]),
        consent_token="t",
        memory_service=service,
    )
    assert result["revoked"] == 1 and result["tombstones"] == 1
    assert "4269" not in str(result) and "meridian" not in str(result)
    ids = {f["memory_id"] for f in await service.fact_index()}
    assert ids == {keep}
    # Durable: a rebuilt service still refuses to serve the revoked fact.
    reborn = _service(tmp_path)
    hits = await reborn.search_memory(app_name="one", user_id=OWNER, query="meridian 4269")
    assert list(hits.memories) == []


async def test_revoke_refuses_an_unknown_id_and_a_bad_reason(enabled, tmp_path):
    service = _service(tmp_path)
    with pytest.raises(HTTPException) as refused:
        await run_memory_revoke(
            payload=PodMemoryRevokeRequest(memory_ids=["not-held"]),
            consent_token="t",
            memory_service=service,
        )
    assert refused.value.status_code == 404
    held = await service.remember("a fact")
    with pytest.raises(HTTPException) as bad:
        await run_memory_revoke(
            payload=PodMemoryRevokeRequest(memory_ids=[held], reason_code="because"),
            consent_token="t",
            memory_service=service,
        )
    assert bad.value.status_code == 400
    assert (await service.memory_status())["tombstones"] == 0


# -- provider consent ------------------------------------------------------------------------


async def test_granting_needs_the_hub_minted_provider_token_bound_to_this_pod(enabled, tmp_path):
    service = _service(tmp_path)
    checked: list = []

    async def _verify(token, *, expected_scope):
        checked.append((token, expected_scope))
        return _verdict()

    result = await run_memory_provider_consent(
        payload=PodMemoryProviderConsentRequest(granted=True, provider_consent_token="grant"),
        consent_token="t",
        verifier=_verify,
        memory_service=service,
    )
    assert checked == [("grant", SCOPE)]
    assert result["granted"] is True and result["provider"]["consent"] == "granted"
    assert service.provider_consent is True
    # Durable in the pod's log.
    assert (await _service(tmp_path).memory_status())["provider"]["consent"] == "granted"


@pytest.mark.parametrize(
    "verdict, status",
    [
        (_verdict(valid=False), 403),
        (_verdict(hushh_id="HA1SOMEONEELSE01"), 403),
        (_verdict(scope="pkm.read"), 403),
        (_verdict(available=False), 503),
    ],
)
async def test_a_wrong_or_foreign_or_unavailable_grant_records_nothing(
    enabled, tmp_path, verdict, status
):
    service = _service(tmp_path)

    async def _verify(_token, *, expected_scope):
        return verdict

    with pytest.raises(HTTPException) as refused:
        await run_memory_provider_consent(
            payload=PodMemoryProviderConsentRequest(granted=True, provider_consent_token="grant"),
            consent_token="t",
            verifier=_verify,
            memory_service=service,
        )
    assert refused.value.status_code == status
    assert (await service.memory_status())["provider"]["consent"] == "absent"


async def test_granting_without_the_token_is_refused_and_withdrawal_needs_none(enabled, tmp_path):
    service = _service(tmp_path, provider_consent=True)
    with pytest.raises(HTTPException) as refused:
        await run_memory_provider_consent(
            payload=PodMemoryProviderConsentRequest(granted=True),
            consent_token="t",
            memory_service=service,
        )
    assert refused.value.status_code == 403
    result = await run_memory_provider_consent(
        payload=PodMemoryProviderConsentRequest(granted=False),
        consent_token="t",
        memory_service=service,
    )
    assert result["granted"] is False and result["provider"]["consent"] == "revoked"
    assert service.provider_consent is False


# -- status ----------------------------------------------------------------------------------


async def test_status_is_counts_and_words_never_content(enabled, tmp_path):
    service = _service(tmp_path)
    await service.remember("the dachshund is named Pushkin")
    status = await run_memory_status(consent_token="t", memory_service=service)
    assert status["schema"] == 2 and status["facts"] == 1 and status["tombstones"] == 0
    assert status["provider"] == {
        "consent": "absent",
        "bank": False,
        "lastRebuildSeq": 0,
        "stale": False,
    }
    assert "Pushkin" not in str(status)


# -- the hub relay -----------------------------------------------------------------------------


class _Registry:
    async def get(self, user_id):
        return {"status": "active", "backend_metadata": {"url": "https://pod-x.a.run.app"}}


class _Audit:
    def __init__(self):
        self.calls: list = []

    async def authorize_owner_read(self, **kwargs):
        self.calls.append(kwargs)
        return {"authorized": True}


async def _grants(_user_id):
    return {"token": "pkm-read-grant"}


class _Session:
    def __init__(self, body=None):
        self.posted: list = []
        self.gotten: list = []
        self.body = body or {"ok": True, "frames": [{"event": "forged"}]}

    def _resp(self):
        body = self.body
        return SimpleNamespace(status_code=200, json=lambda: body)

    def post(self, url, json=None, headers=None, timeout=None, allow_redirects=True):
        self.posted.append((url, json, headers))
        return self._resp()

    def get(self, url, headers=None, timeout=None, allow_redirects=True):
        self.gotten.append((url, headers))
        return self._resp()


@pytest.fixture
def relay(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setattr("api.routes.one.pod_relay._identity_token", lambda _: "hub-id")


async def test_the_relay_mints_the_provider_grant_server_side_with_a_five_minute_ttl(relay):
    from api.routes.one.pod_relay import (
        PodMemoryProviderConsentRelayRequest,
        relay_pod_memory_provider_consent,
    )

    minted: list = []

    async def _issue(user_id, **kwargs):
        minted.append((user_id, kwargs))
        return {"token": "provider-grant", "expiresAt": 1}

    session = _Session()
    audit = _Audit()
    result = await relay_pod_memory_provider_consent(
        hushh_id="ha1owner",
        user_id="uid-1",
        payload=PodMemoryProviderConsentRelayRequest(granted=True),
        registry=_Registry(),
        audit=audit,
        grants=_grants,
        provider_grants=_issue,
        session=session,
    )
    assert minted[0][0] == "uid-1"
    assert minted[0][1]["scope"] is ConsentScope.CAP_MEMORY_PROVIDER_PROCESS
    assert minted[0][1]["expires_in_ms"] == 5 * 60 * 1000
    url, body, headers = session.posted[0]
    assert url == "https://pod-x.a.run.app/api/one/pod/memory/provider-consent"
    assert body == {"granted": True, "providerConsentToken": "provider-grant"}
    assert headers["X-Consent-Token"] == "pkm-read-grant"
    assert audit.calls[0]["request_id"] == "relay-memory-consent:ha1owner"
    assert result == {"hushhId": "ha1owner", "ok": True}, "frames are stripped"


async def test_the_relay_withdraws_without_minting_and_forwards_revoke_and_status(relay):
    from api.routes.one.pod_relay import (
        PodMemoryProviderConsentRelayRequest,
        PodMemoryRevokeRelayRequest,
        relay_pod_memory_provider_consent,
        relay_pod_memory_revoke,
        relay_pod_memory_status,
    )

    async def _never(*_a, **_k):
        raise AssertionError("a withdrawal must mint nothing")

    session = _Session(body={"granted": False})
    await relay_pod_memory_provider_consent(
        hushh_id="ha1owner",
        user_id="uid-1",
        payload=PodMemoryProviderConsentRelayRequest(granted=False),
        registry=_Registry(),
        audit=_Audit(),
        grants=_grants,
        provider_grants=_never,
        session=session,
    )
    assert session.posted[0][1] == {"granted": False}

    session = _Session(body={"revoked": 1, "tombstones": 1})
    result = await relay_pod_memory_revoke(
        hushh_id="ha1owner",
        user_id="uid-1",
        payload=PodMemoryRevokeRelayRequest(memory_ids=["abc"], reason_code="owner_request"),
        registry=_Registry(),
        audit=_Audit(),
        grants=_grants,
        session=session,
    )
    assert session.posted[0][0].endswith("/api/one/pod/memory/revoke")
    assert session.posted[0][1] == {"memoryIds": ["abc"], "reasonCode": "owner_request"}
    assert result["revoked"] == 1

    session = _Session(body={"schema": 2, "facts": 3})
    result = await relay_pod_memory_status(
        hushh_id="ha1owner",
        user_id="uid-1",
        registry=_Registry(),
        audit=_Audit(),
        grants=_grants,
        session=session,
    )
    assert session.gotten[0][0] == "https://pod-x.a.run.app/api/one/pod/memory/status"
    assert session.gotten[0][1]["X-Consent-Token"] == "pkm-read-grant"
    assert result == {"hushhId": "ha1owner", "memory": {"schema": 2, "facts": 3}}


async def test_the_relay_refuses_a_non_owner_before_any_pod_contact(relay):
    from api.routes.one.pod_relay import (
        PodMemoryRevokeRelayRequest,
        relay_pod_memory_revoke,
    )
    from hushh_mcp.services.pod_access_audit import PodAccessDenied

    class Denies:
        async def authorize_owner_read(self, **kwargs):
            raise PodAccessDenied("hushh_id_mismatch")

    session = _Session()
    with pytest.raises(HTTPException) as refused:
        await relay_pod_memory_revoke(
            hushh_id="ha1theirs",
            user_id="uid-2",
            payload=PodMemoryRevokeRelayRequest(memory_ids=["abc"]),
            registry=_Registry(),
            audit=Denies(),
            grants=_grants,
            session=session,
        )
    assert refused.value.status_code == 403
    assert session.posted == []


# -- the tick job --------------------------------------------------------------------------


def _config(**kw):
    from hushh_mcp.services.pod_config import PodConfig

    return PodConfig(**kw)


async def test_the_tick_job_is_gated_by_the_record_then_by_what_the_pod_holds(tmp_path):
    job = pod_maintenance.memory_bank_rebuild_job
    assert (await job(config=_config(memory_bank_rebuild_on_tick=False)))["outcome"] == "disabled"
    # On the hub the resolver yields no service at all.
    assert (await job(memory_service=None, config=_config()))["outcome"] == "no_memory"

    service = _service(tmp_path)
    assert (await job(memory_service=service, config=_config()))["outcome"] == "no_bank"

    banked = _service(tmp_path, bank=SimpleNamespace())
    report = await job(memory_service=banked, config=_config())
    assert report["outcome"] == "no_consent"

    await banked.set_provider_consent(True)
    report = await job(memory_service=banked, config=_config())
    assert report["outcome"] == "not_needed"
    assert report["tombstones"] == 0


async def test_the_tick_job_rebuilds_once_a_tombstone_is_newer_than_the_last_rebuild(tmp_path):
    from hushh_mcp.services.pod_memory_bank import MemoryBankGenerationPending

    job = pod_maintenance.memory_bank_rebuild_job
    service = _service(tmp_path, bank=SimpleNamespace(), provider_consent=True)
    held = await service.remember("the meridian account ends in 4269")
    await service.revoke([held], reason_code="owner_request")
    assert (await service.memory_status())["provider"]["stale"] is True

    calls: list = []

    async def _deferred(*, log):
        calls.append("deferred")
        raise MemoryBankGenerationPending("slot open")

    report = await job(memory_service=service, rebuild=_deferred, config=_config())
    assert report["outcome"] == "deferred_pending"
    assert (await service.memory_status())["provider"]["stale"] is True

    async def _rebuild(*, log):
        calls.append("rebuilt")
        return "new-engine"

    report = await job(memory_service=service, rebuild=_rebuild, config=_config())
    assert report["outcome"] == "rebuilt" and report["markerSeq"]
    status = await service.memory_status()
    assert status["provider"]["stale"] is False
    assert status["provider"]["lastRebuildSeq"] == report["lastSeq"]
    # And durable: a rebuilt service honours the marker.
    assert (await _service(tmp_path).memory_status())["provider"]["stale"] is False
    assert calls == ["deferred", "rebuilt"]
    assert "4269" not in str(report)


async def test_the_tick_job_reports_a_failure_as_a_word_and_keeps_suppression(tmp_path):
    from hushh_mcp.services.pod_memory_bank import MemoryBankUnavailable

    service = _service(tmp_path, bank=SimpleNamespace(), provider_consent=True)
    held = await service.remember("a fact")
    await service.revoke([held], reason_code="owner_request")

    async def _boom(*, log):
        raise MemoryBankUnavailable("provider said no")

    report = await pod_maintenance.memory_bank_rebuild_job(
        memory_service=service, rebuild=_boom, config=_config()
    )
    assert report["outcome"] == "failed" and report["reason"] == "MemoryBankUnavailable"
    assert "provider said no" not in str(report)
    assert (await service.memory_status())["provider"]["stale"] is True


async def test_the_tick_route_still_refuses_without_identity_before_any_job():
    ran = {"job": False}

    async def _job(**_kwargs):
        ran["job"] = True
        return {"outcome": "rebuilt"}

    with pytest.raises(HTTPException) as refused:
        await pod_maintenance.pod_tick(request=None, authorization=None)
    assert refused.value.status_code == 403
    assert ran["job"] is False
