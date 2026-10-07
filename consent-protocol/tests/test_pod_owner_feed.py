"""The signed owner feed: hub route, envelope, agent client and specialist ports.

The hub half and the agent half run against each other with real keys: the hub
signs under ``OWNER_FEED`` and seals to the agent's X25519 key; the agent opens and
verifies. Only the registry, the request verifier and the projection reader are
replaced.
"""

from __future__ import annotations

import base64
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api.routes.one import pod_owner_feed as route  # noqa: E402
from hushh_mcp.consent import token_signing  # noqa: E402
from hushh_mcp.services import pod_owner_feed_envelope as envelope_mod  # noqa: E402
from hushh_mcp.services import pod_specialist_runtime  # noqa: E402
from hushh_mcp.services.pod_owner_feed_client import (  # noqa: E402
    OwnerFeedUnavailable,
    PodOwnerFeedClient,
)
from hushh_mcp.services.pod_owner_read_ports import (  # noqa: E402
    OwnerFeedLocationPort,
    owner_read_ports,
)
from hushh_mcp.services.pod_request_signing import VerifiedPod  # noqa: E402

OWNER = "owner-uid"
POD = "ha1_owner_pod"
SIGNING_KID = "pods_" + "a" * 32
POD_KEY_ID = "pod-0123456789abcdef"
LOCATION = {
    "recipients": [],
    "circles": [],
    "myRecipientKey": None,
    "ownerGrants": [{"id": "g1"}],
    "receivedGrants": [],
    "publicInvites": [],
    "requests": [],
    "capabilityScopes": [],
}
NAV = {
    "active": {"items": [{"scope": "first"}, {"scope": "second"}], "total": 2},
    "previous": {"items": [], "total": 0},
}


def _seed() -> str:
    raw = Ed25519PrivateKey.generate().private_bytes(
        serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()
    )
    return base64.b64encode(raw).decode()


def _x25519_public_b64(key: X25519PrivateKey) -> str:
    raw = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return base64.b64encode(raw).decode()


@pytest.fixture
def agent(monkeypatch):
    monkeypatch.setenv("HUSSH_ID", POD)
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("HUSSH_POD_KMS_KEY", "synthetic-owner-kms")
    monkeypatch.delenv("HUSSH_POD_KEY_VAULT_KEY", raising=False)
    monkeypatch.setenv("OWNER_FEED_ED25519_PRIVATE_KEY", _seed())
    monkeypatch.delenv("OWNER_FEED_ED25519_PUBLIC_KEYS", raising=False)
    token_signing.reset_caches()
    private = X25519PrivateKey.generate()
    yield SimpleNamespace(private_key=private, key_id=POD_KEY_ID)
    token_signing.reset_caches()


class _Registry:
    def __init__(self, row):
        self.row = row

    async def get_by_hushh_id(self, hushh_id):
        return self.row if self.row and self.row["hushh_id"] == hushh_id else None

    async def get(self, user_id):
        return self.row if self.row and self.row["user_id"] == user_id else None


def _row(keypair, **over):
    row = {
        "user_id": OWNER,
        "hushh_id": POD,
        "status": "provisioned",
        "deployment_target": "user_gcp",
        "pod_signing_key_id": SIGNING_KID,
        "pod_key_id": keypair.key_id,
        "pod_pubkey": _x25519_public_b64(keypair.private_key),
        "backend_metadata": {},
    }
    row.update(over)
    return row


def _verifier(pod):
    async def verify(_request, _authorization, *, owner_bound):
        assert owner_bound is True
        return pod

    return verify


async def _reader(kind, owner_id, *, marketplace, command):
    assert owner_id == OWNER
    return {"location": LOCATION, "nav": NAV}.get(kind, {"items": []})


async def _serve(keypair, *, pod=None, row=None, kind="location", **over):
    return await route.serve_owner_feed(
        SimpleNamespace(),
        kind,
        None,
        registry=_Registry(row if row is not None else _row(keypair)),
        verifier=_verifier(pod or VerifiedPod(POD, key_id=SIGNING_KID)),
        reader=over.pop("reader", _reader),
        **over,
    )


