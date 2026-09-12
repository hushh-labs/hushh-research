"""The learning loop's owner doors: revoke, provider consent, status, and the tick.

What is pinned:

* every door sits under the turn route's admission (pod mode, flag, an owner-bound
  consent); no token is a 401, no memory is a 404;
* every door opens through either of the turn route's TWO doors: a hub-verified
  ``X-Consent-Token``, or this pod's own app-role session as the bearer, with no
  hub reachable at all. A device-role session, a revoked subject and a bearer that
  is not a pod session are each refused, and the hub door is unchanged. This is
  pinned through the real route functions, not only through the cores, because a
  core call bypasses the door entirely;
* whether the feature is on is answered BEFORE any door opens: a disabled pod is
  404 to every caller, bearer or not, and never a 503 that says its local authority
  is down;
* an owner-local token without its verified session is refused outright, so the
  role and scope questions cannot be skipped by omitting the claims;
* revocation, alone among the doors, requires the binding's ``pod.revoke`` scope,
  and that scope governs every route that can retire a fact, not only this one: a
  call made with a binding narrowed to reading cannot tombstone through the revoke
  route, through a conversation close, or through a turn that triggers a catch-up
  review. The same claim about a binding that DOES carry the scope is pinned too,
  on both doors, because a narrowing that disarms the owner is not a narrowing;
* a review that had to deny a retirement writes nothing at all, so a correction
  the caller may not apply never lands beside the fact it was meant to replace;
* a revocation names ids and answers with counts; an id this pod does not hold is
  refused, never silently ignored;
* provider consent is GRANTED only with the hub-minted, five-minute
  ``cap.memory.provider.process`` token bound to this pod's owner, and an
  owner-local session can never stand in for it, not even when its own binding
  names the scope; withdrawal needs only the owner; either way the answer is durable in the pod's log;
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


# -- the owner-local door ----------------------------------------------------------------
#
# The same two doors the turn route has (api/routes/one/pod_turn.py): a hub token, or
# this pod's own app-role session. These build a REAL authority over a real log, so
# every refusal below is the authority's own and not a stub's, and they stub the hub's
# `verify_consent` with a function that raises: a test that passes here cannot have
# asked the hub, which is the whole point on a laptop where no metadata server exists.

LOCAL_USER = "uid-local"


@pytest.fixture
async def local_authority(tmp_path, monkeypatch):
    """A live pod session authority for OWNER, plus an ``admit`` for its subjects."""
    import base64
    import json
    import time

    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    from api.routes.one import pod_session
    from hushh_mcp.consent import token_signing
    from hushh_mcp.services import pod_authority_store as store_module
    from hushh_mcp.services import pod_session_authority as psa

    hub = Ed25519PrivateKey.generate()
    seed = hub.private_bytes(
        serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()
    )
    public = hub.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    monkeypatch.setenv("CONSENT_ED25519_PRIVATE_KEY", base64.b64encode(seed).decode())
    monkeypatch.setenv("CONSENT_ED25519_KID", "kid-memory")
    monkeypatch.setenv(
        "CONSENT_ED25519_PUBLIC_KEYS", json.dumps({"kid-memory": base64.b64encode(public).decode()})
    )
    token_signing.reset_caches()

    # Pod mode on both doors, and the hub's own verifier replaced by a refusal: the
    # owner-local path must never reach it, and the hub path is stubbed at
    # `pod_turn._validate_consent` by the `enabled` fixture instead.
    monkeypatch.setattr(pod_turn, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: True)
    monkeypatch.setattr(pod_session, "pod_mode", lambda: True)
    monkeypatch.setenv("HUSSH_ID", OWNER)

    object_store = LocalObjectStore(str(tmp_path / "authority"))
    log = PodCommitLog(object_store, KEY, owner_id=OWNER)
    incarnation = await store_module.claim_incarnation(object_store, KEY, instance_id="rev-a")
    store = store_module.PodAuthorityStore(log, hushh_id=OWNER)
    await store.load()
    authority = psa.PodSessionAuthority(
        store=store,
        lease=store_module.IncarnationLease(object_store, incarnation),
        dek=KEY,
        pod_key_id="podk_memory",
        pod_public_key=base64.b64encode(b"K" * 32).decode(),
        environment="dev",
    )
    store_module.set_active_authority_store(store)
    psa.set_active_session_authority(authority)

    class Subject:
        def __init__(self, subject_id, platform):
            self.subject_id, self.platform = subject_id, platform
            self._key = ec.generate_private_key(ec.SECP256R1())
            self.public_key_b64 = base64.b64encode(
                self._key.public_key().public_bytes(
                    serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
                )
            ).decode()

        def sign(self, payload):
            return base64.b64encode(
                self._key.sign(payload.encode(), ec.ECDSA(hashes.SHA256()))
            ).decode()

    async def admit(subject_id, platform, *, version=1, scopes=None):
        subject = Subject(subject_id, platform)
        role = psa.role_for_platform(platform)
        now = int(time.time() * 1000)
        binding = {
            "kind": psa.BINDING_KIND,
            "hushh_id": OWNER,
            "user_id": LOCAL_USER,
            "environment": "dev",
            "pod_key_id": "podk_memory",
            "pod_public_key": base64.b64encode(b"K" * 32).decode(),
            "url": "https://pod.example",
            "subject_id": subject_id,
            "subject_kind": role,
            "subject_public_key": subject.public_key_b64,
            "platform": platform,
            "role": role,
            "scopes": list(
                scopes
                if scopes is not None
                else (psa.APP_SCOPES if role == "app" else psa.DEVICE_INFERENCE_SCOPES)
            ),
            "version": version,
            "issued_at_ms": now,
            "expires_at_ms": now + 86_400_000,
        }
        signature = token_signing.sign_payload(
            psa.canonical_json(binding), hmac_key="x", require_asymmetric=True
        )
        challenge = authority.create_challenge(subject_id)
        return await authority.admit(
            binding=binding,
            signature=signature,
            challenge_id=challenge["challenge_id"],
            nonce=challenge["nonce"],
            proof=subject.sign(challenge["signing_payload"]),
            epoch=authority.epoch,
        )

    yield {"authority": authority, "admit": admit, "store": store}
    psa.set_active_session_authority(None)
    store_module.set_active_authority_store(None)
    token_signing.reset_caches()


@pytest.fixture
def no_hub(monkeypatch):
    """Any call that reaches the hub's verifier fails the test, loudly."""
    from hushh_mcp.services import pod_consent_client

    async def _never(*_a, **_k):
        raise AssertionError("the hub was asked on an owner-local call")

    monkeypatch.setattr(pod_consent_client, "verify_consent", _never)


def _local(authority, claims, **extra) -> dict:
    """What the route's ``_owner_door`` hands a core for an owner-local caller."""
    return {
        "consent_token": authority.local_token(claims),
        "verifier": authority.local_verifier(claims),
        "session": claims,
        **extra,
    }


