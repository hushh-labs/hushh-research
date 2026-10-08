"""The hub's one pod verifier: signature first, Google only for rows that never signed.

Every test here drives ``verify_pod_request`` with a real Starlette request and a
signature made the way a pod makes it, against fakes that keep the same contracts
as the registry, the nonce store and the hub's own key pull.
"""

from __future__ import annotations

import time
from typing import Any, Optional

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from starlette.requests import Request

from api.routes.one import pod_identity_auth as pia
from hushh_mcp.services import pod_request_signing as prs
from hushh_mcp.services.pod_hub_client import POD_IDENTITY_HEADER, VerifiedOwnerPod
from hushh_mcp.services.pod_mcp_approval import PodMcpTerms, _principal_holds_row
from hushh_mcp.services.pod_request_verifier import PullCap

AUD = "https://hub.example"
OWNER = "ha1_owner"
VICTIM = "ha1_victim"
POD_KEY = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
OTHER_KEY = Ed25519PrivateKey.from_private_bytes(bytes(range(1, 33)))


def _public(key: Ed25519PrivateKey) -> tuple[str, str]:
    public = prs.public_key_b64(key)
    return public, prs.signing_key_id(public)


class _Registry:
    def __init__(self, rows: dict[str, dict]) -> None:
        self.rows = rows
        self.reads = 0

    async def get_by_hushh_id(self, hushh_id: str) -> Optional[dict]:
        self.reads += 1
        row = self.rows.get(hushh_id)
        return dict(row) if row else None


class _Store:
    """Same semantics as the SQL in pod_request_identity_store."""

    def __init__(self, registry: _Registry) -> None:
        self.registry = registry
        self.nonces: set[tuple[str, str]] = set()
        self.pull_stamps: dict[str, int] = {}
        self.latched: list[str] = []
        self.fail_nonces = False

    async def consume_nonce(self, *, kid: str, nonce: str, expires_at_ms: int) -> bool:
        if self.fail_nonces:
            raise RuntimeError("database unavailable")
        if (kid, nonce) in self.nonces:
            return False
        self.nonces.add((kid, nonce))
        return True

    async def claim_key_pull(self, *, hushh_id: str, interval_ms: int, now_ms: int) -> bool:
        if now_ms - self.pull_stamps.get(hushh_id, 0) < interval_ms:
            return False
        self.pull_stamps[hushh_id] = now_ms
        return True

    async def latch_signed(self, *, hushh_id: str, kid: str) -> bool:
        row = self.registry.rows[hushh_id]
        if row.get("pod_signing_key_id") != kid or row.get("identity_mode") == "signed":
            return False
        row["identity_mode"] = "signed"
        self.latched.append(hushh_id)
        return True


class _Pull:
    """The hub's own pull: whatever the REAL pod at the recorded address publishes."""

    def __init__(self, registry: _Registry, real_keys: dict[str, Ed25519PrivateKey]) -> None:
        self.registry = registry
        self.real_keys = real_keys
        self.calls: list[str] = []

    async def __call__(self, row: dict) -> str:
        hushh_id = row["hushh_id"]
        self.calls.append(hushh_id)
        public, kid = _public(self.real_keys[hushh_id])
        self.registry.rows[hushh_id].update(pod_signing_pubkey=public, pod_signing_key_id=kid)
        return "provisioned"


def _row(hushh_id: str, key: Optional[Ed25519PrivateKey] = None, **extra: Any) -> dict:
    row = {"hushh_id": hushh_id, "user_id": f"uid-{hushh_id}", "status": "provisioned"}
    if key is not None:
        public, kid = _public(key)
        row.update(pod_signing_pubkey=public, pod_signing_key_id=kid)
    row.update(extra)
    return row


