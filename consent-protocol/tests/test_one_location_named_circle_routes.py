from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from api.routes.one import location
from hushh_mcp.services.one_location_circle_service import OneLocationCircleService

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

    def get_circle_overview(self, **kwargs):
        self._record("overview", **kwargs)
        return {key: value for key, value in self.circle.items() if key != "members"}

    def list_circle_members_page(self, **kwargs):
        self._record("members_page", **kwargs)
        return {
            "items": [
                {
                    "userId": "owner-user",
                    "displayName": "Owner",
                    "photoUrl": None,
                    "role": "owner",
                    "joinedAt": None,
                    "phoneVerified": True,
                    "secureLocationReady": False,
                    "keyId": None,
                    "publicKeyJwk": None,
                    "keyAlgorithm": "ECDH-P256-AES256-GCM",  # gitleaks:allow
                    "keyRegisteredAt": None,
                    "canReceiveLocation": False,
                    "relationship": "self",
                    "canConnect": False,
                    "connectedFromContacts": False,
                }
            ],
            "page": kwargs["page"],
            "hasMore": True,
            "totalCount": 5000,
        }

    def create_circle(self, **kwargs):
        self._record("create", **kwargs)
        return self.circle

    def update_circle(self, **kwargs):
        self._record("update", **kwargs)
        return {**self.circle, "name": kwargs.get("name") or self.circle["name"]}

    def bootstrap_first_circle(self, **kwargs):
        self._record("bootstrap", **kwargs)
        return {
            "circleId": CIRCLE_ID,
            "circleName": self.circle["name"],
            "code": "2345-6789-ABCD",
        }

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

    def list_eligible_direct_connections_page(self, **kwargs):
        self._record("eligible_page", **kwargs)
        return {
            "items": self.list_eligible_direct_connections(**kwargs),
            "page": kwargs["page"],
            "hasMore": True,
            "totalCount": 5000,
        }

    def ensure_trusted_system_circle(self, **kwargs):
        self._record("trusted", **kwargs)
        return {key: value for key, value in self.circle.items() if key != "members"}

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


def test_circle_overview_members_eligible_and_trusted_summary_are_bounded(monkeypatch) -> None:
    client, service, _current_user = _client(monkeypatch)

    overview = client.get(f"/api/one/location/circles/{CIRCLE_ID}/overview")
    members = client.get(
        f"/api/one/location/circles/{CIRCLE_ID}/members?page=2&limit=100&query=own"
    )
    eligible = client.get(
        f"/api/one/location/circles/{CIRCLE_ID}/eligible-connections?page=2&limit=100&query=mem"
    )
    trusted = client.post("/api/one/location/circles/trusted?summaryOnly=true")

    assert overview.status_code == 200
    assert "members" not in overview.json()["circle"]
    assert members.status_code == 200
    assert members.json()["totalCount"] == 5000
    assert members.json()["page"] == 2
    assert eligible.status_code == 200
    assert eligible.json()["totalCount"] == 5000
    assert eligible.json()["page"] == 2
    assert eligible.headers["cache-control"] == "private, no-store"
    assert trusted.status_code == 200
    assert "members" not in trusted.json()["circle"]
    assert (
        "members_page",
        {
            "user_id": "owner-user",
            "circle_id": CIRCLE_ID,
            "query": "own",
            "page": 2,
            "limit": 100,
        },
    ) in service.calls
    assert ("trusted", {"owner_user_id": "owner-user", "summary_only": True}) in service.calls


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


def _bootstrap_client(monkeypatch, *, authenticated: bool = True):
    """Bootstrap is the one Circle route authenticated by Firebase, not the vault.

    So it gets its own client: overriding require_vault_owner_token here would
    prove nothing, and leaving Firebase unoverridden is how the unauthenticated
    case is exercised.
    """

    service = FakeNamedCircleService()
    app = FastAPI()
    app.include_router(location.router)
    if authenticated:
        app.dependency_overrides[location.require_firebase_auth] = lambda: "owner-user"
    monkeypatch.setattr(location, "_circle_service", lambda: service)
    return TestClient(app, raise_server_exceptions=False), service