def test_every_memory_route_declares_both_doors():
    """FastAPI must extract the bearer on every memory door, or it is unreachable.

    A surface guard only: declaring the header is necessary and nowhere near
    sufficient, and this stays green if a route ignores what it extracted. The
    functional pins are the route-level tests further down, and the reachability of
    each path over the pod's ingress policy is pinned in ``tests/test_pod_server.py``.
    """
    from api.routes.one import pod_consumer_memory

    wanted = {
        "/api/one/pod/conversation/{conversation_id}/close",
        "/api/one/pod/memory/revoke",
        "/api/one/pod/memory/provider-consent",
        "/api/one/pod/consumer/memory",
        "/api/one/pod/memory/status",
    }
    seen = {
        route.path: {param.alias.lower() for param in route.dependant.header_params}
        for router in (pod_memory.router, pod_consumer_memory.router)
        for route in router.routes
        if getattr(route, "path", "") in wanted
    }
    assert set(seen) == wanted
    for path, headers in seen.items():
        expected = {"x-consent-token"}
        if path != "/api/one/pod/consumer/memory":
            expected.add("authorization")
        assert headers == expected, path


@pytest.mark.asyncio
async def test_consumer_memory_route_owns_execution_metadata(monkeypatch):
    from types import SimpleNamespace

    from api.routes.one import pod_consumer_memory

    async def _scope(*_args, **_kwargs):
        return SimpleNamespace(user_id="owner-a")

    async def _execute(*_args, **_kwargs):
        return {
            "provider": "shared_runtime",
            "execution_target": "foreign_pod",
            "result": {"revision": 4},
        }

    monkeypatch.setattr(pod_consumer_memory, "require_owner_scope", _scope)
    monkeypatch.setattr(pod_consumer_memory, "execute_pod_consumer_memory", _execute)
    response = await pod_consumer_memory.pod_consumer_memory_route(
        pod_consumer_memory.PodConsumerMemoryRequest(
            ownerId="owner-a",
            connectionId="connection-a",
            generation=2,
            operation="read",
            arguments={"domain": "food", "query": "veg", "limit": 10},
        ),
        x_consent_token="token",
    )

    assert response == {
        "provider": "owner_pod_pkm",
        "execution_target": "owner_pod",
        "result": {"revision": 4},
    }


@pytest.mark.asyncio
async def test_consumer_memory_route_rejects_untyped_executor_response(monkeypatch):
    from types import SimpleNamespace

    from api.routes.one import pod_consumer_memory

    async def _scope(*_args, **_kwargs):
        return SimpleNamespace(user_id="owner-a")

    async def _execute(*_args, **_kwargs):
        return {"provider": "owner_pod_pkm", "execution_target": "owner_pod"}

    monkeypatch.setattr(pod_consumer_memory, "require_owner_scope", _scope)
    monkeypatch.setattr(pod_consumer_memory, "execute_pod_consumer_memory", _execute)
    with pytest.raises(HTTPException) as error:
        await pod_consumer_memory.pod_consumer_memory_route(
            pod_consumer_memory.PodConsumerMemoryRequest(
                ownerId="owner-a",
                connectionId="connection-a",
                generation=2,
                operation="read",
                arguments={"domain": "food", "query": "veg", "limit": 10},
            ),
            x_consent_token="token",
        )
    assert error.value.status_code == 503


async def test_the_close_door_opens_for_an_owner_local_session_with_no_hub(
    local_authority, no_hub, monkeypatch
):
    from hushh_mcp.one_adk.memory_review import MemoryReviewResult
    from hushh_mcp.services.pod_config import PodConfig, set_active_pod_config

    monkeypatch.setattr(pod_turn, "_resolve_model", lambda *_a, **_k: ("gemini", "gemini-test"))
    set_active_pod_config(PodConfig())
    authority = local_authority["authority"]
    _token, claims = await local_authority["admit"]("tdv_web_1", "web")
    seen: dict = {}

    async def _review(**kwargs):
        seen.update(kwargs)
        return MemoryReviewResult(
            outcome="applied",
            reason="close",
            through_seq=3,
            records=1,
            ops={"remember": 1, "supersede": 0, "forget": 0, "pkm_proposals": 0, "refused": 0},
            provider="gemini",
            model="gemini-test",
            elapsed_ms=4,
            checkpoint_seq=4,
        )

    try:
        result = await pod_memory.run_conversation_close(
            conversation_id="conv-local",
            payload=pod_memory.PodConversationCloseRequest(runtime_credential="owner-key"),
            review_fn=_review,
            memory_service=object(),
            model_builder=lambda **_k: "the-model-object",
            **_local(authority, claims),
        )
    finally:
        set_active_pod_config(None)

    assert result["memory"]["review"]["outcome"] == "applied"
    assert result["memory"]["written"] == 1
    # The review is owner-scoped to the pod's own identity, exactly as on the hub door.
    assert seen["session_owner_id"] == OWNER


async def test_revoke_and_status_open_for_an_owner_local_session_with_no_hub(
    local_authority, no_hub, tmp_path
):
    authority = local_authority["authority"]
    _token, claims = await local_authority["admit"]("tdv_web_1", "web")
    service = _service(tmp_path)
    keep = await service.remember("prefers aisle seats")
    drop = await service.remember("the meridian account ends in 4269")

    status = await run_memory_status(memory_service=service, **_local(authority, claims))
    assert status["schema"] == 2 and status["facts"] == 2

    result = await run_memory_revoke(
        payload=PodMemoryRevokeRequest(memory_ids=[drop]),
        memory_service=service,
        **_local(authority, claims),
    )
    assert result["revoked"] == 1 and result["tombstones"] == 1
    assert {f["memory_id"] for f in await service.fact_index()} == {keep}
    assert "4269" not in str(result) and "4269" not in str(status)


async def test_an_owner_local_session_withdraws_provider_consent_with_no_hub(
    local_authority, no_hub, tmp_path
):
    authority = local_authority["authority"]
    _token, claims = await local_authority["admit"]("tdv_web_1", "web")
    service = _service(tmp_path, provider_consent=True)

    result = await run_memory_provider_consent(
        payload=PodMemoryProviderConsentRequest(granted=False),
        memory_service=service,
        **_local(authority, claims),
    )
    assert result["granted"] is False and result["provider"]["consent"] == "revoked"
    assert service.provider_consent is False
    # Durable in the pod's own log, with nothing reachable.
    assert (await _service(tmp_path).memory_status())["provider"]["consent"] == "revoked"


async def test_an_owner_local_session_can_never_stand_in_for_the_provider_grant(
    local_authority, tmp_path, monkeypatch
):
    """The one door the local session does NOT open by itself: granting.

    The session proves the owner is here. It never proves the owner agreed that a
    provider may process their memory, so the second grant is asked of the hub and
    never of the session, even when the session's own verifier would say yes.
    """
    from hushh_mcp.services import pod_consent_client
    from hushh_mcp.services.pod_session_authority import APP_SCOPES

    authority = local_authority["authority"]
    # A binding that names the provider scope: nothing constrains the scope list a
    # hub-signed binding may carry (``PodSessionAuthority.verify_binding`` checks the
    # signature, the owner, the deployment and the role, not the scope vocabulary), so
    # the session's own verifier WOULD accept the session's marker for this grant.
    # That is exactly why it is not the verifier asked.
    _token, claims = await local_authority["admit"]("tdv_web_1", "web", scopes=[*APP_SCOPES, SCOPE])
    marker = authority.local_token(claims)
    would_have_said_yes = await authority.local_verifier(claims)(marker, expected_scope=SCOPE)
    assert would_have_said_yes.valid is True

    asked: list = []

    async def _unreachable(token, *, expected_scope="", **_kw):
        asked.append((token, expected_scope))
        return pod_consent_client.ConsentVerdict(
            valid=False, available=False, reason="authority unreachable: laptop"
        )

    monkeypatch.setattr(pod_consent_client, "verify_consent", _unreachable)
    service = _service(tmp_path)
    with pytest.raises(HTTPException) as refused:
        await run_memory_provider_consent(
            payload=PodMemoryProviderConsentRequest(granted=True, provider_consent_token=marker),
            memory_service=service,
            **_local(authority, claims),
        )
    # Unreachable is its own answer: 503, never a silent grant and never a denial.
    assert refused.value.status_code == 503
    assert asked == [(marker, SCOPE)], "the hub, not the session, answers this question"
    assert (await service.memory_status())["provider"]["consent"] == "absent"

    # And with no second token at all it is a flat refusal, local door or not.
    with pytest.raises(HTTPException) as bare:
        await run_memory_provider_consent(
            payload=PodMemoryProviderConsentRequest(granted=True),
            memory_service=service,
            **_local(authority, claims),
        )
    assert bare.value.status_code == 403
    assert (await service.memory_status())["provider"]["consent"] == "absent"