def _request(
    *,
    key: Optional[Ed25519PrivateKey] = POD_KEY,
    hushh_id: str = OWNER,
    body: bytes = b'{"imageTag":"v1"}',
    sent_body: Optional[bytes] = None,
    ts_ms: Optional[int] = None,
    headers: Optional[dict[str, str]] = None,
    authorization: Optional[str] = None,
    nonce: Optional[str] = None,
) -> Request:
    path = "/api/one/pod/heartbeat"
    sent = {POD_IDENTITY_HEADER: hushh_id, "Content-Type": "application/json"}
    if key is not None:
        sent.update(
            prs.sign_pod_request(
                key,
                aud=AUD,
                hushh_id=hushh_id,
                method="POST",
                path=path,
                query_pairs=[],
                body=body,
                ts_ms=ts_ms,
                nonce=nonce,
            )
        )
    if authorization:
        sent["Authorization"] = authorization
    sent.update(headers or {})
    payload = body if sent_body is None else sent_body

    async def receive() -> dict:
        return {"type": "http.request", "body": payload, "more_body": False}

    scope = {
        "type": "http",
        "method": "POST",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "scheme": "https",
        "server": ("hub.example", 443),
        "headers": [(k.lower().encode(), v.encode()) for k, v in sent.items()],
    }
    return Request(scope, receive)


@pytest.fixture
def hub(monkeypatch):
    monkeypatch.setattr(pia, "pod_hub_identity_auth_enabled", lambda: True)
    monkeypatch.setattr(pia, "pod_hub_expected_audience", lambda: AUD)
    registry = _Registry({OWNER: _row(OWNER, POD_KEY), VICTIM: _row(VICTIM)})
    store = _Store(registry)
    pull = _Pull(registry, {OWNER: POD_KEY, VICTIM: OTHER_KEY})
    _google_accepts(monkeypatch, None)  # no Authorization header: no Google identity

    async def verify(request, authorization=None, **kwargs):
        return await pia.verify_pod_request(
            request,
            authorization,
            registry=registry,
            store=store,
            refresh=pull,
            **kwargs,
        )

    return verify, registry, store, pull


def _google_accepts(monkeypatch, result) -> list:
    """Stand in for the transitional Google check; returns the list of its calls."""
    calls: list = []

    async def google(_request, _authorization, *, owner_bound=False):
        calls.append(owner_bound)
        return result

    monkeypatch.setattr(pia, "verify_pod_identity", google)
    return calls


# -- the signed path -------------------------------------------------------------------


async def test_a_valid_signature_verifies_and_latches_the_row(hub):
    verify, registry, store, pull = hub
    pod = await verify(_request())
    assert pod == prs.VerifiedPod(OWNER, key_id=_public(POD_KEY)[1])
    assert pod.owner_bound
    assert registry.rows[OWNER]["identity_mode"] == "signed"
    assert pull.calls == []


async def test_a_replayed_request_is_refused(hub):
    verify, *_ = hub
    first = _request(nonce="AAECAwQFBgcICQoLDA0ODw", ts_ms=int(time.time() * 1000))
    stamp = first.headers[prs.TIMESTAMP_HEADER]
    assert await verify(first) is not None
    replay = _request(nonce="AAECAwQFBgcICQoLDA0ODw", ts_ms=int(stamp))
    assert await verify(replay) is None


@pytest.mark.parametrize("offset_ms", [-61_000, 31_000])
async def test_a_timestamp_outside_the_window_is_refused(hub, offset_ms):
    """A second of margin against the wall clock; the exact edges are pinned in
    test_pod_request_signing with an explicit ``now``."""
    verify, *_ = hub
    assert await verify(_request(ts_ms=int(time.time() * 1000) + offset_ms)) is None


@pytest.mark.parametrize(
    "changes",
    [
        {"sent_body": b'{"imageTag":"v2"}'},
        {"headers": {prs.TIMESTAMP_HEADER: str(int(time.time() * 1000) - 1_000)}},
        {"headers": {prs.NONCE_HEADER: "ZZZZZZZZZZZZZZZZZZZZZZ"}},
    ],
)
async def test_a_tampered_request_is_refused_and_never_downgraded(hub, monkeypatch, changes):
    verify, *_ = hub
    google = _google_accepts(monkeypatch, OWNER)
    assert await verify(_request(**changes), "Bearer google") is None
    assert google == [], "a checkable bad signature must never fall back to Google"


async def test_a_malformed_signature_is_refused_even_with_a_good_google_token(hub, monkeypatch):
    verify, *_ = hub
    google = _google_accepts(monkeypatch, OWNER)
    bad = _request(headers={prs.SIGNATURE_HEADER: "ed25519.not-a-kid.x"})
    assert await verify(bad, "Bearer google") is None
    assert google == []


