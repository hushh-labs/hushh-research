from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from hushh_mcp.services import one_location_nearby_presence_service as nearby_presence
from hushh_mcp.services.one_location_event_admission_service import (
    EventAdmissionContext,
)
from hushh_mcp.services.one_location_nearby_presence_service import (
    NEARBY_PRESENCE_CONSENT_VERSION,
    NEARBY_PRESENCE_RADIUS_METERS,
    NearbyPresenceError,
    OneLocationNearbyPresenceService,
    PostgresNearbyPresenceStore,
    _candidate_cell_tokens,
    _cell_epoch,
    _cell_token,
    _derived_key,
    _encrypt_anchor,
    _roster_seed,
    _tile_xy,
)

NOW = datetime(2026, 7, 30, 10, 0, tzinfo=timezone.utc)
TARGET_ALIAS = "6f80b5ee-85b8-4678-a663-9f84ae985ed5"


def _anchor_row(
    *,
    user_id: str,
    alias: str,
    place_id: str,
    label: str,
    lat: float,
    lng: float,
    version: int = 1,
    allows_requests: bool = True,
    relationship: str = "none",
    display_name: str = "Mira",
) -> dict:
    envelope = _encrypt_anchor(
        {
            "placeId": place_id,
            "label": label,
            "latitude": lat,
            "longitude": lng,
        },
        owner_user_id=user_id,
    )
    return {
        "owner_user_id": user_id,
        "participant_alias": alias,
        "status": "active",
        "audience": "all_opted_in",
        "allow_connection_requests": allows_requests,
        "consent_version": NEARBY_PRESENCE_CONSENT_VERSION,
        "radius_meters": NEARBY_PRESENCE_RADIUS_METERS,
        "checked_in_at": NOW,
        "expires_at": NOW + timedelta(hours=1),
        "version": version,
        "display_name": display_name,
        "relationship": relationship,
        **{f"anchor_{key}": value for key, value in envelope.items() if key != "key_id"},
        "anchor_key_id": envelope["key_id"],
    }


class FakeStore:
    def __init__(self) -> None:
        self.profile = {"user_id": "viewer", "phone_verified": True}
        self.presence: dict | None = None
        self.candidates: list[dict] = []
        self.connection_rows: list[dict] = []
        self.upsert_args: dict | None = None
        self.checkout_calls = 0
        self.candidate_args: dict | None = None
        self.safety_actions: list[dict] = []

    def get_verified_profile(self, user_id):
        return self.profile

    def upsert_presence(self, **kwargs):
        self.upsert_args = kwargs
        envelope = kwargs["anchor_envelope"]
        self.presence = {
            "owner_user_id": kwargs["user_id"],
            "participant_alias": "viewer-alias",
            "status": "active",
            "audience": "all_opted_in",
            "allow_connection_requests": kwargs["allow_connection_requests"],
            "consent_version": kwargs["consent_version"],
            "radius_meters": kwargs["radius_meters"],
            "anchor_ciphertext": envelope["ciphertext"],
            "anchor_iv": envelope["iv"],
            "anchor_tag": envelope["tag"],
            "anchor_algorithm": envelope["algorithm"],
            "anchor_key_id": envelope["key_id"],
            "anchor_cell_epoch": kwargs["anchor_cell_epoch"],
            "anchor_cell_token": kwargs["anchor_cell_token"],
            "checked_in_at": NOW,
            "expires_at": NOW + timedelta(minutes=kwargs["duration_minutes"]),
            "version": 1,
        }
        return self.presence

    def get_active_presence(self, user_id):
        return self.presence

    def read_active_candidates(self, **kwargs):
        self.candidate_args = kwargs
        return self.candidates

    def read_connection_pair(self, **kwargs):
        return self.connection_rows

    def checkout(self, user_id):
        self.checkout_calls += 1
        self.presence = None
        return True

    def apply_safety_action(self, **kwargs):
        self.safety_actions.append(kwargs)
        return True

    def purge_terminal(self, **kwargs):
        return {"expired": 1, "deleted": 2}


class FakeConnections:
    def __init__(self) -> None:
        self.calls = []
        self.result = {"relationship": "pending_outgoing"}

    def create_request_from_nearby_alias(self, requester_user_id, **kwargs):
        self.calls.append((requester_user_id, kwargs))
        return self.result


def _service(store, connections=None):
    connection_service = connections or FakeConnections()
    return (
        OneLocationNearbyPresenceService(
            store=store,
            connections_factory=lambda: connection_service,
            now=lambda: NOW,
        ),
        connection_service,
    )