async def test_a_real_hub_grant_still_grants_over_the_owner_local_door(
    local_authority, tmp_path, monkeypatch
):
    """Granting is not hub-only as a route; it is hub-only as a GRANT."""
    from hushh_mcp.services import pod_consent_client

    authority = local_authority["authority"]
    _token, claims = await local_authority["admit"]("tdv_web_1", "web")
    asked: list = []

    async def _hub_says_yes(token, *, expected_scope="", **_kw):
        asked.append((token, expected_scope))
        return _verdict()

    monkeypatch.setattr(pod_consent_client, "verify_consent", _hub_says_yes)
    service = _service(tmp_path)
    result = await run_memory_provider_consent(
        payload=PodMemoryProviderConsentRequest(granted=True, provider_consent_token="hub-grant"),
        memory_service=service,
        **_local(authority, claims),
    )
    assert asked == [("hub-grant", SCOPE)]
    assert result["granted"] is True and result["provider"]["consent"] == "granted"


async def test_a_device_role_session_is_refused_on_every_memory_door(
    local_authority, no_hub, tmp_path
):
    authority = local_authority["authority"]
    _token, claims = await local_authority["admit"]("tdv_mac_1", "macos")
    assert claims["role"] == "device"
    service = _service(tmp_path)
    held = await service.remember("a fact")

    doors = (
        pod_memory.run_conversation_close(
            conversation_id="conv-1",
            payload=pod_memory.PodConversationCloseRequest(runtime_credential="k"),
            memory_service=service,
            **_local(authority, claims),
        ),
        run_memory_revoke(
            payload=PodMemoryRevokeRequest(memory_ids=[held]),
            memory_service=service,
            **_local(authority, claims),
        ),
        run_memory_provider_consent(
            payload=PodMemoryProviderConsentRequest(granted=False),
            memory_service=service,
            **_local(authority, claims),
        ),
        run_memory_status(memory_service=service, **_local(authority, claims)),
    )
    for coro in doors:
        with pytest.raises(HTTPException) as refused:
            await coro
        assert refused.value.status_code == 403
        assert refused.value.detail["code"] == "role_mismatch"
    status = await service.memory_status()
    assert status["tombstones"] == 0 and status["provider"]["consent"] == "absent"


async def test_a_revoked_subject_is_refused_on_every_memory_door(local_authority, no_hub, tmp_path):
    authority = local_authority["authority"]
    _token, claims = await local_authority["admit"]("tdv_web_1", "web")
    service = _service(tmp_path)
    held = await service.remember("a fact")
    kwargs = _local(authority, claims)
    await authority.revoke_subject("tdv_web_1", reason="owner_revoked")

    doors = (
        pod_memory.run_conversation_close(
            conversation_id="conv-1",
            payload=pod_memory.PodConversationCloseRequest(runtime_credential="k"),
            memory_service=service,
            **kwargs,
        ),
        run_memory_revoke(
            payload=PodMemoryRevokeRequest(memory_ids=[held]), memory_service=service, **kwargs
        ),
        run_memory_provider_consent(
            payload=PodMemoryProviderConsentRequest(granted=False),
            memory_service=service,
            **kwargs,
        ),
        run_memory_status(memory_service=service, **kwargs),
    )
    for coro in doors:
        with pytest.raises(HTTPException) as refused:
            await coro
        assert refused.value.status_code == 403
    status = await service.memory_status()
    assert status["tombstones"] == 0 and status["provider"]["consent"] == "absent"

    # And the route refuses the bearer itself, with the authority's own code.
    with pytest.raises(HTTPException) as at_the_door:
        await pod_memory.pod_memory_status_route(
            x_consent_token=None, authorization=f"Bearer {_token}"
        )
    assert at_the_door.value.status_code == 403
    assert at_the_door.value.detail["code"] == "revoked"


async def test_the_routes_open_the_local_door_on_a_pod_session_bearer(
    local_authority, no_hub, tmp_path, monkeypatch
):
    token, _claims = await local_authority["admit"]("tdv_web_1", "web")
    service = _service(tmp_path)
    held = await service.remember("the dachshund is named Pushkin")
    monkeypatch.setattr(pod_memory, "_memory_service", lambda: service)

    status = await pod_memory.pod_memory_status_route(
        x_consent_token=None, authorization=f"Bearer {token}"
    )
    assert status["facts"] == 1 and "Pushkin" not in str(status)

    revoked = await pod_memory.pod_memory_revoke_route(
        payload=PodMemoryRevokeRequest(memory_ids=[held]),
        x_consent_token=None,
        authorization=f"Bearer {token}",
    )
    assert revoked["revoked"] == 1

    withdrawn = await pod_memory.pod_memory_provider_consent_route(
        payload=PodMemoryProviderConsentRequest(granted=False),
        x_consent_token=None,
        authorization=f"Bearer {token}",
    )
    assert withdrawn["granted"] is False


async def test_a_bearer_that_is_not_a_pod_session_is_refused_by_shape(local_authority, no_hub):
    """A hub consent token in the Authorization header is never local authority."""
    hct = "HCT:" + "eyJ1IjoxfQ" + ".deadbeef"
    for authorization in (f"Bearer {hct}", "Bearer pst1.forged.mac"):
        with pytest.raises(HTTPException) as refused:
            await pod_memory.pod_memory_status_route(
                x_consent_token=None, authorization=authorization
            )
        assert refused.value.status_code == 401
        assert refused.value.detail["code"] in {"not_local_authority", "bad_signature"}

    # No credential at all is still the 401 every core has always answered.
    with pytest.raises(HTTPException) as bare:
        await pod_memory.pod_memory_status_route(x_consent_token=None, authorization=None)
    assert bare.value.status_code == 401
    assert bare.value.detail == "consent token required"


async def test_a_hub_consent_token_still_opens_every_door_unchanged(
    enabled, local_authority, tmp_path, monkeypatch
):
    """The hub door is untouched: it wins over any bearer and never asks the authority."""
    from api.routes.one import pod_session

    def _never(*_a, **_k):
        raise AssertionError("the local authority was consulted on a hub-token call")

    monkeypatch.setattr(pod_session, "verified_session", _never)
    service = _service(tmp_path)
    held = await service.remember("a fact")
    monkeypatch.setattr(pod_memory, "_memory_service", lambda: service)

    status = await pod_memory.pod_memory_status_route(
        x_consent_token="hub-token", authorization="Bearer nonsense"
    )
    assert status["facts"] == 1
    revoked = await pod_memory.pod_memory_revoke_route(
        payload=PodMemoryRevokeRequest(memory_ids=[held]),
        x_consent_token="hub-token",
        authorization="Bearer nonsense",
    )
    assert revoked["revoked"] == 1
    withdrawn = await pod_memory.pod_memory_provider_consent_route(
        payload=PodMemoryProviderConsentRequest(granted=False),
        x_consent_token="hub-token",
        authorization=None,
    )
    assert withdrawn["granted"] is False


