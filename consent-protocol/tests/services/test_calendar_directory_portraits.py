"""Calendar event portraits reuse Connect eligibility without opening email search."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import Response

import hushh_mcp.services.calendar_directory_portraits as portraits
from api.routes.one import calendar_workspace
from api.routes.one.calendar_workspace_models import CalendarInvitationsWindow
from hushh_mcp.services.one_location_agent_service import OneLocationAgentService


class _DirectoryProbe(OneLocationAgentService):
    def __init__(self) -> None:
        self.sql = ""
        self.params: dict = {}

    def _execute_many(self, sql: str, params: dict | None = None) -> list[dict]:
        self.sql = sql
        self.params = params or {}
        return []

    def _directory_auth_profiles(self, user_ids: list[str]) -> dict[str, dict[str, str]]:
        return {}


def test_event_lookup_uses_only_exact_provider_attendees_and_organizer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict] = []

    class Directory:
        def search_directory_candidates(self, **kwargs: object) -> dict:
            calls.append(kwargs)
            return {
                "items": [
                    {
                        "email": "manish@example.test",
                        "userId": "manish",
                        "photoUrl": "data:image/png;base64,aGVsbG8=",
                    },
                    {
                        "email": "stranger@example.test",
                        "userId": "stranger",
                        "photoUrl": "data:image/png;base64,aGVsbG8=",
                    },
                    {"email": "priya@example.test", "userId": "priya", "photoUrl": ""},
                ],
                "hasMore": False,
            }

    monkeypatch.setattr(portraits, "OneLocationAgentService", Directory)
    monkeypatch.setattr(
        portraits,
        "verified_directory_emails",
        lambda _ids: {
            "manish": "manish@example.test",
            "stranger": "stranger@example.test",
            "priya": "priya@example.test",
        },
    )
    result = asyncio.run(
        portraits.calendar_directory_portraits(
            owner_user_id="owner",
            events=[
                {
                    "organizer": {"email": "PRIYA@example.test"},
                    "attendees": [
                        {"email": "Manish@Example.Test", "display_name": "Manish"},
                        {"email": "manish@example.test"},
                        {"email": "not-an-address"},
                    ],
                }
            ],
        )
    )
    assert calls == [
        {
            "owner_user_id": "owner",
            "verified_email_lookup": ["manish@example.test", "priya@example.test"],
            "limit": portraits.MAX_PORTRAIT_EMAILS,
        }
    ]
    assert result == {
        "manish@example.test": {"userId": "manish", "photoUrl": "data:image/png;base64,aGVsbG8="}
    }


def test_ambiguous_or_partial_directory_lookup_keeps_initials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rows = [
        {"email": "manish@example.test", "userId": "one", "photoUrl": "photo-one"},
        {"email": "MANISH@example.test", "userId": "two", "photoUrl": "photo-two"},
    ]

    class Directory:
        def search_directory_candidates(self, **_kwargs: object) -> dict:
            return {"items": rows, "hasMore": False}

    monkeypatch.setattr(portraits, "OneLocationAgentService", Directory)
    current = {"one": "manish@example.test", "two": "manish@example.test"}
    monkeypatch.setattr(portraits, "verified_directory_emails", lambda _ids: current)
    assert portraits._visible_portraits("owner", ["manish@example.test"]) == {}
    rows.pop()
    assert portraits._visible_portraits("owner", ["manish@example.test"]) == {
        "manish@example.test": {"userId": "one", "photoUrl": "photo-one"}
    }
    current["one"] = "changed@example.test"
    assert portraits._visible_portraits("owner", ["manish@example.test"]) == {}

    class PartialDirectory:
        def search_directory_candidates(self, **_kwargs: object) -> dict:
            return {"items": rows, "hasMore": True}

    monkeypatch.setattr(portraits, "OneLocationAgentService", PartialDirectory)
    assert portraits._visible_portraits("owner", ["manish@example.test"]) == {}


def test_lookup_failure_does_not_fail_calendar_read(monkeypatch: pytest.MonkeyPatch) -> None:
    class UnavailableDirectory:
        def search_directory_candidates(self, **_kwargs: object) -> dict:
            raise RuntimeError("directory unavailable")

    monkeypatch.setattr(portraits, "OneLocationAgentService", UnavailableDirectory)
    assert (
        asyncio.run(
            portraits.calendar_directory_portraits(
                owner_user_id="owner",
                events=[{"attendees": [{"email": "manish@example.test"}]}],
            )
        )
        == {}
    )


def test_current_firebase_email_failure_keeps_initials(monkeypatch: pytest.MonkeyPatch) -> None:
    class Directory:
        def search_directory_candidates(self, **_kwargs: object) -> dict:
            return {
                "items": [
                    {"email": "manish@example.test", "userId": "manish", "photoUrl": "photo"}
                ],
                "hasMore": False,
            }

    monkeypatch.setattr(portraits, "OneLocationAgentService", Directory)
    monkeypatch.setattr(
        portraits,
        "verified_directory_emails",
        lambda _ids: (_ for _ in ()).throw(RuntimeError("auth unavailable")),
    )
    assert (
        asyncio.run(
            portraits.calendar_directory_portraits(
                owner_user_id="owner",
                events=[{"attendees": [{"email": "manish@example.test"}]}],
            )
        )
        == {}
    )


def test_event_lookup_is_bounded_and_never_searches_arbitrary_payloads() -> None:
    events = [{"attendees": [{"email": f"person{index}@example.test"} for index in range(120)]}]
    assert len(portraits._event_emails(events)) == portraits.MAX_PORTRAIT_EMAILS
    assert portraits._event_emails({"attendees": [{"email": "manish@example.test"}]}) == []
    assert portraits._event_emails([{"attendees": "manish@example.test"}]) == []


def test_invitations_route_adds_photos_to_the_owner_bound_event_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    event = {
        "organizer": {"email": "priya@example.test"},
        "attendees": [{"email": "manish@example.test"}],
    }

    class Schedule:
        async def invitations(self, **kwargs: object) -> dict:
            assert kwargs == {"user_id": "owner", "time_zone": "UTC"}
            return {"events": [event], "pending_count": 1}

    async def photo_lookup(**kwargs: object) -> dict:
        assert kwargs == {"owner_user_id": "owner", "events": [event]}
        return {"manish@example.test": {"userId": "manish", "photoUrl": "photo"}}

    monkeypatch.setattr(calendar_workspace, "_selected_schedule", lambda _account_id: Schedule())
    monkeypatch.setattr(portraits, "calendar_directory_portraits", photo_lookup)
    response = Response()
    result = asyncio.run(
        calendar_workspace.invitations(CalendarInvitationsWindow(), response, firebase_uid="owner")
    )
    assert result["events"] == [event]
    assert result["people"] == {"manish@example.test": {"userId": "manish", "photoUrl": "photo"}}
    assert response.headers["Cache-Control"] == "private, no-store"


def test_calendar_directory_email_rechecks_current_firebase_claim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hushh_mcp.services import directory_identity_service as directory

    monkeypatch.setattr(
        directory,
        "get_firebase_auth_app",
        lambda: SimpleNamespace(project_id="synthetic", name="auth"),
    )
    calls: list[list[str]] = []

    def get_users(identifiers, **_kwargs):
        calls.append([identifier.uid for identifier in identifiers])
        return SimpleNamespace(
            users=[
                SimpleNamespace(
                    uid="manish", disabled=False, email="new@example.test", email_verified=True
                ),
                SimpleNamespace(
                    uid="unverified",
                    disabled=False,
                    email="unverified@example.test",
                    email_verified=False,
                ),
                SimpleNamespace(
                    uid="disabled",
                    disabled=True,
                    email="disabled@example.test",
                    email_verified=True,
                ),
            ]
        )

    monkeypatch.setattr(directory.auth, "get_users", get_users)
    assert directory.verified_directory_emails(["manish", "unverified", "disabled"]) == {
        "manish": "new@example.test"
    }
    assert calls == [["manish", "unverified", "disabled"]]


def test_calendar_directory_lookup_requires_unique_verified_listed_email() -> None:
    service = _DirectoryProbe()
    result = service.search_directory_candidates(
        owner_user_id="owner",
        verified_email_lookup=["MANISH@example.test", "manish@example.test"],
    )

    assert result == {"items": [], "page": 1, "hasMore": False}
    assert service.params["verified_emails"] == ["manish@example.test"]
    assert "a.contact_listed = TRUE" in service.sql
    assert "a.email_verified = TRUE" in service.sql
    assert "LOWER(BTRIM(a.email)) = ANY(CAST(:verified_emails AS TEXT[]))" in service.sql
    assert "duplicate.email_verified = TRUE" in service.sql
    assert "duplicate.user_id <> a.user_id" in service.sql

    public_search = _DirectoryProbe()
    public_search.search_directory_candidates(owner_user_id="owner", query="manish")
    assert "verified_emails" not in public_search.params
    assert "a.email_verified = TRUE" not in public_search.sql


def test_calendar_directory_lookup_rejects_broad_search() -> None:
    service = _DirectoryProbe()
    with pytest.raises(ValueError):
        service.search_directory_candidates(
            owner_user_id="owner", query="manish", verified_email_lookup=["manish@example.test"]
        )
    with pytest.raises(ValueError):
        service.search_directory_candidates(
            owner_user_id="owner",
            verified_email_lookup=[f"person{i}@example.test" for i in range(101)],
        )