def _check_in(service, **overrides):
    values = {
        "user_id": "viewer",
        "place_id": "public-place-a",
        "place_label": "Spot A",
        "current_lat": 37.4275,
        "current_lng": -122.1697,
        "place_lat": 37.4276,
        "place_lng": -122.1698,
        "accuracy_m": 12,
        "captured_at": NOW,
        "duration_minutes": 60,
        "consent_accepted": True,
        "allow_connection_requests": False,
    }
    values.update(overrides)
    return service.check_in(**values)


def test_check_in_encrypts_selected_place_and_never_persists_raw_gps():
    store = FakeStore()
    service, _ = _service(store)

    state = _check_in(service)

    assert state["presence"]["placeLabel"] == "Spot A"
    assert state["presence"]["radiusMeters"] == 500
    assert store.upsert_args["consent_version"] == NEARBY_PRESENCE_CONSENT_VERSION
    serialized = str(store.upsert_args)
    assert "37.4275" not in serialized
    assert "-122.1697" not in serialized
    assert "public-place-a" not in serialized
    assert "Spot A" not in serialized
    assert "current_lat" not in store.upsert_args
    assert "current_lng" not in store.upsert_args


def test_event_check_in_locks_to_admitted_venue_and_event_expiry():
    store = FakeStore()
    service, _ = _service(store)
    event = EventAdmissionContext(
        admission_claim_id="7debb48d-4a5b-49dc-80c1-0ace848f42d8",
        event_id="ec01fe7f-780e-4bec-a62a-6a613fa02376",
        display_name="Hussh Event",
        venue_place_id="organizer-venue",
        venue_label="Demo Hall",
        venue_latitude=37.4276,
        venue_longitude=-122.1698,
        radius_meters=500,
        starts_at=NOW - timedelta(minutes=5),
        ends_at=NOW + timedelta(minutes=45),
    )

    _check_in(
        service,
        place_id="client-place-is-ignored",
        place_label="Client label is ignored",
        place_lat=0,
        place_lng=0,
        event_context=event,
    )

    assert store.upsert_args["admission_mode"] == "event_pilot"
    assert store.upsert_args["event_id"] == event.event_id
    assert store.upsert_args["admission_claim_id"] == event.admission_claim_id
    serialized = str(store.upsert_args)
    assert "client-place-is-ignored" not in serialized
    assert "Client label is ignored" not in serialized


def test_keys_are_vault_rooted_and_purpose_separated(monkeypatch):
    monkeypatch.setattr(nearby_presence, "VAULT_DATA_KEY", "11" * 32)
    first_anchor_key = _derived_key(nearby_presence._ANCHOR_KEY_INFO)
    first_spatial_key = _derived_key(nearby_presence._SPATIAL_CELL_KEY_INFO)
    first_roster_key = _derived_key(nearby_presence._ROSTER_RANKING_KEY_INFO)

    assert len({first_anchor_key, first_spatial_key, first_roster_key}) == 3
    first_cell_token = _cell_token(epoch=1, x=2, y=3)
    first_roster_seed = _roster_seed(NOW)

    monkeypatch.setattr(nearby_presence, "VAULT_DATA_KEY", "22" * 32)

    assert _derived_key(nearby_presence._ANCHOR_KEY_INFO) != first_anchor_key
    assert _cell_token(epoch=1, x=2, y=3) != first_cell_token
    assert _roster_seed(NOW) != first_roster_seed


def test_different_selected_places_inside_radius_are_mutually_discoverable():
    store = FakeStore()
    store.presence = _anchor_row(
        user_id="viewer",
        alias="viewer-alias",
        place_id="spot-a",
        label="Spot A",
        lat=37.4275,
        lng=-122.1697,
    )
    store.candidates = [
        _anchor_row(
            user_id="target",
            alias=TARGET_ALIAS,
            place_id="spot-b",
            label="Spot B",
            lat=37.4285,
            lng=-122.1697,
        )
    ]
    service, _ = _service(store)

    state = service.get_state(user_id="viewer")

    assert state["attendees"] == [
        {
            "participantAlias": TARGET_ALIAS,
            "displayName": "Mira",
            "relationship": "none",
            "canConnect": True,
        }
    ]
    assert "placeId" not in str(state["attendees"])
    assert "latitude" not in str(state["attendees"])
    assert store.candidate_args["viewer_version"] == 1


