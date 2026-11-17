"""Owner HTTP -> real local Google ports -> bounded/redacted To-do metadata."""

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.routes.one import pod_session, pod_todo_sources, pod_turn
from hushh_mcp.services.pod_consent_client import ConsentVerdict
from hushh_mcp.services.pod_session_authority import LOCAL_TOKEN_PREFIX, SCOPE_PKM_READ
from tests import pod_connector_harness as h

CALENDAR = "/api/one/pod/calendar/events"
MAIL = "/api/one/pod/gmail/todos"
WINDOW = {"start_at": "2026-11-03T00:00:00Z", "end_at": "2026-11-10T00:00:00Z"}


@pytest.fixture
def owner_app(monkeypatch, tmp_path):
    log, tokens, google = h.install(
        monkeypatch,
        tmp_path,
        connectors={
            "gmail": h.credential("gmail", h.SCOPES["gmail"]),
            "calendar": h.credential("calendar", h.SCOPES["calendar"]),
        },
    )
    state = {"revoked": False, "held": True, "owner": h.OWNER_UID}
    claims = {"role": "app", "scopes": [SCOPE_PKM_READ]}

    async def verify(_token, **_kwargs):
        return ConsentVerdict(
            not state["revoked"], True, state["owner"], h.OWNER_HUSHH, SCOPE_PKM_READ
        )

    async def held():
        if not state["held"]:
            raise HTTPException(409, "fenced")

    authority = SimpleNamespace(
        require_held=held,
        local_token=lambda _c: LOCAL_TOKEN_PREFIX + "fixture",
        local_verifier=lambda _c: verify,
    )

    def verified(authorization, *, role, scope):
        assert role == "app" and scope == SCOPE_PKM_READ
        if authorization != "Bearer owner-fixture":
            raise HTTPException(401, "owner session required")
        return authority, claims

    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: True)
    monkeypatch.setattr(pod_session, "verified_session", verified)
    monkeypatch.setattr(
        "hushh_mcp.services.pod_session_authority.active_session_authority", lambda: authority
    )
    app = FastAPI()
    app.include_router(pod_todo_sources.router)
    try:
        with TestClient(app) as client:
            yield SimpleNamespace(
                client=client, google=google, tokens=tokens, state=state, claims=claims, log=log
            )
    finally:
        h.uninstall()


def request(app, path, **kwargs):
    method = "POST" if path == CALENDAR else "GET"
    return app.client.request(
        method, path, headers={"Authorization": "Bearer owner-fixture"}, **kwargs
    )


def calendar_event(identity="event-1"):
    return {
        "id": identity,
        "summary": "Planning meeting",
        "status": "confirmed",
        "start": {"dateTime": "2026-11-04T12:00:00+05:30"},
        "end": {"dateTime": "2026-11-04T12:30:00+05:30"},
        "description": "private meeting body",
        "location": "private address",
        "attendees": [{"email": "private@example.com"}],
        "hangoutLink": "https://meet.google.com/abc-defg-hij",
    }


def test_calendar_reads_multiple_pages_redacts_and_uses_only_owner_google(owner_app):
    def page(req):
        token = h.query(req).get("pageToken", [None])[0]
        return {
            "items": [calendar_event("event-2" if token else "event-1")],
            "timeZone": "Asia/Kolkata",
            **({} if token else {"nextPageToken": "page-two"}),
        }

    owner_app.google.on("GET", f"{h.CALENDAR}/calendars/primary/events", page)
    response = request(owner_app, CALENDAR, json=WINDOW)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    body = response.json()
    assert len(body["events"]) == 2 and body["truncated"] is False
    assert body["events"][0]["start"]["dateTime"].endswith("+05:30")
    assert body["events"][0]["conference_url"].startswith("https://meet.google.com/")
    assert len({row["id"] for row in body["events"]}) == 2
    assert all(len(row["id"]) == 64 for row in body["events"])
    for private in ["private meeting body", "private address", "private@example.com", "event-1"]:
        assert private not in response.text
    assert owner_app.tokens.asks == [("calendar", "read"), ("calendar", "read")]


def test_calendar_paging_is_bounded_and_reports_a_partial_collection(owner_app):
    count = 0

    def page(_req):
        nonlocal count
        count += 1
        return {"items": [calendar_event(str(count))], "nextPageToken": str(count)}

    owner_app.google.on("GET", f"{h.CALENDAR}/calendars/primary/events", page)
    response = request(owner_app, CALENDAR, json=WINDOW)
    assert response.status_code == 200, response.text
    assert response.json()["truncated"] is True
    assert count == 5