def _open(keypair, served, kind="location", **over):
    return envelope_mod.open_feed(
        served["envelope"],
        pod_private_key=over.get("private_key", keypair.private_key),
        hushh_id=POD,
        pod_key_id=keypair.key_id,
        kind=kind,
        now_ms=int(time.time() * 1000),
    )


# -- hub route + envelope round trip ---------------------------------------------------


async def test_the_feed_is_signed_and_sealed_to_this_agent_and_opens_here(agent):
    served = await _serve(agent)
    assert set(served) == {"envelope"} and "grants" not in str(served), "sealed, not plain"
    feed = _open(agent, served)
    assert feed["projection"] == LOCATION
    assert (feed["kind"], feed["ownerId"], feed["hushhId"]) == ("location", OWNER, POD)
    assert feed["version"] == envelope_mod.projection_version(LOCATION)


async def test_a_wrong_pod_key_cannot_open_the_feed(agent):
    served = await _serve(agent)
    with pytest.raises(envelope_mod.OwnerFeedRefused) as refused:
        _open(agent, served, private_key=X25519PrivateKey.generate())
    assert refused.value.code == "BAD_ENVELOPE"


async def test_a_feed_signed_by_another_key_is_refused(agent, monkeypatch):
    served = await _serve(agent)
    monkeypatch.setenv("OWNER_FEED_ED25519_PRIVATE_KEY", _seed())
    token_signing.reset_caches()
    with pytest.raises(envelope_mod.OwnerFeedRefused) as refused:
        _open(agent, served)
    assert refused.value.code == "BAD_SIGNATURE"


async def test_a_feed_opened_as_another_kind_or_too_old_is_refused(agent):
    served = await _serve(agent)
    with pytest.raises(envelope_mod.OwnerFeedRefused) as wrong_kind:
        _open(agent, served, kind="nav")
    assert wrong_kind.value.code == "WRONG_AGENT"
    old = await _serve(agent, now_ms=int(time.time() * 1000) - envelope_mod.MAX_CLOCK_SKEW_MS - 1)
    with pytest.raises(envelope_mod.OwnerFeedRefused) as stale:
        _open(agent, old)
    assert stale.value.code == "STALE_FEED"


@pytest.mark.parametrize(
    ("pod", "status"),
    [
        (None, 401),
        (VerifiedPod(POD, service_account="sa@example.iam"), 401),
        (VerifiedPod(POD, key_id=SIGNING_KID, standby=True), 401),
        (VerifiedPod(POD, key_id="pods_" + "b" * 32), 403),
    ],
)
async def test_only_the_signing_key_recorded_on_the_row_is_served(agent, pod, status):
    async def deny(*_a, **_k):
        return None

    with pytest.raises(HTTPException) as refused:
        await route.serve_owner_feed(
            SimpleNamespace(),
            "location",
            None,
            registry=_Registry(_row(agent)),
            verifier=deny if pod is None else _verifier(pod),
            reader=_reader,
        )
    assert refused.value.status_code == status


@pytest.mark.parametrize(
    "over",
    [
        {"deployment_target": "gcp"},
        {"status": "erasing"},
        {"backend_metadata": {"erasure": {"at": 1}}},
    ],
)
async def test_a_row_that_is_not_a_serving_owner_cloud_agent_is_refused(agent, over):
    with pytest.raises(HTTPException) as refused:
        await _serve(agent, row=_row(agent, **over))
    assert refused.value.status_code == 403


async def test_an_unknown_kind_is_absent_and_a_hub_without_a_feed_key_is_unavailable(
    agent, monkeypatch
):
    with pytest.raises(HTTPException) as unknown:
        await _serve(agent, kind="email")
    assert unknown.value.status_code == 404
    monkeypatch.delenv("OWNER_FEED_ED25519_PRIVATE_KEY")
    token_signing.reset_caches()
    with pytest.raises(HTTPException) as unsigned:
        await _serve(agent)
    assert unsigned.value.status_code == 503


# -- agent client --------------------------------------------------------------------