@pytest.mark.parametrize(
    ("display_name", "expected_display_name"),
    [
        ("Mira Patel", "Mira Patel"),
        ("mira@example.com", "One attendee"),
        ("target", "One attendee"),
        ("+1 (650) 555-0123", "One attendee"),
        ("0xT9sNApYHwJpvA1B2C3D4E5F6G7", "One attendee"),
        (TARGET_ALIAS, "One attendee"),
        ("Mira\nPatel", "One attendee"),
    ],
)
def test_nearby_roster_never_serializes_identity_shaped_display_names(
    display_name,
    expected_display_name,
):
    store = FakeStore()
    store.presence = _anchor_row(
        user_id="viewer",
        alias="viewer-alias",
        place_id="spot-a",
        label="Spot A",
        lat=37.4275,
        lng=-122.1697,
    )
    store.candidates = [
        _anchor_row(
            user_id="target",
            alias=TARGET_ALIAS,
            place_id="spot-b",
            label="Spot B",
            lat=37.4285,
            lng=-122.1697,
            display_name=display_name,
        )
    ]
    service, _ = _service(store)

    attendee = service.get_state(user_id="viewer")["attendees"][0]

    assert attendee["displayName"] == expected_display_name


def test_candidate_cell_is_only_broad_phase_and_exact_radius_filters_target():
    store = FakeStore()
    store.presence = _anchor_row(
        user_id="viewer",
        alias="viewer-alias",
        place_id="spot-a",
        label="Spot A",
        lat=37.4275,
        lng=-122.1697,
    )
    store.candidates = [
        _anchor_row(
            user_id="target",
            alias=TARGET_ALIAS,
            place_id="far-spot",
            label="Far Spot",
            lat=37.4375,
            lng=-122.1697,
        )
    ]
    service, _ = _service(store)

    assert service.get_state(user_id="viewer")["attendees"] == []


@pytest.mark.parametrize(
    ("overrides", "expected_code"),
    [
        ({"consent_accepted": False}, "NEARBY_PRESENCE_CONSENT_REQUIRED"),
        ({"duration_minutes": 15}, "NEARBY_PRESENCE_DURATION_INVALID"),
        ({"accuracy_m": None}, "NEARBY_PRESENCE_LOCATION_TOO_COARSE"),
        ({"accuracy_m": 101}, "NEARBY_PRESENCE_LOCATION_TOO_COARSE"),
        (
            {"captured_at": NOW - timedelta(minutes=6)},
            "NEARBY_PRESENCE_LOCATION_STALE",
        ),
        (
            {"place_lat": 37.4375},
            "NEARBY_PRESENCE_OUTSIDE_RADIUS",
        ),
    ],
)
def test_check_in_rejects_unsafe_or_invalid_inputs(overrides, expected_code):
    store = FakeStore()
    service, _ = _service(store)

    with pytest.raises(NearbyPresenceError) as exc:
        _check_in(service, **overrides)

    assert exc.value.code == expected_code
    assert store.upsert_args is None


def test_phone_verification_is_eligibility_not_consent():
    store = FakeStore()
    store.profile = {"user_id": "viewer", "phone_verified": False}
    service, _ = _service(store)

    with pytest.raises(NearbyPresenceError) as exc:
        _check_in(service, consent_accepted=True)

    assert exc.value.code == "NEARBY_PRESENCE_PHONE_VERIFICATION_REQUIRED"


def test_alias_connection_rechecks_exact_radius_and_binds_presence_versions():
    store = FakeStore()
    viewer = _anchor_row(
        user_id="viewer",
        alias="viewer-alias",
        place_id="spot-a",
        label="Spot A",
        lat=37.4275,
        lng=-122.1697,
        version=7,
    )
    target = _anchor_row(
        user_id="target",
        alias=TARGET_ALIAS,
        place_id="spot-b",
        label="Spot B",
        lat=37.4285,
        lng=-122.1697,
        version=9,
    )
    store.connection_rows = [viewer, target]
    connections = FakeConnections()
    service, _ = _service(store, connections)

    assert service.request_connection(
        user_id="viewer",
        participant_alias=TARGET_ALIAS,
    ) == {"relationship": "pending_outgoing"}
    assert connections.calls == [
        (
            "viewer",
            {
                "participant_alias": TARGET_ALIAS,
                "requester_presence_version": 7,
                "target_presence_version": 9,
            },
        )
    ]


def test_alias_connection_returns_uniform_unavailable_for_invalid_or_far_alias():
    store = FakeStore()
    service, connections = _service(store)

    with pytest.raises(NearbyPresenceError) as invalid:
        service.request_connection(user_id="viewer", participant_alias="guessable")
    assert invalid.value.code == "NEARBY_ATTENDEE_UNAVAILABLE"
    assert invalid.value.status_code == 404

    store.connection_rows = [
        _anchor_row(
            user_id="viewer",
            alias="viewer-alias",
            place_id="spot-a",
            label="Spot A",
            lat=37.4275,
            lng=-122.1697,
        ),
        _anchor_row(
            user_id="target",
            alias=TARGET_ALIAS,
            place_id="far",
            label="Far",
            lat=37.4375,
            lng=-122.1697,
        ),
    ]
    with pytest.raises(NearbyPresenceError) as far:
        service.request_connection(user_id="viewer", participant_alias=TARGET_ALIAS)
    assert far.value.code == "NEARBY_ATTENDEE_UNAVAILABLE"
    assert connections.calls == []