def test_circle_bootstrap_mints_a_code_for_a_caller_with_no_vault(monkeypatch) -> None:
    client, service = _bootstrap_client(monkeypatch)

    response = client.post(
        "/api/one/location/circles/bootstrap",
        json={"name": "Meena's Circle"},
    )

    assert response.status_code == 200
    assert response.json()["invite"] == {
        "circleId": CIRCLE_ID,
        "circleName": "Meena Family",
        "code": "2345-6789-ABCD",
    }
    # The Firebase uid is the owner: onboarding runs before any vault token
    # exists, so the uid is the only identity the route has to work from.
    assert service.calls == [
        ("bootstrap", {"user_id": "owner-user", "name": "Meena's Circle"}),
    ]
    assert response.headers["cache-control"] == "private, no-store"


def test_circle_bootstrap_rejects_an_unauthenticated_caller(monkeypatch) -> None:
    client, service = _bootstrap_client(monkeypatch, authenticated=False)

    response = client.post(
        "/api/one/location/circles/bootstrap",
        json={"name": "Meena's Circle"},
    )

    assert response.status_code == 401
    assert service.calls == []


def test_circle_bootstrap_cannot_be_pointed_at_another_circle(monkeypatch) -> None:
    client, service = _bootstrap_client(monkeypatch)

    response = client.post(
        "/api/one/location/circles/bootstrap",
        json={"name": "Meena's Circle", "circleId": CIRCLE_ID, "rotate": True},
    )

    assert response.status_code == 200
    # The request body carried a circle id and a rotate flag; neither reaches the
    # service, which is the whole point of the request model having no such field.
    assert service.calls == [
        ("bootstrap", {"user_id": "owner-user", "name": "Meena's Circle"}),
    ]


def test_circle_bootstrap_requires_a_usable_name(monkeypatch) -> None:
    client, _service = _bootstrap_client(monkeypatch)

    # A single character is a usable name; only nothing at all, or something
    # longer than the column, is refused.
    assert (
        client.post(
            "/api/one/location/circles/bootstrap",
            json={"name": ""},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/one/location/circles/bootstrap",
            json={"name": "x" * 81},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/one/location/circles/bootstrap",
            json={"name": "x"},
        ).status_code
        != 422
    )


def _bootstrap_probe(owned_circles: list[dict]):
    """Drive the real bootstrap_first_circle over stubbed primitives.

    Instantiating the service would need a database; bootstrap composes only
    list_circles / create_circle / create_invite_code, so stubbing those three
    exercises the find-or-create decision that is the method's whole substance.
    """

    service = object.__new__(OneLocationCircleService)
    calls: list[tuple[str, dict]] = []

    def _list(**kwargs):
        calls.append(("list", kwargs))
        return owned_circles

    def _create(**kwargs):
        calls.append(("create", kwargs))
        return {"id": CIRCLE_ID, "name": kwargs["name"], "role": "owner"}

    def _code(**kwargs):
        calls.append(("code", kwargs))
        return {"code": "2345-6789-ABCD"}

    service.list_circles = _list
    service.create_circle = _create
    service.create_invite_code = _code
    return service, calls


def test_bootstrap_creates_a_first_circle_when_the_caller_owns_none() -> None:
    service, calls = _bootstrap_probe([])

    invite = service.bootstrap_first_circle(user_id="owner-user", name="Meena's Circle")

    assert invite == {
        "circleId": CIRCLE_ID,
        "circleName": "Meena's Circle",
        "code": "2345-6789-ABCD",
    }
    assert [name for name, _ in calls] == ["list", "create", "code"]
    assert calls[2][1]["rotate"] is False


def test_bootstrap_reuses_an_owned_circle_and_never_rotates_its_code() -> None:
    service, calls = _bootstrap_probe([{"id": CIRCLE_ID, "name": "Meena Family", "role": "owner"}])

    invite = service.bootstrap_first_circle(user_id="owner-user", name="Ignored Name")

    # A second onboarding run must hand back the same Circle and the code the
    # owner may already have shared -- rotating it would break every invite
    # already in someone's messages.
    assert invite["circleId"] == CIRCLE_ID
    assert invite["circleName"] == "Meena Family"
    assert [name for name, _ in calls] == ["list", "code"]
    assert calls[1][1]["rotate"] is False


