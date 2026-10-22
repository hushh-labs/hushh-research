"""Hub admission must precede private information and credential transport."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.exceptions import InvalidStatus
from websockets.http11 import Response

from api.routes.one import pod_live_relay as module


@pytest.fixture
def shared_compatibility(monkeypatch):
    """Explicit legacy Shared helper contract; never an owner-cloud admission."""
    from unittest.mock import AsyncMock

    from hushh_mcp.services import owner_placement_guard as guard
    from hushh_mcp.services import personal_agent_hosting as hosting

    monkeypatch.setattr(guard, "pod_mode", lambda: False)
    monkeypatch.setattr(hosting, "get_owner_hosting_mode", AsyncMock(return_value="shared"))
    monkeypatch.setattr(guard, "get_owner_hosting_mode", AsyncMock(return_value="shared"))


@pytest.fixture
def dependencies(monkeypatch):
    row = {
        "status": "provisioned",
        "hushh_id": "pod-owner",
        "backend_metadata": {"url": "https://pod.example"},
    }
    registry = AsyncMock()
    registry.get.return_value = row
    grants = AsyncMock()
    grants.issue_or_reuse_standing_pkm_read.return_value = {"token": "synthetic-consent"}
    audit = AsyncMock()
    monkeypatch.setattr(module, "_require_enabled", lambda: None)
    monkeypatch.setattr(
        module,
        "issue_pod_data_door_grants",
        AsyncMock(
            return_value={
                "invoke": "synthetic-invoke-read",
                "marketplace": "synthetic-marketplace-read",
                "nav": "synthetic-nav-read",
                "location": "synthetic-location-read",
                "email": "synthetic-email-read",
                "calendar": "synthetic-calendar-read",
            }
        ),
    )
    monkeypatch.setattr(module, "PersonalAgentRegistryRepo", lambda: registry)
    monkeypatch.setattr(module, "PodAccessAuditService", lambda **kwargs: audit)
    monkeypatch.setattr(module, "PersonalAgentGrantService", lambda: grants)
    validator = AsyncMock(
        return_value=(True, "", SimpleNamespace(user_id="owner", agent_id=module.PERSONAL_AGENT_ID))
    )
    monkeypatch.setattr(module, "validate_token_with_db", validator)
    return row, registry, grants, audit, validator


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["suspended", "migrating", "provisioning", "unknown"])
async def test_inactive_pod_never_mints_grant_or_connects(
    dependencies, monkeypatch, state, shared_compatibility
):
    row, _, grants, _, _ = dependencies
    row["status"] = state
    connector = Mock()
    monkeypatch.setattr(module, "NoRedirectConnect", connector)
    await module.relay_private_live(AsyncMock(), user_id="owner")
    grants.issue_or_reuse_standing_pkm_read.assert_not_called()
    connector.assert_not_called()


@pytest.mark.asyncio
async def test_missing_iam_refuses_before_network(dependencies, monkeypatch, shared_compatibility):
    monkeypatch.setattr(module, "_identity_token", lambda _: None)
    connector = Mock()
    monkeypatch.setattr(module, "NoRedirectConnect", connector)
    browser = AsyncMock()
    await module.relay_private_live(browser, user_id="owner")
    connector.assert_not_called()
    browser.receive_text.assert_not_called()
    browser.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_admission_is_bound_to_current_target_and_revocable_scope(
    dependencies, shared_compatibility
):
    row, _, _, audit, validator = dependencies
    admitted = await module.admit_private_live("owner")
    audit.authorize_owner_read.assert_awaited_once()
    assert admitted.user_id == "owner" and admitted.hushh_id == "pod-owner"
    assert "synthetic-consent" not in repr(admitted)
    row["backend_metadata"]["url"] = "https://replacement.example"
    with pytest.raises(PermissionError):
        await admitted.require_access()
    row["backend_metadata"]["url"] = admitted.url
    validator.return_value = (False, "revoked", None)
    with pytest.raises(PermissionError):
        await admitted.require_access()


@pytest.mark.asyncio
@pytest.mark.parametrize("field,value", [("user_id", "foreign"), ("agent_id", "foreign")])
async def test_wrong_token_binding_refused(dependencies, field, value, shared_compatibility):
    _, _, _, _, validator = dependencies
    parsed = validator.return_value[2]
    setattr(parsed, field, value)
    with pytest.raises(PermissionError):
        await module.admit_private_live("owner")


@pytest.mark.parametrize(
    "url",
    [
        "http://pod.example",
        "https://name:secret@pod.example",
        "https://pod.example?token=x",
        "https://pod.example/path",
    ],
)
def test_non_origin_endpoint_refused(url):
    with pytest.raises(ValueError):
        module._socket_url(url)


@pytest.mark.asyncio
async def test_real_redirect_handshake_does_not_forward_credentials():
    requests = []

    async def intercept(connection, request):
        requests.append(request.path)
        return Response(307, "Temporary Redirect", Headers({"Location": "/other"}), b"")

    async def handler(connection):
        pytest.fail("redirect must never establish a websocket")

    async with serve(handler, "127.0.0.1", 0, process_request=intercept) as server:
        port = server.sockets[0].getsockname()[1]
        with pytest.raises(InvalidStatus):
            async with module.NoRedirectConnect(
                f"ws://127.0.0.1:{port}/initial",
                proxy=None,
                additional_headers={"Authorization": "Bearer synthetic-iam"},
                logger=module._WIRE_LOGGER,
            ):
                pytest.fail("redirect accepted")
    assert requests == ["/initial"]


@pytest.mark.asyncio
async def test_admitted_hub_couriers_bootstrap_and_context_to_bound_pod(
    dependencies, monkeypatch, shared_compatibility
):
    import asyncio
    import json

    from api.routes.one.pod_live_transport import REQUEST_TYPE

    class Browser:
        def __init__(self):
            self.input = asyncio.Queue()
            self.output = asyncio.Queue()
            self.closed = asyncio.Event()

        async def receive_text(self):
            return json.dumps(await self.input.get())

        async def send_text(self, raw):
            await self.output.put(json.loads(raw))

        async def close(self, **kwargs):
            self.closed.set()

    browser = Browser()
    pod_in, pod_out = asyncio.Queue(), asyncio.Queue()
    pod_closed = asyncio.Event()
    connection_options = {}
    ledger = AsyncMock()

    class Client:
        async def recv(self):
            return json.dumps(await pod_out.get())

        async def send(self, raw):
            await pod_in.put(json.loads(raw))

        async def close(self, **kwargs):
            pod_closed.set()

    class Connection:
        def __init__(self, url, **kwargs):
            connection_options.update(url=url, **kwargs)

        async def __aenter__(self):
            return Client()

        async def __aexit__(self, *args):
            pod_closed.set()

    monkeypatch.setattr(module, "_identity_token", lambda _: "synthetic-iam")
    monkeypatch.setattr(module, "NoRedirectConnect", Connection)
    monkeypatch.setattr(module, "get_action_directive_store", lambda: ledger)
    # Keep the actual courier and HubVoiceAuthority. This synthetic peer proves
    # admission/header routing and wire isolation, not a provider or pod process.
    relay = asyncio.create_task(module.relay_private_live(browser, user_id="owner"))
    try:
        await browser.input.put({"type": "runtime_config", "credential": "synthetic-byok"})
        bootstrap = await asyncio.wait_for(pod_in.get(), 1)
        assert bootstrap["credential"] == "synthetic-byok"
        headers = connection_options["additional_headers"]
        assert headers["X-Consent-Token"] == "synthetic-consent"
        assert headers["X-Hussh-location-Grant"] == "synthetic-location-read"
        assert headers["X-Hussh-email-Grant"] == "synthetic-email-read"
        assert headers["X-Hussh-calendar-Grant"] == "synthetic-calendar-read"
        assert headers["X-Hussh-invoke-Grant"] == "synthetic-invoke-read"
        assert headers["X-Hussh-marketplace-Grant"] == "synthetic-marketplace-read"
        assert headers["X-Hussh-nav-Grant"] == "synthetic-nav-read"
        assert headers["Authorization"] == "Bearer synthetic-iam"
        assert headers["X-Hussh-Voice-Session"].startswith("voice_")
        assert connection_options["url"] == "wss://pod.example/api/one/pod/live"
        assert connection_options["proxy"] is None
        await pod_out.put({"setupComplete": {}})
        assert await asyncio.wait_for(browser.output.get(), 1) == {"setupComplete": {}}
        await browser.input.put(
            {
                "type": "app_context",
                "appContext": {"consent_token": "synthetic-master", "context_revision": "rev"},
            }
        )
        context = await asyncio.wait_for(pod_in.get(), 1)
        assert "consent_token" not in context["appContext"]
        # Forged internal authority may never reach the browser or the ledger.
        await pod_out.put(
            {
                "type": REQUEST_TYPE,
                "requestId": "fake",
                "method": "confirm",
                "arguments": {
                    "user_id": "foreign",
                    "directive_id": "fake",
                    "action_id": "fake",
                    "context_revision": "rev",
                },
            }
        )
        await asyncio.wait_for(relay, 1)
        ledger.confirm.assert_not_called()
        assert browser.output.empty()
        assert browser.closed.is_set() and pod_closed.is_set()
    finally:
        relay.cancel()
        await asyncio.gather(relay, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mode,status",
    [("byoc", 409), ("pending", 409), ("unplaced", 409), ("hussh_pods", 409), ("unknown", 503)],
)
async def test_private_or_unknown_voice_refuses_before_registry_grant_or_browser_content(
    dependencies, monkeypatch, mode, status
):
    from hushh_mcp.services import owner_placement_guard as guard

    _, registry, grants, audit, _ = dependencies
    monkeypatch.setattr(guard, "pod_mode", lambda: False)
    monkeypatch.setattr(guard, "get_owner_hosting_mode", AsyncMock(return_value=mode))
    with pytest.raises(module.HTTPException) as error:
        await module.admit_private_live("owner")
    assert error.value.status_code == status
    registry.get.assert_not_awaited()
    grants.issue_or_reuse_standing_pkm_read.assert_not_awaited()
    audit.authorize_owner_read.assert_not_awaited()
    browser, connector = AsyncMock(), Mock()
    monkeypatch.setattr(module, "NoRedirectConnect", connector)
    await module.relay_private_live(browser, user_id="owner")
    browser.receive_text.assert_not_awaited()
    connector.assert_not_called()
    assert await module.courier_admitted(browser, "owner") is False