def test_corrupt_anchor_fails_closed_and_clears_presence():
    store = FakeStore()
    store.presence = _anchor_row(
        user_id="viewer",
        alias="viewer-alias",
        place_id="spot-a",
        label="Spot A",
        lat=37.4275,
        lng=-122.1697,
    )
    store.presence["anchor_tag"] = "corrupt"
    service, _ = _service(store)

    with pytest.raises(NearbyPresenceError) as exc:
        service.get_state(user_id="viewer")

    assert exc.value.code == "NEARBY_PRESENCE_UNAVAILABLE"
    assert store.checkout_calls == 1


def test_cross_owner_anchor_transplant_fails_closed_and_clears_presence():
    store = FakeStore()
    store.presence = _anchor_row(
        user_id="different-owner",
        alias="viewer-alias",
        place_id="spot-a",
        label="Spot A",
        lat=37.4275,
        lng=-122.1697,
    )
    store.presence["owner_user_id"] = "viewer"
    service, _ = _service(store)

    with pytest.raises(NearbyPresenceError) as exc:
        service.get_state(user_id="viewer")

    assert exc.value.code == "NEARBY_PRESENCE_UNAVAILABLE"
    assert store.checkout_calls == 1


def test_checkout_is_idempotent_and_purge_contract_is_bounded():
    store = FakeStore()
    service, _ = _service(store)

    assert service.checkout(user_id="viewer")["checkedOut"] is True
    assert service.checkout(user_id="viewer")["checkedOut"] is True
    assert store.checkout_calls == 2
    assert service.purge_terminal(older_than_hours=12) == {
        "expired": 1,
        "deleted": 2,
    }


def test_block_and_report_use_alias_only_and_refresh_the_filtered_roster():
    store = FakeStore()
    store.presence = _anchor_row(
        user_id="viewer",
        alias="viewer-alias",
        place_id="spot-a",
        label="Spot A",
        lat=37.4275,
        lng=-122.1697,
    )
    service, _ = _service(store)

    blocked = service.block(user_id="viewer", participant_alias=TARGET_ALIAS)
    reported = service.report(
        user_id="viewer",
        participant_alias=TARGET_ALIAS,
        reason_code="unsafe_behavior",
    )

    assert blocked["attendees"] == []
    assert reported["attendees"] == []
    assert store.safety_actions == [
        {
            "viewer_user_id": "viewer",
            "participant_alias": TARGET_ALIAS,
            "reason_code": None,
        },
        {
            "viewer_user_id": "viewer",
            "participant_alias": TARGET_ALIAS,
            "reason_code": "unsafe_behavior",
        },
    ]


def test_cell_cover_handles_epoch_and_antimeridian_boundaries():
    lat = 0.0
    viewer_lng = 179.999
    target_lng = -179.999
    target_x, target_y = _tile_xy(lat=lat, lng=target_lng)
    epoch = _cell_epoch(NOW)
    epochs, tokens = _candidate_cell_tokens(
        lat=lat,
        lng=viewer_lng,
        radius_meters=500,
        now=NOW,
    )

    assert epoch in epochs
    assert _cell_token(epoch=epoch, x=target_x, y=target_y) in tokens


def test_postgres_candidates_bind_viewer_version_and_bounded_stable_ranking(
    monkeypatch,
):
    store = PostgresNearbyPresenceStore()
    captured = {}

    monkeypatch.setattr(store, "_expire_due", lambda: 0)

    def execute(sql, params=None):
        captured["sql"] = sql
        captured["params"] = params
        return []

    monkeypatch.setattr(store, "_execute_many", execute)
    assert (
        store.read_active_candidates(
            viewer_user_id="viewer",
            viewer_version=4,
            cell_epochs=[1, 0],
            cell_tokens=["opaque"],
            roster_seed="stable",
            limit=999,
        )
        == []
    )

    normalized_sql = " ".join(captured["sql"].split()).lower()
    assert "p.version = :viewer_version" in normalized_sql
    assert "p.anchor_cell_token = any(:cell_tokens)" in normalized_sql
    assert "order by random()" not in normalized_sql
    assert "hmac(" in normalized_sql
    assert captured["params"]["limit"] == 240