class _Hub:
    """Serves real hub-route envelopes to the agent client."""

    def __init__(self, keypair, *, owner_row=None):
        self.keypair, self.row, self.calls = keypair, owner_row, []

    def _respond(self, kind, **over):
        import asyncio

        served = asyncio.run(_serve(self.keypair, kind=kind, row=self.row, **over))
        return SimpleNamespace(status_code=200, json=lambda: served)

    def get(self, path, *, params=None):
        self.calls.append(("GET", path, params))
        return self._respond(path.rsplit("/", 1)[-1])

    def post(self, path, *, json=None):
        self.calls.append(("POST", path, json))

        async def command_reader(kind, owner_id, *, marketplace, command):
            return {"projection": {"items": []}, "observations": []}

        return self._respond("command", reader=command_reader)


def _client(agent, hub=None):
    return PodOwnerFeedClient(hub=hub or _Hub(agent), keypair=agent)


def test_the_client_returns_the_verified_projection_and_caches_by_version(agent):
    hub = _Hub(agent)
    client = _client(agent, hub)
    assert client.read("location", OWNER) == LOCATION
    assert client.read("location", OWNER) == LOCATION
    assert len(hub.calls) == 1, "a second question in the same window reuses the read"
    assert client.read("command", OWNER, command={"kind": "circles"})["projection"] == {"items": []}
    assert hub.calls[-1][0] == "POST"


def test_the_client_refuses_a_feed_for_another_owner_even_from_its_cache(agent):
    client = _client(agent)
    assert client.read("location", OWNER) == LOCATION
    with pytest.raises(OwnerFeedUnavailable):
        client.read("location", "someone-else")


def test_the_client_refuses_a_feed_sealed_to_another_agent(agent):
    stranger = SimpleNamespace(private_key=X25519PrivateKey.generate(), key_id=POD_KEY_ID)
    client = PodOwnerFeedClient(hub=_Hub(agent), keypair=stranger)
    with pytest.raises(OwnerFeedUnavailable):
        client.read("location", OWNER)


# -- specialist ports ------------------------------------------------------------------


@pytest.fixture
def no_hub_door(monkeypatch):
    def refuse(*_a, **_k):
        raise AssertionError("an owner-cloud port handed a scope token to a hub door")

    monkeypatch.setattr(pod_specialist_runtime, "_hub_read", refuse)


GRANTS = {"location": "loc-scope", "nav": "nav-scope", "marketplace": "mk-scope"}


async def test_owner_cloud_ports_read_only_the_feed_never_a_scope_token_door(agent, no_hub_door):
    import asyncio

    ports = owner_read_ports(OWNER, GRANTS, feed=_client(agent))
    assert ports.feed is not None
    assert await asyncio.to_thread(ports.location.list_state, user_id=OWNER) == LOCATION
    page = await ports.consent_center.list_center(OWNER, actor="investor", surface="active", top=5)
    assert page["items"] == NAV["active"]["items"]
    assert await ports.marketplace.list_published_slices(user_id=OWNER) == []
    for port in (ports.location, ports.consent_center, ports.marketplace):
        assert port._scope_token == "", "an owner-cloud port holds no scope token to courier"


async def test_owner_cloud_ports_refuse_a_foreign_owner(agent, no_hub_door):
    ports = owner_read_ports(OWNER, GRANTS, feed=_client(agent))
    with pytest.raises(PermissionError):
        ports.location.list_state(user_id="someone-else")
    with pytest.raises(PermissionError):
        await ports.consent_center.list_center(
            "someone-else", actor="investor", surface="active", top=3
        )
    with pytest.raises(PermissionError):
        await ports.marketplace.list_published_slices(user_id="someone-else")