def test_bootstrap_ignores_circles_the_caller_only_joined() -> None:
    service, calls = _bootstrap_probe(
        [{"id": "joined-circle", "name": "Someone Else", "role": "member"}]
    )

    invite = service.bootstrap_first_circle(user_id="owner-user", name="Meena's Circle")

    # Membership of someone else's Circle is not a Circle of your own, and
    # minting a code there would hand out an invite the caller does not own.
    assert invite["circleId"] == CIRCLE_ID
    assert [name for name, _ in calls] == ["list", "create", "code"]
    assert calls[1][1] == {
        "owner_user_id": "owner-user",
        "name": "Meena's Circle",
        "kind": "family",
    }


def test_circle_code_preview_shows_the_circle_before_joining(monkeypatch) -> None:
    client, service = _bootstrap_client(monkeypatch)

    response = client.post(
        "/api/one/location/circle-codes/preview",
        json={"code": "2345-6789-ABCD"},
    )

    assert response.status_code == 200
    circle = response.json()["circle"]
    # Name, owner and member count are the whole point: someone deciding whether
    # to share their location needs to see who is asking.
    assert circle["name"] == "Meena Family"
    assert circle["ownerDisplayName"] == "Owner"
    assert circle["memberCount"] == 1
    assert circle["alreadyMember"] is False
    assert response.headers["cache-control"] == "private, no-store"
    assert service.calls == [
        ("resolve", {"user_id": "owner-user", "code": "2345-6789-ABCD"}),
    ]


def test_circle_code_preview_rejects_an_unauthenticated_caller(monkeypatch) -> None:
    client, service = _bootstrap_client(monkeypatch, authenticated=False)

    response = client.post(
        "/api/one/location/circle-codes/preview",
        json={"code": "2345-6789-ABCD"},
    )

    assert response.status_code == 401
    assert service.calls == []


def test_circle_code_preview_rejects_a_malformed_code(monkeypatch) -> None:
    client, _service = _bootstrap_client(monkeypatch)

    assert (
        client.post(
            "/api/one/location/circle-codes/preview",
            json={"code": "short"},
        ).status_code
        == 422
    )


def test_join_push_tells_the_sharer_their_code_was_used(monkeypatch) -> None:
    import hushh_mcp.services.push_notifications as push_module

    sent: list[dict] = []
    monkeypatch.setattr(
        push_module,
        "send_circle_code_joined_push",
        lambda **kwargs: sent.append(kwargs) or 1,
    )

    push_module.send_circle_code_joined_push(
        inviter_user_id="owner-user",
        joiner_display_name="Member",
        circle_id=CIRCLE_ID,
        circle_name="Meena Family",
    )

    assert sent == [
        {
            "inviter_user_id": "owner-user",
            "joiner_display_name": "Member",
            "circle_id": CIRCLE_ID,
            "circle_name": "Meena Family",
        }
    ]


def test_join_push_names_the_joiner_and_deep_links_to_people(monkeypatch) -> None:
    import hushh_mcp.services.push_notifications as push_module

    captured: dict = {}

    def _fake_send(user_id, **kwargs):
        captured["user_id"] = user_id
        captured.update(kwargs)
        return 1

    monkeypatch.setattr(push_module, "send_user_data_push", _fake_send)

    push_module.send_circle_code_joined_push(
        inviter_user_id="owner-user",
        joiner_display_name="Meena",
        circle_id=CIRCLE_ID,
        circle_name="Meena Family",
    )

    # Addressed to whoever shared the code -- they did the inviting, and they
    # are the one person for whom a redemption is news.
    assert captured["user_id"] == "owner-user"
    assert captured["notification_type"] == "location_circle_code_joined"
    # Named, because "someone joined" is exactly what the sender already knew.
    assert captured["body"] == "Meena joined using your code."
    assert captured["title"] == "Meena Family"
    assert captured["deep_link"] == f"/one/location?tab=people&circleId={CIRCLE_ID}"
    assert captured["notification_category"] == "ONE_LOCATION"