def test_mail_projects_metadata_to_stable_opaque_tasks_without_body_or_hub_reads(owner_app):
    h.route_inbox(owner_app.google, ("m1",))
    message = h.gmail_message("m1", subject="Meeting details", sender="Saru <saru@example.com>")
    message["internalDate"] = str(int(datetime.now(UTC).timestamp() * 1000))
    owner_app.google.on("GET", f"{h.GMAIL}/threads/t-m1", {"id": "t-m1", "messages": [message]})
    first = request(owner_app, MAIL)
    assert first.status_code == 200, first.text
    task = first.json()["items"][0]
    assert task["title"] == "Reply to Saru: Meeting details"
    assert len(task["key"]) == 64
    assert request(owner_app, MAIL).json()["items"][0]["key"] == task["key"]
    assert first.json()["scope"] == "recent_threads"
    assert first.headers["cache-control"] == "private, no-store"
    assert all(req.url.host == "gmail.googleapis.com" for req in owner_app.google.requests)
    assert not any(h.query(req).get("format") == ["full"] for req in owner_app.google.requests)
    for private in ["saru@example.com", "snippet", "m1", h.SUBJECT, "ya29."]:
        assert private not in first.text


@pytest.mark.parametrize("path", [CALENDAR, MAIL])
@pytest.mark.parametrize("kind", ["anonymous", "hub", "device", "status", "foreign", "fenced"])
def test_source_doors_refuse_unadmitted_callers_before_provider_reads(owner_app, path, kind):
    kwargs = {"json": WINDOW} if path == CALENDAR else {}
    if kind in {"anonymous", "hub"}:
        response = owner_app.client.request(
            "POST" if path == CALENDAR else "GET",
            path,
            headers={"X-Consent-Token": "hub-fixture"} if kind == "hub" else {},
            **kwargs,
        )
    else:
        if kind == "device":
            owner_app.claims["role"] = "device"
        elif kind == "status":
            owner_app.claims["scopes"] = ["pod.status"]
        elif kind == "foreign":
            owner_app.state["owner"] = "different-owner"
        else:
            owner_app.state["held"] = False
        response = request(owner_app, path, **kwargs)
    assert response.status_code in {401, 403, 409}
    assert owner_app.tokens.asks == []
    assert owner_app.google.requests == []


def test_owner_revocation_during_calendar_read_withholds_the_response(owner_app):
    def page(_req):
        owner_app.state["revoked"] = True
        return {"items": [calendar_event()]}

    owner_app.google.on("GET", f"{h.CALENDAR}/calendars/primary/events", page)
    response = request(owner_app, CALENDAR, json=WINDOW)
    assert response.status_code in {401, 403}
    assert "Planning meeting" not in response.text


def test_calendar_account_change_during_provider_read_withholds_old_events(owner_app):
    from hushh_mcp.services import pod_connector_credentials as store

    def page(_req):
        store.set_active_connector_credentials(
            {
                "calendar": h.credential(
                    "calendar",
                    h.SCOPES["calendar"],
                    credential_id="33333333-2222-4333-8444-555555555555",
                )
            }
        )
        return {"items": [calendar_event()]}

    owner_app.google.on("GET", f"{h.CALENDAR}/calendars/primary/events", page)
    response = request(owner_app, CALENDAR, json=WINDOW)
    assert response.status_code == 409
    assert "Planning meeting" not in response.text


@pytest.mark.parametrize("path", [CALENDAR, MAIL])
def test_existing_managed_hosting_restriction_stays_closed(owner_app, monkeypatch, path):
    monkeypatch.setattr("hushh_mcp.services.pod_owner_cloud.owner_cloud_agent", lambda: False)
    response = request(owner_app, path, **({"json": WINDOW} if path == CALENDAR else {}))
    assert response.status_code == 503
    assert owner_app.google.requests == []


def test_calendar_grant_recovery_is_not_an_owner_authentication_failure(owner_app):
    from hushh_mcp.services import pod_connector_credentials as store

    store.set_active_connector_credentials(
        {
            "calendar": h.credential(
                "calendar", h.SCOPES["calendar"], status=store.STATUS_NEEDS_REAUTH
            )
        }
    )
    response = request(owner_app, CALENDAR, json=WINDOW)
    assert response.status_code == 409
    assert response.json()["detail"]["reason_code"] == "calendar_reauthorization_required"
    assert owner_app.google.requests == []


def test_unavailable_mail_store_is_a_safe_retryable_failure(owner_app, monkeypatch):
    from hushh_mcp.services import pod_connector_credentials as store

    def unavailable(_connector):
        raise store.ConnectorCredentialsUnavailable("fixture unavailable")

    monkeypatch.setattr(store, "active_connector_credential", unavailable)
    response = request(owner_app, MAIL)
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "MAIL_READ_UNAVAILABLE"
    assert owner_app.google.requests == []


@pytest.mark.parametrize(
    "window",
    [
        {**WINDOW, "user_id": "foreign"},
        {**WINDOW, "start_at": "2026-11-03"},
        {**WINDOW, "end_at": "2027-01-01T00:00:00Z"},
        {**WINDOW, "end_at": WINDOW["start_at"]},
    ],
)
def test_calendar_rejects_owner_selection_and_unbounded_or_naive_windows(owner_app, window):
    response = request(owner_app, CALENDAR, json=window)
    assert response.status_code == 422
    assert owner_app.google.requests == []