async def test_without_a_feed_the_ports_keep_the_scope_token_door(monkeypatch):
    from hushh_mcp.services import pod_owner_feed_client

    calls = []

    def door(name, scope_token, **options):
        calls.append((name, scope_token))
        return LOCATION

    monkeypatch.setattr(pod_specialist_runtime, "_hub_read", door)
    monkeypatch.setattr(pod_owner_feed_client, "owner_feed_client", lambda: None)
    monkeypatch.delenv("HUSSH_POD_KMS_KEY", raising=False)
    monkeypatch.delenv("HUSSH_POD_KEY_VAULT_KEY", raising=False)
    ports = owner_read_ports(OWNER, GRANTS)
    assert ports.feed is None
    assert ports.location.list_state(user_id=OWNER) == LOCATION
    assert calls == [("location", "loc-scope")]


async def test_a_feed_failure_is_typed_unavailable_and_recorded(no_hub_door):
    class _Down:
        def read(self, *_a, **_k):
            raise OwnerFeedUnavailable("down")

    with pod_specialist_runtime.trace_specialist_dependencies() as trace:
        with pytest.raises(pod_specialist_runtime.PodSpecialistInformationUnavailable):
            OwnerFeedLocationPort(OWNER, _Down()).list_state(user_id=OWNER)
    assert trace.unavailable_doors == ["location"] and trace.hub_reads == 0


def test_the_feed_is_on_exactly_when_the_agent_holds_a_feed_verifying_key(agent, monkeypatch):
    from hushh_mcp.services import pod_owner_feed_client

    monkeypatch.setattr(pod_owner_feed_client, "_SHARED", None)
    assert pod_owner_feed_client.owner_feed_client() is not None
    monkeypatch.delenv("OWNER_FEED_ED25519_PRIVATE_KEY")
    token_signing.reset_caches()
    assert pod_owner_feed_client.owner_feed_client() is None


async def test_the_runtime_wires_feed_ports_and_nav_asks_no_hub_scope(agent, monkeypatch):
    from hushh_mcp.services import pod_consent_client, pod_memory_service, pod_owner_feed_client
    from hushh_mcp.services.pod_consent_client import ConsentVerdict

    class _Log:
        _owner_id = POD

        async def require_open(self):
            return None

    asked = []

    async def local(token, *, expected_scope="", **_k):
        asked.append(expected_scope)
        return ConsentVerdict(True, True, OWNER, POD, expected_scope)

    async def hub(*_a, **_k):
        raise AssertionError("an owner-cloud specialist asked the hub about a scope token")

    monkeypatch.setattr(pod_consent_client, "verify_consent", hub)
    monkeypatch.setattr(pod_memory_service, "_resolve_log", lambda: _Log())
    monkeypatch.setattr(pod_owner_feed_client, "_SHARED", _client(agent))
    runtime = pod_specialist_runtime.build_pod_specialist_runtime(
        user_id=OWNER,
        hushh_id=POD,
        consent_token="pod-session:sid",  # noqa: S106 - a session marker, not a credential
        provider="gemini",
        model="synthetic-model",
        runtime_mode="byok",
        credential="owner-" + "key",
        credential_transport="developer_api",
        vertex_project=None,
        vertex_location=None,
        data_door_grants=GRANTS,
        verifier=local,
    )
    location = await runtime.service_for("agent_location")
    assert isinstance(location._location_service, OwnerFeedLocationPort)
    nav = await runtime.service_for("agent_nav")
    await nav._require_read(SimpleNamespace(user_id=OWNER, consent_token="pod-session:sid"))  # noqa: S106 - session marker
    assert set(asked) == {"pkm.read"}, "only the owner's own session was consulted"
    # Local admission still holds the rest of the line: owner check, the private
    # invocation gate, and the scoped token the @hushh_tool decorator verifies.
    with pytest.raises(PermissionError):
        await nav._require_read(SimpleNamespace(user_id="someone-else"))
    assert nav._admit_owner is not None
    assert nav._scope_tokens == {"agent.nav.review": GRANTS["nav"]}


def test_command_reads_use_the_feed_and_never_construct_a_hub_door(agent, monkeypatch):
    from hushh_mcp.services import pod_command_reads

    class _NoDoor:
        def __init__(self, *a, **k):
            raise AssertionError("a hub door client was built for an owner-cloud command read")

    monkeypatch.setattr(pod_command_reads, "PodHubClient", _NoDoor)
    reads = pod_command_reads.PodCommandReads(
        scope_token="placeholder",  # noqa: S106 - not a credential
        feed=_client(agent),
        user_id=OWNER,
    )
    import asyncio

    assert asyncio.run(reads.read("circles")) == {"items": []}