# -- the close ROUTE, not the core ---------------------------------------------------
#
# The tests above drive `run_conversation_close` directly, which bypasses
# `_owner_door` entirely: the close route's owner-local door could be reverted to
# the hub-only `consent_token=x_consent_token or ""` with every one of them still
# green. These go through the real route function, so the door itself is pinned.


def _close_review(seen: dict):
    from hushh_mcp.one_adk.memory_review import MemoryReviewResult

    async def _review(**kwargs):
        seen.update(kwargs)
        return MemoryReviewResult(
            outcome="applied",
            reason="close",
            through_seq=3,
            records=1,
            ops={"remember": 1, "supersede": 0, "forget": 0, "pkm_proposals": 0, "refused": 0},
            provider="gemini",
            model="gemini-test",
            elapsed_ms=4,
            checkpoint_seq=4,
        )

    return _review


@pytest.fixture
def close_runtime(monkeypatch):
    """The conversation-close runtime a route call needs: a model, a config, a review."""
    from hushh_mcp.one_adk import memory_review, text_runtime
    from hushh_mcp.services.pod_config import PodConfig, set_active_pod_config

    monkeypatch.setattr(pod_turn, "_resolve_model", lambda *_a, **_k: ("gemini", "gemini-test"))
    monkeypatch.setattr(text_runtime, "_runtime_model", lambda **_k: "the-model-object")
    seen: dict = {}
    monkeypatch.setattr(memory_review, "run_memory_review", _close_review(seen))
    set_active_pod_config(PodConfig())
    yield seen
    set_active_pod_config(None)


async def test_the_close_ROUTE_opens_the_local_door_on_a_pod_session_bearer(
    local_authority, no_hub, close_runtime, monkeypatch
):
    """The one memory door an owner could already reach over public pod ingress, now
    exercised the way an owner reaches it: through the route, with a bearer."""
    token, _claims = await local_authority["admit"]("tdv_web_1", "web")
    monkeypatch.setattr(pod_memory, "_memory_service", lambda: object())

    result = await pod_memory.pod_conversation_close_route(
        conversation_id="conv-http",
        payload=pod_memory.PodConversationCloseRequest(runtime_credential="owner-key"),
        x_consent_token=None,
        authorization=f"Bearer {token}",
    )
    assert result["conversationId"] == "conv-http"
    assert result["memory"]["review"]["outcome"] == "applied"
    assert result["memory"]["written"] == 1
    # The review ran owner-scoped to this pod, with no hub asked at any point.
    assert close_runtime["session_owner_id"] == OWNER


async def test_the_close_ROUTE_refuses_a_bearer_that_is_not_an_app_session(
    local_authority, no_hub, close_runtime, monkeypatch
):
    monkeypatch.setattr(pod_memory, "_memory_service", lambda: object())
    device_token, _claims = await local_authority["admit"]("tdv_mac_1", "macos")

    with pytest.raises(HTTPException) as device:
        await pod_memory.pod_conversation_close_route(
            conversation_id="conv-http",
            payload=pod_memory.PodConversationCloseRequest(runtime_credential="k"),
            x_consent_token=None,
            authorization=f"Bearer {device_token}",
        )
    assert device.value.status_code == 403
    assert device.value.detail["code"] == "role_mismatch"

    with pytest.raises(HTTPException) as shaped:
        await pod_memory.pod_conversation_close_route(
            conversation_id="conv-http",
            payload=pod_memory.PodConversationCloseRequest(runtime_credential="k"),
            x_consent_token=None,
            authorization="Bearer HCT:eyJ1IjoxfQ.deadbeef",
        )
    assert shaped.value.status_code == 401
    assert shaped.value.detail["code"] in {"not_local_authority", "bad_signature"}

    with pytest.raises(HTTPException) as bare:
        await pod_memory.pod_conversation_close_route(
            conversation_id="conv-http",
            payload=pod_memory.PodConversationCloseRequest(runtime_credential="k"),
            x_consent_token=None,
            authorization=None,
        )
    assert bare.value.status_code == 401
    assert bare.value.detail == "consent token required"
    assert close_runtime == {}, "no refusal reached the review"


async def test_the_close_ROUTE_still_takes_the_hub_token_unchanged(
    enabled, local_authority, close_runtime, monkeypatch
):
    from api.routes.one import pod_session

    def _never(*_a, **_k):
        raise AssertionError("the local authority was consulted on a hub-token call")

    monkeypatch.setattr(pod_session, "verified_session", _never)
    monkeypatch.setattr(pod_memory, "_memory_service", lambda: object())

    result = await pod_memory.pod_conversation_close_route(
        conversation_id="conv-hub",
        payload=pod_memory.PodConversationCloseRequest(runtime_credential="k"),
        x_consent_token="hub-token",
        authorization="Bearer nonsense",
    )
    assert result["memory"]["review"]["outcome"] == "applied"


# -- availability is answered before any door opens ----------------------------------


async def test_a_disabled_pod_answers_404_on_every_door_bearer_or_not(local_authority, monkeypatch):
    """With the feature off, a bearer must not buy a different answer. Before this,
    the door ran first and a bearer got 503 LOCAL_AUTHORITY_UNAVAILABLE (or the
    authority's own 401) where nothing-at-all got 404, which tells a stranger both
    that the memory surface exists and whether the local authority is up."""
    from api.routes.one import pod_session
    from hushh_mcp.services import pod_session_authority as psa

    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: False)
    monkeypatch.setattr(pod_session, "pod_mode", lambda: True)
    token, _claims = await local_authority["admit"]("tdv_web_1", "web")
    # Also with no local authority at all, which is what a laptop pod looks like
    # before its incarnation lease is claimed.
    for authorization in (None, "Bearer pst1.forged.mac", f"Bearer {token}"):
        for teardown in (False, True):
            if teardown:
                psa.set_active_session_authority(None)
            calls = (
                pod_memory.pod_memory_status_route(
                    x_consent_token=None, authorization=authorization
                ),
                pod_memory.pod_memory_revoke_route(
                    payload=PodMemoryRevokeRequest(memory_ids=["m1"]),
                    x_consent_token=None,
                    authorization=authorization,
                ),
                pod_memory.pod_memory_provider_consent_route(
                    payload=PodMemoryProviderConsentRequest(granted=False),
                    x_consent_token=None,
                    authorization=authorization,
                ),
                pod_memory.pod_conversation_close_route(
                    conversation_id="c1",
                    payload=pod_memory.PodConversationCloseRequest(),
                    x_consent_token=None,
                    authorization=authorization,
                ),
            )
            for coro in calls:
                with pytest.raises(HTTPException) as refused:
                    await coro
                assert refused.value.status_code == 404, (authorization, teardown)
                assert refused.value.detail == "pod turn is not available"


# -- an owner-local call must carry its session --------------------------------------