async def test_a_signed_request_for_an_unknown_husshid_is_left_to_the_transitional_path(
    hub, monkeypatch
):
    """No row means no key to check against: not a pass, and not a bad signature.
    The Google path decides as it always has (a GCP orphan still reaches its 404)."""
    verify, *_ = hub
    assert await verify(_request(hushh_id="ha1_orphan")) is None
    _google_accepts(monkeypatch, "ha1_orphan")
    pod = await verify(_request(hushh_id="ha1_orphan"), "Bearer google")
    assert pod == prs.VerifiedPod("ha1_orphan")


async def test_the_nonce_store_being_down_refuses(hub):
    verify, _, store, _ = hub
    store.fail_nonces = True
    assert await verify(_request()) is None


async def test_the_flag_off_accepts_nothing(hub, monkeypatch):
    verify, *_ = hub
    monkeypatch.setattr(pia, "pod_hub_identity_auth_enabled", lambda: False)
    assert await verify(_request()) is None


# -- the hub-initiated pull ------------------------------------------------------------


async def test_an_unknown_kid_triggers_exactly_one_throttled_pull(hub):
    verify, registry, _, pull = hub
    registry.rows[OWNER].pop("pod_signing_pubkey")
    registry.rows[OWNER].pop("pod_signing_key_id")

    assert await verify(_request()) is not None  # pulled, recorded, verified
    assert pull.calls == [OWNER]

    # A key the real pod does not hold can only re-trigger the pull after 30 s.
    assert await verify(_request(key=OTHER_KEY)) is None
    assert await verify(_request(key=OTHER_KEY)) is None
    assert pull.calls == [OWNER]


async def test_a_wrong_husshid_is_refused_after_the_pull_fetches_the_real_key(hub):
    """An attacker signs with its own key while claiming the victim's HusshID."""
    verify, registry, _, pull = hub
    forged = _request(key=POD_KEY, hushh_id=VICTIM)
    assert await verify(forged) is None
    assert pull.calls == [VICTIM]
    assert registry.rows[VICTIM]["pod_signing_key_id"] == _public(OTHER_KEY)[1]
    assert "identity_mode" not in registry.rows[VICTIM]


async def test_the_pull_goes_through_the_existing_collector_refresh(hub, monkeypatch):
    """No second fetch path: the trigger reuses pod_key_collector.refresh_pod_key."""
    _, registry, store, _ = hub
    pulled: list[dict] = []

    async def refresh_pod_key(row):
        pulled.append(row)
        return None

    monkeypatch.setattr("hushh_mcp.services.pod_key_collector.refresh_pod_key", refresh_pod_key)
    request = _request(key=OTHER_KEY, hushh_id=VICTIM)
    assert await pia.verify_pod_request(request, None, registry=registry, store=store) is None
    assert [row["hushh_id"] for row in pulled] == [VICTIM]


async def test_the_global_pull_cap_holds_across_rows(hub, monkeypatch):
    verify, registry, _, pull = hub
    registry.rows["ha1_third"] = _row("ha1_third")
    pull.real_keys["ha1_third"] = OTHER_KEY
    monkeypatch.setattr("hushh_mcp.services.pod_request_verifier._DEFAULT_CAP", PullCap(limit=1))

    await verify(_request(key=OTHER_KEY, hushh_id=VICTIM))
    await verify(_request(key=POD_KEY, hushh_id="ha1_third"))
    assert pull.calls == [VICTIM]