async def test_missing_feed_or_verifying_key_never_reopens_a_private_content_door(
    agent, no_hub_door, monkeypatch
):
    from hushh_mcp.services import pod_command_reads, pod_owner_feed_client

    monkeypatch.delenv("OWNER_FEED_ED25519_PRIVATE_KEY")
    token_signing.reset_caches()
    assert pod_owner_feed_client.owner_feed_client() is None
    ports = owner_read_ports(OWNER, GRANTS)
    assert ports.feed is None
    with pytest.raises(pod_specialist_runtime.PodSpecialistInformationUnavailable):
        ports.location.list_state(user_id=OWNER)
    reads = pod_command_reads.PodCommandReads(scope_token="synthetic-grant", user_id=OWNER)  # noqa: S106 - fixture
    assert reads._hub is None
    with pytest.raises(pod_command_reads.PodHubUnavailable):
        await reads.read("circles")


def test_private_command_observations_never_leave_the_agent(agent):
    import asyncio
    from datetime import UTC, datetime

    from pydantic import ValidationError

    from hushh_mcp.operons.location.references import LocationObservation
    from hushh_mcp.services.pod_command_reads import MetadataCommandReadOptions, PodCommandReads

    private = LocationObservation(
        reference="candidate_" + "a" * 32,
        kind="place",
        id="private-provider-locator",
        name="private-owner-selection",
        observed_at=datetime.now(UTC),
    )
    circle = LocationObservation(
        reference="candidate_" + "b" * 32,
        kind="circle",
        id="hub-circle-id",
        name="private-saved-label",
        observed_at=datetime.now(UTC),
    )

    class Feed:
        requests = []

        def read(self, *_a, command, **_k):
            self.requests.append(command)
            return {"projection": {"items": []}, "observations": []}

    feed = Feed()
    reads = PodCommandReads(
        scope_token="",
        user_id=OWNER,
        feed=feed,
        observations=[private],
        saved_observations=[circle],
    )
    assert asyncio.run(reads.read("nearby"))["items"][0]["name"] == private.name
    assert not feed.requests, "private provider observations stay local"
    asyncio.run(reads.read("members", reference=circle.reference))
    assert feed.requests == [
        {"kind": "members", "query": "", "reference": circle.id, "page": 1, "limit": 20}
    ]
    with pytest.raises(ValidationError):
        MetadataCommandReadOptions(kind="circles", observations=[private.model_dump(mode="json")])
    with pytest.raises(ValidationError):
        MetadataCommandReadOptions(
            kind="circles", saved_observations=[circle.model_dump(mode="json")]
        )


async def test_the_feed_projects_metadata_and_cannot_courier_private_content(agent):
    async def reader(*_a, **_k):
        return {
            **LOCATION,
            "privateContent": "private-pkm-value",
            "requests": [{"id": "r1", "status": "pending", "message": "private-message"}],
            "myRecipientKey": {
                "keyId": "k1",
                "publicKeyJwk": {"kty": "EC", "x": "public", "d": "private-key"},
            },
        }

    projection = _open(agent, await _serve(agent, reader=reader))["projection"]
    assert projection["requests"] == [{"id": "r1", "status": "pending"}]
    assert projection["myRecipientKey"]["publicKeyJwk"] == {"kty": "EC", "x": "public"}
    assert "private" not in str(projection)


@pytest.mark.parametrize(
    "field,value",
    [
        ("recipients", [{"displayName": {"private": "owner-content"}}]),
        ("myRecipientKey", {"publicKeyJwk": {"kty": "EC", "x": {"private": "owner-content"}}}),
        ("myRecipientKey", {"publicKeyJwk": {"key_ops": [{"private": "owner-content"}]}}),
        ("ownerGrants", [{"capabilityScopes": [{"private": "owner-content"}]}]),
    ],
)
def test_a_kept_metadata_name_cannot_carry_an_undeclared_content_object(agent, field, value):
    with pytest.raises(envelope_mod.OwnerFeedRefused, match="BAD_PROJECTION"):
        envelope_mod.sign_feed(
            kind="location",
            owner_id=OWNER,
            hushh_id=POD,
            projection={**LOCATION, field: value},
            issued_at_ms=int(time.time() * 1000),
        )