async def test_an_owner_local_token_without_its_session_is_refused(
    local_authority, no_hub, tmp_path
):
    """The role check used to return silently when ``session`` was None, so a caller
    that handed a core the local token and the local verifier but omitted the claims
    got the owner-local door with no role and no scope question asked at all. The
    token's own shape is what makes the repeat a real check."""
    authority = local_authority["authority"]
    _token, claims = await local_authority["admit"]("tdv_mac_1", "macos")
    assert claims["role"] == "device"
    service = _service(tmp_path)
    held = await service.remember("a fact")
    # A device session's own marker and verifier, with the claims withheld.
    naked = {
        "consent_token": authority.local_token(claims),
        "verifier": authority.local_verifier(claims),
    }

    for coro in (
        run_memory_status(memory_service=service, **naked),
        run_memory_revoke(
            payload=PodMemoryRevokeRequest(memory_ids=[held]), memory_service=service, **naked
        ),
        run_memory_provider_consent(
            payload=PodMemoryProviderConsentRequest(granted=False),
            memory_service=service,
            **naked,
        ),
        pod_memory.run_conversation_close(
            conversation_id="c1",
            payload=pod_memory.PodConversationCloseRequest(runtime_credential="k"),
            memory_service=service,
            **naked,
        ),
    ):
        with pytest.raises(HTTPException) as refused:
            await coro
        assert refused.value.status_code == 403
        assert refused.value.detail["code"] == "session_required"
    status = await service.memory_status()
    assert status["tombstones"] == 0 and status["provider"]["consent"] == "absent"


async def test_the_hub_door_is_unaffected_by_the_session_requirement(enabled, tmp_path):
    """A hub token carries no session and never did. The shape check keys on the
    pod's own ``pod-session:`` marker, so the hub door is untouched by it."""
    service = _service(tmp_path)
    held = await service.remember("a fact")
    assert (await run_memory_status(consent_token="hub-token", memory_service=service))[
        "facts"
    ] == 1
    revoked = await run_memory_revoke(
        payload=PodMemoryRevokeRequest(memory_ids=[held]),
        consent_token="hub-token",
        memory_service=service,
    )
    assert revoked["revoked"] == 1


# -- revocation asks for the revoke scope, not merely for reading ---------------------


async def test_revoke_needs_the_pod_revoke_scope_while_the_other_doors_do_not(
    local_authority, no_hub, tmp_path, monkeypatch
):
    """This scope is what the REVOKE ROUTE asks. It is one of the three checks that
    together stop a binding narrowed to reading from tombstoning; on its own it
    stops nothing but this route, because a review's ``forget`` and ``supersede``
    reach the same kill from elsewhere (see the close and catch-up tests below).
    The pod's own destructive route (POST /api/one/pod/session/revoke) has always
    required ``pod.revoke`` of the session; memory revocation now asks the same
    question, and among the memory doors only memory revocation does."""
    from hushh_mcp.services.pod_session_authority import (
        SCOPE_PKM_READ,
        SCOPE_POD_CONFIG,
        SCOPE_POD_REVOKE,
        SCOPE_POD_STATUS,
    )

    authority = local_authority["authority"]
    narrowed = [SCOPE_PKM_READ, SCOPE_POD_CONFIG, SCOPE_POD_STATUS]
    token, claims = await local_authority["admit"]("tdv_web_1", "web", scopes=narrowed)
    assert SCOPE_POD_REVOKE not in claims["scopes"]
    service = _service(tmp_path)
    held = await service.remember("the meridian account ends in 4269")
    monkeypatch.setattr(pod_memory, "_memory_service", lambda: service)

    # At the route, refused with the same code the pod's own revoke route uses, and
    # refused before the consent authority is asked anything or the memory service
    # is touched. The route asks `verified_session` for the scope and the core asks
    # again; the two refusals are deliberately identical, so what this pins is the
    # refusal and its earliness, not which of the two layers produced it.
    async def _never_validate(*_a, **_k):
        raise AssertionError("a scope refusal must not reach the consent validation")

    real_validate = pod_turn._validate_consent
    monkeypatch.setattr(pod_turn, "_validate_consent", _never_validate)
    with pytest.raises(HTTPException) as at_route:
        await pod_memory.pod_memory_revoke_route(
            payload=PodMemoryRevokeRequest(memory_ids=[held]),
            x_consent_token=None,
            authorization=f"Bearer {token}",
        )
    assert at_route.value.status_code == 403
    assert at_route.value.detail["code"] == "scope_not_granted"
    assert (await service.memory_status())["tombstones"] == 0

    # And at the core, so a direct caller cannot skip it either.
    with pytest.raises(HTTPException) as at_core:
        await run_memory_revoke(
            payload=PodMemoryRevokeRequest(memory_ids=[held]),
            memory_service=service,
            **_local(authority, claims),
        )
    assert at_core.value.status_code == 403
    assert at_core.value.detail["code"] == "scope_not_granted"
    assert (await service.memory_status())["tombstones"] == 0

    # The narrowed binding still reads and still withdraws provider processing:
    # the new scope is asked of revocation alone.
    monkeypatch.setattr(pod_turn, "_validate_consent", real_validate)
    assert (await run_memory_status(memory_service=service, **_local(authority, claims)))[
        "facts"
    ] == 1
    withdrawn = await run_memory_provider_consent(
        payload=PodMemoryProviderConsentRequest(granted=False),
        memory_service=service,
        **_local(authority, claims),
    )
    assert withdrawn["granted"] is False


async def test_the_full_app_binding_still_revokes(local_authority, no_hub, tmp_path, monkeypatch):
    """The negative control's partner: a binding the hub actually mints carries
    ``pod.revoke``, so the tightening refuses nothing a real owner session can do."""
    from hushh_mcp.services.pod_session_authority import APP_SCOPES, SCOPE_POD_REVOKE

    assert SCOPE_POD_REVOKE in APP_SCOPES
    token, _claims = await local_authority["admit"]("tdv_web_1", "web")
    service = _service(tmp_path)
    held = await service.remember("a fact")
    monkeypatch.setattr(pod_memory, "_memory_service", lambda: service)

    revoked = await pod_memory.pod_memory_revoke_route(
        payload=PodMemoryRevokeRequest(memory_ids=[held]),
        x_consent_token=None,
        authorization=f"Bearer {token}",
    )
    assert revoked["revoked"] == 1 and revoked["tombstones"] == 1


# -- closing a conversation is not a destructive grant --------------------------------
#
# The scope check above guards `/api/one/pod/memory/revoke`, and on its own it does
# NOT make "a binding narrowed to reading cannot tombstone" true. The close route
# admits on the app role with no scope, and the review it runs reaches a tombstone
# by TWO tools, not one: `forget` reaches `PodMemoryService.revoke`, and `supersede`
# reaches `PodMemoryService.supersede`, which calls the same `PodMemoryStore._kill`
# on the old id before hydrating the replacement. The close is narrowed rather than
# gated, because leaving a chat must not require a destructive grant.
#
# Everything below runs the REAL `run_memory_review` against a REAL memory service,
# with only ADK's Runner scripted, so what is pinned is the tombstone that does or
# does not appear in the log -- not a keyword argument being passed along.


class _ScriptedReviewRunner:
    """Stands in for ADK's Runner and calls the tools the review actually bound."""

    script: list = []

    def __init__(self, *, app_name, agent, session_service, memory_service=None):
        self.agent = agent

    async def run_async(self, *, user_id, session_id, new_message, run_config):
        from google.adk.events import Event
        from google.genai import types as genai_types

        tools = {getattr(t, "name", ""): t for t in self.agent.tools}
        for name, kwargs in type(self).script:
            tools[name].func(**kwargs)
        yield Event(
            author=self.agent.name,
            partial=False,
            content=genai_types.Content(
                role="model", parts=[genai_types.Part.from_text(text="done")]
            ),
        )


