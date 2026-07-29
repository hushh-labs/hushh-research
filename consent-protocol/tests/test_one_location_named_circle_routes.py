from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from api.routes.one import location

CIRCLE_ID = "550e8400-e29b-41d4-a716-446655440000"
INVITE_ID = "550e8400-e29b-41d4-a716-446655440002"
MEMBER_ID = "member-user"


class FakeNamedCircleService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.circle = {
            "id": CIRCLE_ID,
            "name": "Meena Family",
            "kind": "family",
            "role": "owner",
            "memberCount": 1,
            "memberLimit": 20,
            "members": [
                {
                    "userId": "owner-user",
                    "displayName": "Owner",
                    "role": "owner",
                    "phoneVerified": True,
                    "secureLocationReady": True,
                }
            ],
        }
        self.member_invite = {
            "id": INVITE_ID,
            "circleId": CIRCLE_ID,
            "circleName": "Meena Family",
            "circleKind": "family",
            "inviterUserId": "owner-user",
            "inviterDisplayName": "Owner",
            "inviteeUserId": MEMBER_ID,
            "inviteeDisplayName": "Member",
            "status": "pending",
            "expiresAt": "2026-07-27T00:00:00+00:00",
            "createdAt": "2026-07-24T00:00:00+00:00",
            "respondedAt": None,
        }

    def _record(self, method: str, **kwargs):
        self.calls.append((method, kwargs))

    def list_circles(self, **kwargs):
        self._record("list", **kwargs)
        return [{key: value for key, value in self.circle.items() if key != "members"}]

    def get_circle(self, **kwargs):
        self._record("get", **kwargs)
        return self.circle

    def create_circle(self, **kwargs):
        self._record("create", **kwargs)
        return self.circle

    def update_circle(self, **kwargs):
        self._record("update", **kwargs)
        return {**self.circle, "name": kwargs.get("name") or self.circle["name"]}

    def create_invite_code(self, **kwargs):
        self._record("create_code", **kwargs)
        return {
            "id": "invite-id",
            "circleId": CIRCLE_ID,
            "code": "2345-6789-ABCD",
            "expiresAt": "2026-07-27T00:00:00+00:00",
        }

    def resolve_invite_code(self, **kwargs):
        self._record("resolve", **kwargs)
        return {
            "name": "Meena Family",
            "kind": "family",
            "ownerDisplayName": "Owner",
            "memberCount": 1,
            "expiresAt": "2026-07-27T00:00:00+00:00",
            "alreadyMember": False,
        }

    def join_circle(self, **kwargs):
        self._record("join", **kwargs)
        return {"circle": {**self.circle, "role": "member"}, "joined": True}

    def revoke_invite_code(self, **kwargs):
        self._record("revoke_code", **kwargs)

    def remove_member(self, **kwargs):
        self._record("remove", **kwargs)

    def leave_circle(self, **kwargs):
        self._record("leave", **kwargs)

    def delete_circle(self, **kwargs):
        self._record("delete", **kwargs)

    def list_eligible_direct_connections(self, **kwargs):
        self._record("eligible", **kwargs)
        return [
            {
                "connectionId": "connection-id",
                "userId": MEMBER_ID,
                "displayName": "Member",
                "photoUrl": None,
                "connectedAt": "2026-07-20T00:00:00+00:00",
            }
        ]

    def list_member_invites(self, **kwargs):
        self._record("list_member_invites", **kwargs)
        return [self.member_invite]

    def get_remaining_invite_capacity(self, **kwargs):
        self._record("remaining_capacity", **kwargs)
        return 18

    def create_member_invites(self, **kwargs):
        self._record("create_member_invites", **kwargs)
        return {"invites": [self.member_invite], "createdInviteIds": [INVITE_ID]}

    def accept_member_invite(self, **kwargs):
        self._record("accept_member_invite", **kwargs)
        return {
            "circle": {**self.circle, "role": "member"},
            "invite": {**self.member_invite, "status": "accepted"},
            "accepted": True,
            "joined": True,
        }

    def decline_member_invite(self, **kwargs):
        self._record("decline_member_invite", **kwargs)
        return {**self.member_invite, "status": "declined"}

    def cancel_member_invite(self, **kwargs):
        self._record("cancel_member_invite", **kwargs)
        return True


def _client(monkeypatch):
    service = FakeNamedCircleService()
    current_user = {"user_id": "owner-user"}
    app = FastAPI()
    app.include_router(location.router)
    app.dependency_overrides[location.require_vault_owner_token] = lambda: current_user
    monkeypatch.setattr(location, "_circle_service", lambda: service)
    return TestClient(app, raise_server_exceptions=False), service, current_user


