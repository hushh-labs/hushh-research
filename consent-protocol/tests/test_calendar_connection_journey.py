"""Owner Calendar status, refresh and booking authority stay consistent across chat turns."""

from dataclasses import replace

import pytest

from hushh_mcp.agents.calendar import tools as calendar_tools
from hushh_mcp.services import google_calendar_service
from hushh_mcp.services import pod_connector_credentials as credentials
from hushh_mcp.services import pod_connector_tokens as tokens
from hushh_mcp.services.google_connection_service import GoogleConnectionError
from hushh_mcp.services.pod_connector_credential_seal import OpenedConnectorCredential
from tests import pod_connector_harness as h

EVENTS = f"{h.CALENDAR}/calendars/primary/events"


READ = (h.G + "calendar.events.readonly", h.G + "calendar.freebusy")


@pytest.fixture
async def calendar_connection(monkeypatch, tmp_path):
    held = h.credential("calendar", h.SCOPES["calendar"])
    log, _, google = h.install(monkeypatch, tmp_path, connectors={"calendar": held})
    monkeypatch.setenv("GOOGLE_IOS_CONNECTOR_CLIENT_ID", held.client_id)
    opened = OpenedConnectorCredential(
        kind="authorization_code",
        connector_id="calendar",
        provider="google",
        credential_id=held.credential_id,
        issued_at_ms=1,
        client_profile="hussh_ios",
        client_id=held.client_id,
        scopes=held.granted_scopes,
    )
    held = await credentials.record_connector_credential(
        log,
        hushh_id=h.OWNER_HUSHH,
        opened=opened,
        account_subject=held.account_subject,
        granted_scopes=held.granted_scopes,
        refresh_token=held.refresh_token,
        now_ms=1,
    )
    clock = [1000.0]
    refreshes = []

    async def refresh(_url, form):
        refreshes.append(dict(form))
        return 200, {
            "access_token": "synthetic-calendar-token",
            "expires_in": 3600,
            "scope": form["scope"],
        }

    source = tokens.PodGoogleTokenSource(
        log_resolver=lambda: log, post=refresh, clock=lambda: clock[0]
    )
    monkeypatch.setattr(tokens, "_SOURCE", source)
    google.on("GET", EVENTS, {"items": []})
    google.on("POST", EVENTS, {"id": "event-1", "status": "confirmed"})
    try:
        yield held, source, google, clock, refreshes
    finally:
        h.uninstall()


async def propose(context=None):
    return await calendar_tools.propose_calendar_event(
        context or h.tool_context(),
        title="Call",
        start_at="2026-11-02T10:00:00Z",
        end_at="2026-11-02T10:30:00Z",
        attendees=["guest@example.com"],
    )


async def test_connected_calendar_refreshes_then_prepares_and_confirms_once(calendar_connection):
    held, _, google, clock, refreshes = calendar_connection
    assert credentials.connector_permissions(held)["capabilities"] == {"read": True, "manage": True}
    assert (await calendar_tools.calendar_summary(h.tool_context()))["status"] == "ok"
    clock[0] += 3600  # Expired read bearer cannot substitute for a fresh scheduling token.
    result = await propose()
    assert result["status"] == "confirmation_required", result
    assert not google.calls("POST", EVENTS)
    service = google_calendar_service.get_google_calendar_service()
    await service.execute(user_id=h.OWNER_UID, proposal_id=result["proposal_id"])
    with pytest.raises(GoogleConnectionError):
        await service.execute(user_id=h.OWNER_UID, proposal_id=result["proposal_id"])
    assert len(google.calls("POST", EVENTS)) == 1
    assert len(refreshes) == 2


async def test_connected_read_only_calendar_requests_scheduling_permission(calendar_connection):
    held, _, google, _, refreshes = calendar_connection
    read_only = replace(held, granted_scopes=READ)
    credentials.set_active_connector_credentials({"calendar": read_only})
    assert credentials.connector_permissions(read_only)["capabilities"] == {
        "read": True,
        "manage": False,
    }
    assert (await calendar_tools.calendar_summary(h.tool_context()))["status"] == "ok"
    result = await propose()
    assert result["reason_code"] == "google_permission_required"
    assert result["directive"]["payload"]["accessLevel"] == "manage"
    assert "connection_required alone does not mean disconnected" in result["next_step"]
    assert not google.calls("POST", EVENTS)
    assert len(refreshes) == 1  # Missing scope fails before another Google refresh.
    credentials.set_active_connector_credentials({"calendar": held})
    assert (await propose())["status"] == "confirmation_required"
    assert not google.calls("POST", EVENTS)


@pytest.mark.parametrize(
    "state,reason",
    [("absent", "google_not_connected"), ("needs_reauth", "google_reauthorization_required")],
)
async def test_missing_and_expired_connections_are_not_confused(calendar_connection, state, reason):
    held, _, google, _, refreshes = calendar_connection
    credentials.set_active_connector_credentials(
        {} if state == "absent" else {"calendar": replace(held, status=state, refresh_token="")}
    )
    result = await propose()
    assert result["status"] == "connection_required"
    assert result["reason_code"] == reason
    assert not refreshes and not google.requests


@pytest.mark.parametrize("revoked", [True, False])
async def test_provider_revocation_and_outage_have_different_recovery(calendar_connection, revoked):
    held, source, google, _, _ = calendar_connection

    async def refused(_url, _form):
        return (400, {"error": "invalid_grant"}) if revoked else (503, {})

    source._post = refused
    result = await propose()
    assert result["status"] == ("connection_required" if revoked else "failed")
    current = credentials.active_connector_credential("calendar")
    assert current.status == ("needs_reauth" if revoked else held.status)
    if revoked:
        assert result["reason_code"] == "google_reauthorization_required"
        await credentials.load_connector_credentials(source._log())
        assert credentials.active_connector_credential("calendar").status == "needs_reauth"
    else:
        assert "directive" not in result
    assert not google.requests


@pytest.mark.parametrize("change", ["disconnect", "reconnect", "scope"])
async def test_changed_grant_blocks_a_previously_reviewed_booking(calendar_connection, change):
    held, _, google, _, _ = calendar_connection
    result = await propose()
    assert result["status"] == "confirmation_required", result
    replacement = (
        replace(held, credential_id="new-login")
        if change == "reconnect"
        else replace(held, granted_scopes=READ)
    )
    credentials.set_active_connector_credentials(
        {} if change == "disconnect" else {"calendar": replacement}
    )
    with pytest.raises(GoogleConnectionError):
        await google_calendar_service.get_google_calendar_service().execute(
            user_id=h.OWNER_UID, proposal_id=result["proposal_id"]
        )
    assert not google.calls("POST", EVENTS)


async def test_other_owner_cannot_use_connected_calendar(calendar_connection):
    _, _, google, _, refreshes = calendar_connection
    result = await propose(h.tool_context(owner="another-owner"))
    assert result["status"] == "runtime_unavailable"
    assert not refreshes and not google.requests