class _ReviewEvent:
    def __init__(self, text: str, author: str) -> None:
        self.author = author
        self.invocation_id = "inv_close"
        self.content = type("C", (), {"parts": [type("P", (), {"text": text})()]})()


class _ReviewSession:
    def __init__(self, owner: str, *turns: tuple[str, str]) -> None:
        self.user_id = owner
        self.events = [_ReviewEvent(text, author) for author, text in turns]


async def _closeable(tmp_path, monkeypatch, script):
    """A pod with one held fact, one unreviewed conversation, and a scripted model."""
    from hushh_mcp.services.pod_config import PodConfig, set_active_pod_config

    monkeypatch.setattr(pod_turn, "_resolve_model", lambda *_a, **_k: ("gemini", "gemini-test"))
    set_active_pod_config(PodConfig())
    service = _service(tmp_path)
    held = await service.remember("the meridian account ends in 4269")
    await service.add_session_to_memory(
        _ReviewSession(OWNER, ("user", "forget the meridian account"), ("one", "Done."))
    )
    assert service.unreviewed_count() == 2
    _ScriptedReviewRunner.script = list(script)
    monkeypatch.setattr("google.adk.runners.Runner", _ScriptedReviewRunner)
    return service, held


async def test_a_close_on_a_binding_without_pod_revoke_records_nothing_at_all(
    local_authority, no_hub, tmp_path, monkeypatch
):
    """It refuses both kills, and then drops the additive half of the same pass.

    Keeping the ``remember`` is the tempting middle and it is the hazard: the
    corrected sentence would land beside the stale fact, the checkpoint would
    advance past the conversation that said which one was wrong, and recall would
    serve both as equally true. ``run_memory_review`` argues the trade in full.
    """
    from hushh_mcp.services.pod_config import set_active_pod_config
    from hushh_mcp.services.pod_session_authority import (
        SCOPE_PKM_READ,
        SCOPE_POD_CONFIG,
        SCOPE_POD_REVOKE,
        SCOPE_POD_STATUS,
    )

    authority = local_authority["authority"]
    narrowed = [SCOPE_PKM_READ, SCOPE_POD_CONFIG, SCOPE_POD_STATUS]
    _token, claims = await local_authority["admit"]("tdv_web_1", "web", scopes=narrowed)
    assert SCOPE_POD_REVOKE not in claims["scopes"]

    try:
        service, held = await _closeable(tmp_path, monkeypatch, script=[])
        _ScriptedReviewRunner.script = [
            ("forget", {"memory_id": held}),
            # The op the round-three narrowing let through: superseding a fact
            # kills it just as dead, so it must be refused by the same authority.
            ("supersede", {"memory_id": held, "fact": "the meridian account was closed"}),
            ("remember", {"fact": "she prefers aisle seats"}),
        ]
        result = await pod_memory.run_conversation_close(
            conversation_id="conv-narrowed",
            payload=pod_memory.PodConversationCloseRequest(runtime_credential="owner-key"),
            memory_service=service,
            model_builder=lambda **_k: "the-model-object",
            **_local(authority, claims),
        )
    finally:
        set_active_pod_config(None)

    review = result["memory"]["review"]
    # A denial of authority, named as one. Not "applied", and not the anonymous
    # refusal that an unknown id or an over-long fact produces.
    assert review["outcome"] == "refused_authority"
    # BOTH destructive ops were refused where every other invalid op is refused,
    # and the breakdown says both refusals were about consent.
    assert review["ops"]["forget"] == 0
    assert review["ops"]["supersede"] == 0
    assert review["ops"]["refused"] == 2
    assert review["ops"]["authority_refused"] == 2
    # The model asked to remember something in the same pass; nothing was written.
    assert review["ops"]["remember"] == 1
    assert result["memory"]["written"] == 0
    texts = {f["text"] for f in await service.fact_index()}
    assert "the meridian account was closed" not in texts
    assert "she prefers aisle seats" not in texts, "the additive half went with it"
    # The proof, in the log rather than in a count: the fact is still held and no
    # tombstone was written.
    status = await service.memory_status()
    assert status["tombstones"] == 0
    assert held in {f["memory_id"] for f in await service.fact_index()}


async def test_a_narrowed_close_that_only_adds_is_untouched_by_the_narrowing(
    local_authority, no_hub, tmp_path, monkeypatch
):
    """The non-vacuity control: the narrowing costs a narrowed caller its writes
    only when it reached for a tombstone. A close that merely learns still learns."""
    from hushh_mcp.services.pod_config import set_active_pod_config
    from hushh_mcp.services.pod_session_authority import (
        SCOPE_PKM_READ,
        SCOPE_POD_CONFIG,
        SCOPE_POD_STATUS,
    )

    authority = local_authority["authority"]
    narrowed = [SCOPE_PKM_READ, SCOPE_POD_CONFIG, SCOPE_POD_STATUS]
    _token, claims = await local_authority["admit"]("tdv_web_1", "web", scopes=narrowed)

    try:
        service, _held = await _closeable(tmp_path, monkeypatch, script=[])
        _ScriptedReviewRunner.script = [("remember", {"fact": "she prefers aisle seats"})]
        result = await pod_memory.run_conversation_close(
            conversation_id="conv-narrowed-additive",
            payload=pod_memory.PodConversationCloseRequest(runtime_credential="owner-key"),
            memory_service=service,
            model_builder=lambda **_k: "the-model-object",
            **_local(authority, claims),
        )
    finally:
        set_active_pod_config(None)

    assert result["memory"]["review"]["outcome"] == "applied"
    assert result["memory"]["review"]["ops"]["authority_refused"] == 0
    assert result["memory"]["written"] == 1
    assert "she prefers aisle seats" in {f["text"] for f in await service.fact_index()}


async def test_a_close_on_the_binding_the_hub_actually_mints_still_retires(
    local_authority, no_hub, tmp_path, monkeypatch
):
    """The negative control. ``APP_SCOPES`` carries ``pod.revoke``, so the narrowing
    refuses nothing a real owner session can do: ``forget`` AND ``supersede`` both
    still work, and the review a real close runs is unchanged."""
    from hushh_mcp.services.pod_config import set_active_pod_config
    from hushh_mcp.services.pod_session_authority import APP_SCOPES, SCOPE_POD_REVOKE

    assert SCOPE_POD_REVOKE in APP_SCOPES
    authority = local_authority["authority"]
    _token, claims = await local_authority["admit"]("tdv_web_1", "web")

    try:
        service, held = await _closeable(tmp_path, monkeypatch, script=[])
        correctable = await service.remember("the sailboat berths at slip twelve")
        _ScriptedReviewRunner.script = [
            ("forget", {"memory_id": held}),
            ("supersede", {"memory_id": correctable, "fact": "the sailboat berths at slip forty"}),
        ]
        result = await pod_memory.run_conversation_close(
            conversation_id="conv-full",
            payload=pod_memory.PodConversationCloseRequest(runtime_credential="owner-key"),
            memory_service=service,
            model_builder=lambda **_k: "the-model-object",
            **_local(authority, claims),
        )
    finally:
        set_active_pod_config(None)

    assert result["memory"]["review"]["ops"]["forget"] == 1
    assert result["memory"]["review"]["ops"]["supersede"] == 1
    assert result["memory"]["review"]["ops"]["refused"] == 0
    status = await service.memory_status()
    # Two kills: the forget, and the supersession's own tombstone on the old id.
    assert status["tombstones"] == 2
    live = {f["memory_id"] for f in await service.fact_index()}
    assert held not in live and correctable not in live
    assert "the sailboat berths at slip forty" in {f["text"] for f in await service.fact_index()}