async def test_requests_that_lose_the_row_throttle_never_spend_the_cap(hub, monkeypatch):
    """Junk kids aimed at one row buy one pull per interval and nothing more, so a
    latched pod on another row whose key rotated on restart still gets its pull."""
    verify, registry, _, pull = hub
    cap = PullCap(limit=2)
    monkeypatch.setattr("hushh_mcp.services.pod_request_verifier._DEFAULT_CAP", cap)
    junk = Ed25519PrivateKey.from_private_bytes(bytes(range(2, 34)))
    for _ in range(25):
        assert await verify(_request(key=junk, hushh_id=VICTIM)) is None
    assert pull.calls == [VICTIM]
    assert cap.has_room(), "24 throttled requests spent nothing"

    stale_public, stale_kid = _public(OTHER_KEY)  # latched, then it restarted with POD_KEY
    registry.rows[OWNER].update(
        identity_mode="signed", pod_signing_pubkey=stale_public, pod_signing_key_id=stale_kid
    )
    assert await verify(_request()) == prs.VerifiedPod(OWNER, key_id=_public(POD_KEY)[1])
    assert pull.calls == [VICTIM, OWNER]
    assert not cap.has_room()


async def test_a_full_cap_does_not_burn_the_rows_pull_slot(hub, monkeypatch):
    verify, registry, store, pull = hub
    registry.rows["ha1_third"] = _row("ha1_third")
    pull.real_keys["ha1_third"] = OTHER_KEY
    monkeypatch.setattr("hushh_mcp.services.pod_request_verifier._DEFAULT_CAP", PullCap(limit=1))
    await verify(_request(key=OTHER_KEY, hushh_id="ha1_third"))  # spends the only slot

    assert await verify(_request(key=OTHER_KEY, hushh_id=VICTIM)) is None
    assert VICTIM not in store.pull_stamps, "the row can still pull once the cap frees"
    assert pull.calls == ["ha1_third"]


# -- the transitional Google path ------------------------------------------------------


async def test_google_is_still_accepted_for_a_row_that_never_signed(hub, monkeypatch):
    verify, *_ = hub
    _google_accepts(monkeypatch, VICTIM)
    pod = await verify(_request(key=None, hushh_id=VICTIM), "Bearer google")
    assert pod == prs.VerifiedPod(VICTIM)
    assert not pod.owner_bound


async def test_a_byoc_google_principal_keeps_its_bound_service_account(hub, monkeypatch):
    verify, *_ = hub
    _google_accepts(monkeypatch, VerifiedOwnerPod(VICTIM, "pod@owner.iam.gserviceaccount.com"))
    pod = await verify(_request(key=None, hushh_id=VICTIM), "Bearer google", owner_bound=True)
    assert pod == prs.VerifiedPod(VICTIM, service_account="pod@owner.iam.gserviceaccount.com")
    assert pod.owner_bound


async def test_the_latch_refuses_google_only_after_the_row_signed(hub, monkeypatch):
    verify, registry, *_ = hub
    assert await verify(_request()) is not None
    assert registry.rows[OWNER]["identity_mode"] == "signed"

    _google_accepts(monkeypatch, OWNER)
    assert await verify(_request(key=None), "Bearer google") is None


async def test_an_unresolved_kid_on_a_never_signed_row_may_still_use_google(hub, monkeypatch):
    """GCP during transition: the pod signs AND sends its token; a throttled pull
    must not turn a working pod into a 401."""
    verify, registry, store, pull = hub
    store.pull_stamps[VICTIM] = int(time.time() * 1000)  # pull already spent
    _google_accepts(monkeypatch, VICTIM)
    pod = await verify(_request(key=OTHER_KEY, hushh_id=VICTIM), "Bearer google")
    assert pod == prs.VerifiedPod(VICTIM)
    assert pull.calls == []


async def test_an_unresolved_kid_on_a_latched_row_is_refused(hub, monkeypatch):
    verify, registry, store, _ = hub
    registry.rows[OWNER]["identity_mode"] = "signed"
    store.pull_stamps[OWNER] = int(time.time() * 1000)
    _google_accepts(monkeypatch, OWNER)
    assert await verify(_request(key=OTHER_KEY), "Bearer google") is None


# -- the MCP transaction fence ---------------------------------------------------------


def _review(hushh_id: str = OWNER) -> PodMcpTerms:
    return PodMcpTerms(
        ownerId="u",
        hushhId=hushh_id,
        podKeyId="podk_test",
        environment="dev",
        epoch=1,
        conversationId="thread",
        connectorId="custom_test",
        toolName="mcp_" + "a" * 40,
        callId="call",
        catalogRevision="rev1",
        commitment="b" * 64,
    )