async def test_a_pod_key_change_during_the_read_refuses_delivery(agent):
    registry = _Registry(_row(agent))

    async def reader(*_a, **_k):
        registry.row = _row(agent, pod_key_id="pod-fedcba9876543210")
        return LOCATION

    with pytest.raises(HTTPException) as refusal:
        await route.serve_owner_feed(
            SimpleNamespace(),
            "location",
            None,
            registry=registry,
            verifier=_verifier(VerifiedPod(POD, key_id=SIGNING_KID)),
            reader=reader,
        )
    assert refusal.value.status_code == 403


def test_cached_feed_cannot_outlive_its_pod_binding_or_be_mutated(agent, monkeypatch):
    hub, client = _Hub(agent), None
    client = _client(agent, hub)
    changed = client.read("location", OWNER)
    changed["ownerGrants"][0]["id"] = "changed"
    assert client.read("location", OWNER) == LOCATION
    monkeypatch.setenv("HUSSH_ID", "ha1_another_pod")
    with pytest.raises(OwnerFeedUnavailable):
        client.read("location", OWNER)
    assert len(hub.calls) == 2, "cached information never crosses a pod binding change"


async def test_nav_actual_invocation_and_tool_require_a_live_local_owner_session(
    agent, monkeypatch
):
    from hushh_mcp.adk_bridge.contract import A2AAuthorityContext, A2ATask
    from hushh_mcp.hushh_adk.context import HushhContext
    from hushh_mcp.hushh_adk.tools import hushh_tool
    from hushh_mcp.services import pod_owner_feed_client
    from hushh_mcp.services.pod_consent_client import ConsentVerdict

    allowed = True

    async def local(_token, *, expected_scope="", **_k):
        return ConsentVerdict(allowed, True, OWNER, POD, expected_scope)

    monkeypatch.setattr(pod_owner_feed_client, "_SHARED", _client(agent))
    authority = A2AAuthorityContext(
        OWNER,
        POD,
        "metadata-review",
        "first_party",
        invocation_capabilities=("agent.nav.review",),
        expires_at_ms=int(time.time() * 1000) + 60_000,
    )

    async def nav_for(token):
        runtime = pod_specialist_runtime.build_pod_specialist_runtime(
            user_id=OWNER,
            hushh_id=POD,
            consent_token=token,
            provider="gemini",
            model="synthetic-model",
            runtime_mode="byok",
            credential="synthetic-key",
            credential_transport="developer_api",
            vertex_project=None,
            vertex_location=None,
            data_door_grants=GRANTS,
            verifier=local,
        )
        nav = await runtime.service_for("agent_nav")
        task = A2ATask(
            OWNER,
            token,
            None,
            authority=authority,
            expected_tenant_id=POD,
            expected_task_id="metadata-review",
        )
        return nav, task

    nav, task = await nav_for("pod-session:owner")
    assert (await nav.handle(task)).is_complete  # positive control: real invocation gate

    @hushh_tool(scope="agent.nav.review")
    async def read_metadata():
        return await nav._consent_service.list_center(
            OWNER, actor="investor", surface="active", top=5
        )

    with HushhContext(
        OWNER,
        task.consent_token,
        service_ports={"consent_center": nav._consent_service},
        scope_tokens={"agent.nav.review": "not-owner-authority"},
    ):
        assert (await read_metadata())["items"] == NAV["active"]["items"]
        allowed = False
        with pytest.raises(PermissionError):
            await read_metadata()
    allowed = True
    hub_nav, hub_task = await nav_for("HCT:synthetic-hub-authority")
    with pytest.raises(PermissionError, match="local session"):
        await hub_nav.handle(hub_task)