async def test_a_hub_relayed_close_is_unchanged_by_the_narrowing(enabled, tmp_path, monkeypatch):
    """The hub door carries hub scopes, not binding scopes, so it keeps every op.

    Without this the narrowing would have quietly disarmed the relayed close too,
    which is the path every browser-attached conversation uses today.
    """
    from hushh_mcp.services.pod_config import set_active_pod_config

    try:
        service, held = await _closeable(tmp_path, monkeypatch, script=[])
        _ScriptedReviewRunner.script = [("forget", {"memory_id": held})]
        result = await pod_memory.run_conversation_close(
            conversation_id="conv-hub",
            payload=pod_memory.PodConversationCloseRequest(runtime_credential="owner-key"),
            memory_service=service,
            model_builder=lambda **_k: "the-model-object",
            consent_token="hub-token",
        )
    finally:
        set_active_pod_config(None)

    assert result["memory"]["review"]["ops"]["forget"] == 1
    assert (await service.memory_status())["tombstones"] == 1


# -- the whole invariant, over every route that can reach a tombstone ------------------


async def test_a_read_narrowed_session_cannot_retire_a_fact_by_any_route(
    local_authority, no_hub, tmp_path, monkeypatch
):
    """The invariant as narrowly as the code holds it, end to end on one pod.

    Rounds of review each fixed one route and left the sentence false, so this
    pins the sentence rather than a route: a call made WITH a binding narrowed to
    reading cannot retire a held fact through the revoke door, through a
    conversation close (by ``forget`` OR by ``supersede``), or through the
    catch-up review a turn opened with that same binding runs.

    It is a claim about the BINDING and not about the person: the same owner on
    the hub door retires as before, which
    ``test_a_hub_relayed_close_is_unchanged_by_the_narrowing`` and
    ``test_a_full_authority_catch_up_retires_as_that_close_would_have`` pin, and
    a narrowing that disarmed the owner would be a defect of its own.

    Everything here is the real code path against a real memory service; only
    ADK's Runner is scripted, so the verdict is the tombstone count in the log.
    """
    from hushh_mcp.one_adk import text_runtime
    from hushh_mcp.services.pod_config import set_active_pod_config
    from hushh_mcp.services.pod_session_authority import (
        SCOPE_PKM_READ,
        SCOPE_POD_CONFIG,
        SCOPE_POD_REVOKE,
        SCOPE_POD_STATUS,
    )

    authority = local_authority["authority"]
    narrowed = [SCOPE_PKM_READ, SCOPE_POD_CONFIG, SCOPE_POD_STATUS]
    token, claims = await local_authority["admit"]("tdv_web_1", "web", scopes=narrowed)
    assert SCOPE_POD_REVOKE not in claims["scopes"]

    try:
        service, held = await _closeable(tmp_path, monkeypatch, script=[])
        monkeypatch.setattr(pod_memory, "_memory_service", lambda: service)

        # Route 1: the revoke door. Refused on the scope, before anything is touched.
        with pytest.raises(HTTPException) as refused:
            await pod_memory.pod_memory_revoke_route(
                payload=PodMemoryRevokeRequest(memory_ids=[held]),
                x_consent_token=None,
                authorization=f"Bearer {token}",
            )
        assert refused.value.status_code == 403
        assert refused.value.detail["code"] == "scope_not_granted"

        # Route 2: a conversation close, whose review asks for BOTH kills.
        _ScriptedReviewRunner.script = [
            ("forget", {"memory_id": held}),
            ("supersede", {"memory_id": held, "fact": "the meridian account was closed"}),
        ]
        closed = await pod_memory.run_conversation_close(
            conversation_id="conv-any-route",
            payload=pod_memory.PodConversationCloseRequest(runtime_credential="owner-key"),
            memory_service=service,
            model_builder=lambda **_k: "the-model-object",
            **_local(authority, claims),
        )
        review = closed["memory"]["review"]
        # Every operation the model asked for was destructive and every one was
        # refused, so nothing was left to apply. ``refused == 2`` is what makes this
        # non-vacuous: it can only be reached by the scripted model actually calling
        # both tools on the review's own sink. The outcome word is the consent
        # denial, not the "nothing worth saving" a silent reviewer produces.
        assert review["outcome"] == "refused_authority"
        assert review["ops"]["refused"] == 2 and review["ops"]["authority_refused"] == 2
        assert review["ops"]["forget"] == 0 and review["ops"]["supersede"] == 0
        assert closed["memory"]["written"] == 0

        # Route 3: the catch-up review inside a turn. It now carries the TURN'S own
        # verdict -- the same helper, from the same claims the turn was admitted on
        # -- so what stops it here is this binding's missing scope and not the
        # absence of a thread. `test_the_turn_route_hands_the_catch_up_review_the_
        # doors_own_verdict` pins that the turn route really resolves and passes it.
        # Fresh unreviewed records, because the close above consumed the first set.
        await service.add_session_to_memory(
            _ReviewSession(OWNER, ("user", "actually forget the meridian account"), ("one", "Ok."))
        )
        assert service.unreviewed_count() > 0
        _ScriptedReviewRunner.script = [
            ("forget", {"memory_id": held}),
            ("supersede", {"memory_id": held, "fact": "the meridian account was closed"}),
            ("remember", {"fact": "she prefers aisle seats"}),
        ]
        caught_up = await text_runtime._catch_up_memory_review(
            memory_service=service,
            model="the-model-object",
            runtime_provider="gemini",
            runtime_model="gemini-test",
            session_owner_id=OWNER,
            review_policy=pod_memory.review_policy_for_session(claims),
        )
        assert caught_up is not None, "the catch-up really ran; this is not vacuous"
        assert caught_up.outcome == "refused_authority"
        assert caught_up.ops["forget"] == 0 and caught_up.ops["supersede"] == 0
        assert caught_up.ops["refused"] == 2 and caught_up.ops["authority_refused"] == 2
        # And the pass wrote nothing, so the correction it was refused never
        # reappeared as a bare fact beside the one it was meant to replace.
        assert caught_up.written == 0
        assert "she prefers aisle seats" not in {f["text"] for f in await service.fact_index()}
    finally:
        set_active_pod_config(None)

    # The verdict, in the log rather than in a count: not one tombstone was written
    # by any of the three, and the fact the person gave the agent is still held.
    status = await service.memory_status()
    assert status["tombstones"] == 0
    assert held in {f["memory_id"] for f in await service.fact_index()}
    # And it survives a rebuild from the log, so nothing was merely hidden.
    rebuilt = _service(tmp_path)
    assert held in {f["memory_id"] for f in await rebuilt.fact_index()}