def test_the_mcp_fence_compares_a_signed_principal_by_key_id():
    kid = _public(POD_KEY)[1]
    row = {"hushh_id": OWNER, "pod_signing_key_id": kid, "backend_metadata": {}}
    assert _principal_holds_row(prs.VerifiedPod(OWNER, key_id=kid), _review(), row)
    rotated = {**row, "pod_signing_key_id": _public(OTHER_KEY)[1]}
    assert not _principal_holds_row(prs.VerifiedPod(OWNER, key_id=kid), _review(), rotated)
    assert not _principal_holds_row(prs.VerifiedPod(OWNER, key_id=kid), _review(VICTIM), row)
    assert not _principal_holds_row(prs.VerifiedPod(OWNER), _review(), row)


def test_the_mcp_fence_still_binds_a_google_principal_to_its_service_account():
    row = {
        "hushh_id": OWNER,
        "backend_metadata": {"runtime_service_account": "pod@owner.iam.gserviceaccount.com"},
    }
    account = "pod@owner.iam.gserviceaccount.com"
    assert _principal_holds_row(VerifiedOwnerPod(OWNER, account), _review(), row)
    assert _principal_holds_row(prs.VerifiedPod(OWNER, service_account=account), _review(), row)
    assert not _principal_holds_row(
        prs.VerifiedPod(OWNER, service_account="other@x.iam.gserviceaccount.com"), _review(), row
    )


# -- end to end: the pod's real client against the hub's real route ---------------------


def test_an_azure_pod_heartbeat_is_accepted_end_to_end_and_a_replay_is_not(monkeypatch):
    """No metadata server, no Google token: the pod's own client, over HTTP, into the
    hub's heartbeat route, which reads the body again after the verifier did."""
    import base64

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api.routes.one import pod_heartbeat
    from hushh_mcp.services import pod_self_registration
    from hushh_mcp.services.pod_hub_client import PodHubClient

    monkeypatch.setenv(
        pod_self_registration.POD_PRIVATE_KEY_ENV, base64.b64encode(b"k" * 32).decode()
    )
    monkeypatch.setattr(pod_self_registration, "_STATE", None)
    monkeypatch.setattr(pod_self_registration, "_SIGNING", None)
    monkeypatch.setenv("HUSSH_ID", OWNER)
    public = prs.public_key_b64(pod_self_registration.pod_signing_key())

    row = _row(OWNER, pod_signing_pubkey=public, pod_signing_key_id=prs.signing_key_id(public))
    registry = _Registry({OWNER: row})
    beats: list[Optional[dict]] = []

    async def record_heartbeat(*, hushh_id, observed=None):
        beats.append(observed)
        return dict(registry.rows[hushh_id])

    registry.record_heartbeat = record_heartbeat
    monkeypatch.setattr(pod_heartbeat, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(pod_heartbeat, "PersonalAgentRegistryRepo", lambda: registry)
    monkeypatch.setattr(pia, "pod_hub_identity_auth_enabled", lambda: True)
    monkeypatch.setattr(pia, "pod_hub_expected_audience", lambda: "http://testserver")
    monkeypatch.setattr(pia, "_registry", lambda: registry)
    store = _Store(registry)  # one shared store, as the database is
    monkeypatch.setattr(pia, "_identity_store", lambda: store)
    app = FastAPI()
    app.include_router(pod_heartbeat.router)
    hub = TestClient(app)
    wire: list[dict] = []

    class _Wire:
        def get(self, url, **_kwargs):
            raise ConnectionError("no metadata server off Google Cloud")

        def post(self, url, data=None, headers=None, timeout=None):
            wire.append({"url": url, "data": data, "headers": headers})
            return hub.post(url, content=data, headers=headers)

    client = PodHubClient(base_url="http://testserver", session=_Wire())
    response = client.post("/api/one/pod/heartbeat", json={"imageTag": "v1"})

    assert response.status_code == 200, response.text
    assert "Authorization" not in wire[0]["headers"]
    assert beats == [{"imageTag": "v1"}]
    assert registry.rows[OWNER]["identity_mode"] == "signed"

    replay = hub.post(wire[0]["url"], content=wire[0]["data"], headers=wire[0]["headers"])
    assert replay.status_code == 401