def test_named_circle_create_list_detail_and_code_routes(monkeypatch) -> None:
    client, service, _current_user = _client(monkeypatch)

    created = client.post(
        "/api/one/location/circles",
        json={"name": "Meena Family", "kind": "family"},
    )
    listed = client.get("/api/one/location/circles")
    detail = client.get(f"/api/one/location/circles/{CIRCLE_ID}")
    invite = client.post(f"/api/one/location/circles/{CIRCLE_ID}/invite-code")
    rotated = client.post(f"/api/one/location/circles/{CIRCLE_ID}/invite-code?rotate=true")

    assert created.status_code == 200
    assert created.json()["circle"]["name"] == "Meena Family"
    assert listed.json()["circles"][0]["memberCount"] == 1
    assert detail.json()["circle"]["members"][0]["userId"] == "owner-user"
    assert invite.json()["inviteCode"]["code"] == "2345-6789-ABCD"
    assert detail.headers["cache-control"] == "private, no-store"
    assert invite.headers["cache-control"] == "private, no-store"
    assert rotated.headers["cache-control"] == "private, no-store"
    assert (
        "create_code",
        {
            "actor_user_id": "owner-user",
            "circle_id": CIRCLE_ID,
            "rotate": False,
        },
    ) in service.calls
    assert (
        "create_code",
        {
            "actor_user_id": "owner-user",
            "circle_id": CIRCLE_ID,
            "rotate": True,
        },
    ) in service.calls
    assert (
        "create",
        {
            "owner_user_id": "owner-user",
            "name": "Meena Family",
            "kind": "family",
        },
    ) in service.calls


def test_named_circle_code_join_is_immediate_but_returns_no_location_authority(
    monkeypatch,
) -> None:
    client, service, current_user = _client(monkeypatch)
    current_user["user_id"] = MEMBER_ID

    preview = client.post(
        "/api/one/location/circle-codes/resolve",
        json={"code": "2345-6789-ABCD"},
    )
    joined = client.post(
        "/api/one/location/circle-codes/join",
        json={"code": "2345-6789-ABCD"},
    )

    assert preview.status_code == 200
    assert preview.json()["preview"]["name"] == "Meena Family"
    assert joined.status_code == 200
    assert joined.json()["joined"] is True
    serialized = str(joined.json()).lower()
    for forbidden in (
        "grant",
        "ciphertext",
        "capability",
        "latitude",
        "longitude",
        "smscontact",
    ):
        assert forbidden not in serialized
    assert ("join", {"user_id": MEMBER_ID, "code": "2345-6789-ABCD"}) in service.calls


def test_named_circle_owner_and_member_management_routes(monkeypatch) -> None:
    client, service, current_user = _client(monkeypatch)

    renamed = client.patch(
        f"/api/one/location/circles/{CIRCLE_ID}",
        json={"name": "Family Home"},
    )
    removed = client.delete(f"/api/one/location/circles/{CIRCLE_ID}/members/{MEMBER_ID}")
    revoked = client.delete(f"/api/one/location/circles/{CIRCLE_ID}/invite-code")
    deleted = client.delete(f"/api/one/location/circles/{CIRCLE_ID}")

    assert renamed.status_code == 200
    assert removed.json() == {"removed": True}
    assert revoked.json() == {"revoked": True}
    assert deleted.json() == {"deleted": True}

    current_user["user_id"] = MEMBER_ID
    left = client.delete(f"/api/one/location/circles/{CIRCLE_ID}/members/me")
    assert left.json() == {"left": True}
    assert any(method == "remove" for method, _ in service.calls)
    assert any(method == "leave" for method, _ in service.calls)


def test_named_circle_targeted_member_invite_routes(monkeypatch) -> None:
    client, service, current_user = _client(monkeypatch)

    eligible = client.get(f"/api/one/location/circles/{CIRCLE_ID}/eligible-connections")
    created = client.post(
        "/api/one/location/circle-member-invites",
        json={
            "circleId": CIRCLE_ID,
            "inviteeUserIds": [MEMBER_ID, MEMBER_ID],
        },
    )
    outgoing = client.get(
        "/api/one/location/circle-member-invites?direction=outgoing&status=pending"
    )

    assert eligible.status_code == 200
    assert eligible.json()["eligibleConnections"][0]["userId"] == MEMBER_ID
    assert eligible.json()["pendingInvites"][0]["id"] == INVITE_ID
    assert eligible.json()["remainingCapacity"] == 18
    assert created.status_code == 200
    assert len(created.json()["invites"]) == 1
    assert outgoing.json()["invites"][0]["circleName"] == "Meena Family"
    assert (
        service.calls.count(
            (
                "create_member_invites",
                {
                    "actor_user_id": "owner-user",
                    "circle_id": CIRCLE_ID,
                    "invitee_user_ids": [MEMBER_ID],
                },
            )
        )
        == 1
    )

    current_user["user_id"] = MEMBER_ID
    accepted = client.post(f"/api/one/location/circle-member-invites/{INVITE_ID}/accept")
    declined = client.post(f"/api/one/location/circle-member-invites/{INVITE_ID}/decline")

    assert accepted.status_code == 200
    assert accepted.json()["invite"]["status"] == "accepted"
    assert set(accepted.json()) == {"circle", "invite"}
    assert declined.json()["invite"]["status"] == "declined"

    current_user["user_id"] = "owner-user"
    cancelled = client.delete(f"/api/one/location/circle-member-invites/{INVITE_ID}")
    assert cancelled.json() == {"cancelled": True}


def test_named_circle_route_bounds_reject_invalid_ids_and_codes(monkeypatch) -> None:
    client, _service, _current_user = _client(monkeypatch)

    assert client.get("/api/one/location/circles/too-short").status_code == 422
    assert (
        client.post(
            "/api/one/location/circle-codes/join",
            json={"code": "short"},
        ).status_code
        == 422
    )


def test_grant_source_circle_requires_a_real_uuid() -> None:
    with pytest.raises(ValidationError):
        location.CreateGrantRequest.model_validate(
            {
                "recipientUserId": "member-user",
                "sourceCircleId": "x" * 36,
                "durationHours": 1,
            }
        )