async def test_a_full_authority_catch_up_retires_as_that_close_would_have(
    local_authority, no_hub, tmp_path, monkeypatch
):
    """The capability the previous round removed, measured in the log.

    The catch-up review is what runs when a person walks away from a conversation
    without closing it, and it is meant to do the review the close would have
    done. With no authority reaching it, it could retire nothing for anybody: the
    corrected fact was remembered, the stale one was never retired, the checkpoint
    advanced, and recall then had both. The verdict here is the tombstone count,
    against a real memory service on a binding the hub actually mints.
    """
    from hushh_mcp.one_adk import text_runtime
    from hushh_mcp.services.pod_config import set_active_pod_config
    from hushh_mcp.services.pod_session_authority import APP_SCOPES, SCOPE_POD_REVOKE

    assert SCOPE_POD_REVOKE in APP_SCOPES
    _token, claims = await local_authority["admit"]("tdv_web_1", "web")

    try:
        service, held = await _closeable(tmp_path, monkeypatch, script=[])
        correctable = await service.remember("the sailboat berths at slip twelve")
        _ScriptedReviewRunner.script = [
            ("forget", {"memory_id": held}),
            ("supersede", {"memory_id": correctable, "fact": "the sailboat berths at slip forty"}),
        ]
        caught_up = await text_runtime._catch_up_memory_review(
            memory_service=service,
            model="the-model-object",
            runtime_provider="gemini",
            runtime_model="gemini-test",
            session_owner_id=OWNER,
            review_policy=pod_memory.review_policy_for_session(claims),
        )
    finally:
        set_active_pod_config(None)

    assert caught_up is not None and caught_up.outcome == "applied"
    assert caught_up.ops["forget"] == 1 and caught_up.ops["supersede"] == 1
    status = await service.memory_status()
    assert status["tombstones"] == 2
    live = {f["memory_id"] for f in await service.fact_index()}
    assert held not in live and correctable not in live
    # The correction replaced the stale fact rather than joining it, and it
    # survives a rebuild from the log, so the retirement is real.
    rebuilt = {f["text"] for f in await _service(tmp_path).fact_index()}
    assert "the sailboat berths at slip forty" in rebuilt
    assert "the sailboat berths at slip twelve" not in rebuilt


async def test_the_turn_route_hands_the_catch_up_review_the_doors_own_verdict(
    local_authority, no_hub, enabled, tmp_path, monkeypatch
):
    """The capability regression this round closes, pinned where it was lost.

    The catch-up review is the designed stand-in for a close the person never
    sent. When it passed no authority at all it retired nothing for EVERY caller,
    the full-authority hub-relayed owner included, so a correction they spoke was
    remembered while the stale fact was never retired -- a different, weaker
    review wearing the close's name.

    What is pinned is the turn route resolving the verdict and handing it down,
    on all three doors it can be reached through, with the provenance label that
    makes a later denial reportable. The behaviour behind the verdict is pinned
    against a real log in ``test_pod_memory_review.py`` and above.
    """
    from hushh_mcp.services.pod_session_authority import (
        APP_SCOPES,
        SCOPE_PKM_READ,
        SCOPE_POD_CONFIG,
        SCOPE_POD_REVOKE,
        SCOPE_POD_STATUS,
    )

    monkeypatch.setattr(pod_turn, "_resolve_model", lambda *_a, **_k: ("gemini", "gemini-test"))
    authority = local_authority["authority"]
    seen: dict = {}

    async def _runner(**kwargs):
        seen.update(kwargs)
        yield SimpleNamespace(kind="token", text="ok", model_version="")

    def _reached(result) -> dict:
        """Fail with the reason, not with a bare KeyError on an empty dict.

        ``run_pod_turn`` wraps the whole streaming block in a broad handler that
        turns two specific conditions into a degraded ANSWER rather than an
        error, so a failure that happens before the runner is first iterated
        returns normally and leaves ``seen`` empty. Reading the verdict out of
        an empty dict then reports a missing key, which says nothing about why.
        """
        assert seen, (
            f"the runner was never iterated, so the turn returned before streaming: {result!r}"
        )
        assert "degraded" not in result, f"the turn degraded instead of streaming: {result!r}"
        return seen

    payload = pod_turn.PodTurnRequest(
        message="hello", runtimeCredential="owner-key", pkmContext="grounding"
    )

    # The hub-relayed door: no binding at all, and the hub's verdict is the
    # authority, exactly as it is for a close and for the revoke route.
    hub_turn = await pod_turn.run_pod_turn(
        payload=payload, consent_token="hub-token", stream_fn=_runner
    )
    assert _reached(hub_turn)["memory_review_policy"].may_retire is True
    assert seen["memory_review_policy"].authority == "hub_consent"

    # The owner-local door on the binding the hub actually mints today.
    assert SCOPE_POD_REVOKE in APP_SCOPES
    _full_token, full = await local_authority["admit"]("tdv_web_full", "web")
    full_turn = await pod_turn.run_pod_turn(
        payload=payload,
        consent_token=authority.local_token(full),
        verifier=authority.local_verifier(full),
        session=full,
        stream_fn=_runner,
    )
    assert _reached(full_turn)["memory_review_policy"].may_retire is True
    assert seen["memory_review_policy"].authority == "binding_scope"

    # And a binding narrowed to reading, which keeps the narrowing non-vacuous.
    _read_token, narrowed = await local_authority["admit"](
        "tdv_web_read", "web", scopes=[SCOPE_PKM_READ, SCOPE_POD_CONFIG, SCOPE_POD_STATUS]
    )
    narrowed_turn = await pod_turn.run_pod_turn(
        payload=payload,
        consent_token=authority.local_token(narrowed),
        verifier=authority.local_verifier(narrowed),
        session=narrowed,
        stream_fn=_runner,
    )
    assert _reached(narrowed_turn)["memory_review_policy"].may_retire is False
    assert seen["memory_review_policy"].authority == "binding_narrowed"


# -- the machine wall these paths no longer sit behind --------------------------------


def test_the_memory_doors_are_on_the_app_surface_and_the_wall_no_longer_covers_them():
    """The trade the module docstring states, pinned so it cannot widen silently.

    Naming a path on the app surface removes the pod's verification of the hub's
    Google identity token from it. The relay still SENDS that token on all four
    (``pod_relay``); the pod simply stops checking it, so each route's own
    admission is the entire defence. That is the precedent ``/api/one/pod/turn``
    set. A fifth memory path added to the surface fails this test until whoever
    adds it names it here and re-reads why the other four are there.
    """
    from api.middlewares.pod_ingress import APP_SURFACE_EXACT, is_app_surface

    doors = (
        "/api/one/pod/conversation/abc/close",
        "/api/one/pod/memory/status",
        "/api/one/pod/memory/revoke",
        "/api/one/pod/memory/provider-consent",
        "/api/one/pod/consumer/memory",
    )
    for path in doors:
        assert is_app_surface(path), path
    # Exactly these memory paths and no others: the set is named one at a time
    # rather than by a `/memory/` prefix for precisely this reason.
    assert {p for p in APP_SURFACE_EXACT if "/memory/" in p} == {
        "/api/one/pod/memory/status",
        "/api/one/pod/memory/revoke",
        "/api/one/pod/memory/provider-consent",
    }
    # And the wall still covers a memory-adjacent path nobody named.
    assert not is_app_surface("/api/one/pod/memory/export")
    # The consequence, stated as a pin: every door above must therefore extract a
    # credential of its own. `_owner_door` is the only thing left standing.
    declared = {
        route.path: {param.alias.lower() for param in route.dependant.header_params}
        for route in pod_memory.router.routes
        if getattr(route, "path", "").startswith("/api/one/pod/memory/")
    }
    assert len(declared) == 3, declared
    for path, headers in declared.items():
        assert headers == {"x-consent-token", "authorization"}, path
