from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from hushh_mcp.services import one_location_nearby_presence_service as nearby_presence
from hushh_mcp.services.one_location_nearby_presence_service import (
    NEARBY_PRESENCE_CONSENT_VERSION,
    NEARBY_PRESENCE_RADIUS_METERS,
    NearbyPresenceError,
    OneLocationNearbyPresenceService,
    PostgresNearbyPresenceStore,
    _candidate_cell_tokens,
    _cell_epoch,
    _cell_token,
    _decrypt_anchor,
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
            "schemaVersion": 3,
            "coordinateKind": "selected_place_point_v1",
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
        self.last_presence: dict | None = None
        self.candidates: list[dict] = []
        self.connection_rows: list[dict] = []
        self.upsert_args: dict | None = None
        self.checkout_calls = 0
        self.candidate_args: dict | None = None

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

    def get_last_presence(self, user_id):
        # The continuity guard must see a checked-out or expired check-in too,
        # which is exactly what `get_active_presence` filters away.
        return self.last_presence if self.last_presence is not None else self.presence

    def read_active_candidates(self, **kwargs):
        self.candidate_args = kwargs
        return self.candidates

    def read_connection_pair(self, **kwargs):
        return self.connection_rows

    def checkout(self, user_id):
        self.checkout_calls += 1
        self.presence = None
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


def _previous_check_in(*, lat: float, lng: float, minutes_ago: float, status="checked_out"):
    """A prior check-in row for this owner, as the store would return it."""

    row = _anchor_row(
        user_id="viewer",
        alias="viewer-alias",
        place_id="previous-place",
        label="Previous place",
        lat=lat,
        lng=lng,
    )
    row["status"] = status
    row["checked_in_at"] = NOW - timedelta(minutes=minutes_ago)
    return row


def test_check_in_rejects_a_place_the_owner_could_not_have_reached():
    """The point is client-supplied, so continuity is what can be checked.

    Nothing else here stops an account claiming a venue anywhere on earth: the
    coordinates come from the browser and cannot be attested. Consecutive
    claims, though, must be consistent with each other -- someone checked in
    near Stanford four minutes ago is not in London now.
    """

    store = FakeStore()
    # ~8,600 km away, four minutes earlier: roughly 129,000 km/h.
    store.last_presence = _previous_check_in(lat=51.5074, lng=-0.1278, minutes_ago=4)
    service, _ = _service(store)

    with pytest.raises(NearbyPresenceError) as exc:
        _check_in(service)

    assert exc.value.code == "NEARBY_PRESENCE_IMPLAUSIBLE_TRAVEL"
    assert exc.value.status_code == 422
    assert store.upsert_args is None, "an implausible check-in must not be persisted"


def test_check_in_allows_a_place_reachable_at_human_speed():
    store = FakeStore()
    # Same ~8,600 km, but a day later: well under the ceiling.
    store.last_presence = _previous_check_in(lat=51.5074, lng=-0.1278, minutes_ago=24 * 60)
    service, _ = _service(store)

    state = _check_in(service)

    assert state["presence"]["placeLabel"] == "Spot A"


def test_check_in_allows_returning_to_the_same_venue_immediately():
    """Re-checking in where you already are is the most ordinary case there is."""

    store = FakeStore()
    store.last_presence = _previous_check_in(lat=37.4276, lng=-122.1698, minutes_ago=0.0)
    service, _ = _service(store)

    state = _check_in(service)

    assert state["presence"]["placeLabel"] == "Spot A"


def test_continuity_guard_fails_open_when_the_previous_anchor_is_unreadable():
    """A decryption problem of ours must not lock an honest owner out.

    The attack this guard closes needs a *readable* previous anchor to be
    detected at all, so failing open costs nothing an attacker could use.
    """

    store = FakeStore()
    row = _previous_check_in(lat=51.5074, lng=-0.1278, minutes_ago=4)
    row["anchor_ciphertext"] = "not-decryptable"
    store.last_presence = row
    service, _ = _service(store)

    state = _check_in(service)

    assert state["presence"]["placeLabel"] == "Spot A"


def test_continuity_guard_fails_open_when_the_store_cannot_be_read():
    store = FakeStore()

    def _boom(user_id):
        raise RuntimeError("store unavailable")

    store.get_last_presence = _boom  # type: ignore[method-assign]
    service, _ = _service(store)

    state = _check_in(service)

    assert state["presence"]["placeLabel"] == "Spot A"


def test_check_in_encrypts_selected_place_and_never_stores_the_captured_point():
    store = FakeStore()
    service, _ = _service(store)

    state = _check_in(service)
    encrypted_point = _decrypt_anchor(store.presence)

    assert state["presence"]["placeLabel"] == "Spot A"
    assert state["presence"]["radiusMeters"] == 500
    assert store.upsert_args["consent_version"] == NEARBY_PRESENCE_CONSENT_VERSION
    # v3 anchors the *selected place*, so the owner's real position is not
    # persisted anywhere -- not even inside the encrypted envelope.
    # Exact equality, not approx: the coordinates are passed through unchanged,
    # and approx's default relative tolerance is wide enough here to also match
    # the captured point -- which would defeat the point of this assertion.
    assert encrypted_point == {
        "coordinateKind": "selected_place_point_v1",
        "label": "Spot A",
        "latitude": 37.4276,
        "longitude": -122.1698,
        "schemaVersion": 3,
    }
    serialized = str(store.upsert_args)
    assert "37.4275" not in serialized
    assert "-122.1697" not in serialized
    assert "37.4276" not in serialized
    assert "-122.1698" not in serialized
    assert "public-place-a" not in serialized
    assert "Spot A" not in serialized
    assert "current_lat" not in store.upsert_args
    assert "current_lng" not in store.upsert_args


def test_nearby_radius_uses_selected_places_not_captured_points():
    """Two people standing together but checked into venues >500 m apart are not
    co-present. The venue is the rendezvous, so the venue defines the radius."""

    viewer_store = FakeStore()
    viewer_service, _ = _service(viewer_store)
    _check_in(
        viewer_service,
        current_lat=0.0,
        current_lng=0.0,
        place_lat=0.0,
        place_lng=-0.004,
        place_label="West venue",
        accuracy_m=10,
    )

    target_store = FakeStore()
    target_service, _ = _service(target_store)
    _check_in(
        target_service,
        user_id="target",
        current_lat=0.0,
        current_lng=0.001,
        place_lat=0.0,
        place_lng=0.005,
        place_label="East venue",
        accuracy_m=10,
    )
    viewer_store.candidates = [
        {
            **target_store.presence,
            "participant_alias": TARGET_ALIAS,
            "display_name": "Mira",
            "relationship": "none",
        }
    ]

    # Captured points are 111 m apart, but the venues are ~1001 m apart.
    assert viewer_service.get_state(user_id="viewer")["attendees"] == []


def test_same_selected_place_matches_however_coarse_each_captured_point_was():
    """The whole point of anchoring on the place: two people who picked the same
    venue always see each other, whatever their receivers reported."""

    viewer_store = FakeStore()
    viewer_service, _ = _service(viewer_store)
    _check_in(
        viewer_service,
        current_lat=0.0,
        current_lng=-0.004,
        place_lat=0.0,
        place_lng=0.0,
        place_label="Shared venue",
        accuracy_m=10,
    )

    target_store = FakeStore()
    target_service, _ = _service(target_store)
    _check_in(
        target_service,
        user_id="target",
        current_lat=0.0,
        current_lng=0.004,
        place_lat=0.0,
        place_lng=0.0,
        place_label="Shared venue",
        # A browser-grade fix that the old 100 m ceiling rejected outright.
        accuracy_m=1_500,
    )
    viewer_store.candidates = [
        {
            **target_store.presence,
            "participant_alias": TARGET_ALIAS,
            "display_name": "Mira",
            "relationship": "none",
        }
    ]

    state = viewer_service.get_state(user_id="viewer")

    assert [attendee["participantAlias"] for attendee in state["attendees"]] == [TARGET_ALIAS]


def test_browser_grade_accuracy_can_check_in():
    """Regression: a wifi/IP fix (routinely 1-5 km) used to be rejected outright,
    which also meant the place list never loaded on desktop web."""

    store = FakeStore()
    service, _ = _service(store)

    state = _check_in(service, accuracy_m=1_500)

    assert state["presence"]["placeLabel"] == "Spot A"


def test_accuracy_tolerance_is_capped_so_a_coarse_fix_cannot_buy_unlimited_reach():
    """Accuracy widens the plausibility envelope, but only up to the documented
    cap -- otherwise a spoofed 5 km reading would admit any place in the city."""

    store = FakeStore()
    service, _ = _service(store)

    # ~2779 m from the selected place: inside 500 + 5000 but outside 500 + 2000.
    with pytest.raises(NearbyPresenceError) as exc:
        _check_in(
            service,
            current_lat=0.0,
            current_lng=0.0,
            place_lat=0.0,
            place_lng=0.025,
            accuracy_m=5_000,
        )

    assert exc.value.code == "NEARBY_PRESENCE_OUTSIDE_RADIUS"


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


def test_exact_500_meter_boundary_is_inclusive(monkeypatch):
    store = FakeStore()
    store.presence = _anchor_row(
        user_id="viewer",
        alias="viewer-alias",
        place_id="spot-a",
        label="Spot A",
        lat=0.0,
        lng=0.0,
    )
    store.candidates = [
        _anchor_row(
            user_id="target",
            alias=TARGET_ALIAS,
            place_id="spot-b",
            label="Spot B",
            lat=0.0,
            lng=0.01,
        )
    ]
    service, _ = _service(store)

    monkeypatch.setattr(nearby_presence, "_distance_meters", lambda **_: 500.0)
    assert len(service.get_state(user_id="viewer")["attendees"]) == 1

    monkeypatch.setattr(nearby_presence, "_distance_meters", lambda **_: 500.001)
    assert service.get_state(user_id="viewer")["attendees"] == []


def test_legacy_place_anchor_presence_is_checked_out_without_mixed_comparison():
    store = FakeStore()
    store.presence = _anchor_row(
        user_id="viewer",
        alias="viewer-alias",
        place_id="legacy-place",
        label="Legacy place",
        lat=0.0,
        lng=0.0,
    )
    store.presence["consent_version"] = "one-location-nearby-presence-v1"
    service, _ = _service(store)

    assert service.get_state(user_id="viewer") == {
        "presence": None,
        "attendees": [],
    }
    assert store.checkout_calls == 1


def test_v2_point_anchored_presence_upgrades_without_surfacing_an_error():
    """The v2 -> v3 rollout must be silent, not a 503.

    A live v2 check-in is anchored on the owner's captured point under the old
    consent text, so it cannot be reinterpreted under v3 place semantics. The
    consent-version gate in `get_state` runs *before* any decrypt, so the row is
    checked out and the owner simply sees the check-in form again rather than
    "This check-in could not be restored" -- which is what they would get if the
    anchor were decrypted first and failed the schema check.
    """

    store = FakeStore()
    v2_envelope = _encrypt_anchor(
        {
            "schemaVersion": 2,
            "coordinateKind": "captured_check_in_point_v1",
            "label": "Old venue",
            "latitude": 0.0,
            "longitude": 0.0,
        },
        owner_user_id="viewer",
    )
    store.presence = {
        **_anchor_row(
            user_id="viewer",
            alias="viewer-alias",
            place_id="v2-place",
            label="Old venue",
            lat=0.0,
            lng=0.0,
        ),
        "consent_version": "one-location-nearby-presence-v2",
        **{f"anchor_{key}": value for key, value in v2_envelope.items() if key != "key_id"},
        "anchor_key_id": v2_envelope["key_id"],
    }
    service, _ = _service(store)

    # No NearbyPresenceError: the owner is simply not checked in any more.
    assert service.get_state(user_id="viewer") == {
        "presence": None,
        "attendees": [],
    }
    assert store.checkout_calls == 1


def test_v2_peers_never_leak_into_a_v3_roster():
    """A v2 candidate row must not be matched against a v3 viewer, even if the
    store hands one back: consent versions are compared per candidate."""

    store = FakeStore()
    _service(store)[0]
    viewer_service, _ = _service(store)
    _check_in(viewer_service, place_lat=0.0, place_lng=0.0, current_lat=0.0, current_lng=0.0)

    stale_candidate = _anchor_row(
        user_id="target",
        alias=TARGET_ALIAS,
        place_id="v2-place",
        label="Old venue",
        lat=0.0,
        lng=0.0,
    )
    stale_candidate["consent_version"] = "one-location-nearby-presence-v2"
    store.candidates = [stale_candidate]

    assert viewer_service.get_state(user_id="viewer")["attendees"] == []


@pytest.mark.parametrize(
    ("overrides", "expected_code"),
    [
        ({"consent_accepted": False}, "NEARBY_PRESENCE_CONSENT_REQUIRED"),
        ({"duration_minutes": 15}, "NEARBY_PRESENCE_DURATION_INVALID"),
        ({"accuracy_m": None}, "NEARBY_PRESENCE_LOCATION_TOO_COARSE"),
        ({"accuracy_m": 5_001}, "NEARBY_PRESENCE_LOCATION_TOO_COARSE"),
        (
            {"captured_at": NOW - timedelta(minutes=6)},
            "NEARBY_PRESENCE_LOCATION_STALE",
        ),
        (
            {"captured_at": NOW + timedelta(seconds=61)},
            "NEARBY_PRESENCE_LOCATION_STALE",
        ),
        ({"current_lat": float("nan")}, "NEARBY_PRESENCE_LOCATION_INVALID"),
        ({"current_lat": 90.0001}, "NEARBY_PRESENCE_LOCATION_INVALID"),
        ({"current_lng": 180.0001}, "NEARBY_PRESENCE_LOCATION_INVALID"),
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


def test_cell_cover_uses_bounded_polar_bucket_without_false_negative():
    target_x, target_y = _tile_xy(lat=89.999, lng=90.0)
    epoch = _cell_epoch(NOW)
    epochs, tokens = _candidate_cell_tokens(
        lat=89.999,
        lng=0.0,
        radius_meters=500,
        now=NOW,
    )

    assert (target_x, target_y) == (0, 0)
    assert _cell_token(epoch=epoch, x=target_x, y=target_y) in tokens
    assert len(tokens) <= 4


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
            consent_version=NEARBY_PRESENCE_CONSENT_VERSION,
            cell_epochs=[1, 0],
            cell_tokens=["opaque"],
            roster_seed="stable",
            limit=999,
        )
        == []
    )

    normalized_sql = " ".join(captured["sql"].split()).lower()
    assert "select p.owner_user_id, p.participant_alias, p.consent_version," in normalized_sql
    assert "p.version = :viewer_version" in normalized_sql
    assert "p.consent_version = :consent_version" in normalized_sql
    assert "p.anchor_cell_token = any(:cell_tokens)" in normalized_sql
    assert "order by random()" not in normalized_sql
    assert "hmac(" in normalized_sql
    assert captured["params"]["limit"] == 240


def test_postgres_connection_pair_projects_consent_version(monkeypatch):
    store = PostgresNearbyPresenceStore()
    captured = {}

    monkeypatch.setattr(store, "_expire_due", lambda: 0)

    def execute(sql, params=None):
        captured["sql"] = sql
        captured["params"] = params
        return []

    monkeypatch.setattr(store, "_execute_many", execute)
    assert (
        store.read_connection_pair(
            viewer_user_id="viewer",
            participant_alias="00000000-0000-0000-0000-000000000001",
            consent_version=NEARBY_PRESENCE_CONSENT_VERSION,
        )
        == []
    )

    normalized_sql = " ".join(captured["sql"].split()).lower()
    assert "select p.owner_user_id, p.participant_alias, p.consent_version," in normalized_sql
    assert captured["params"] == {
        "viewer_user_id": "viewer",
        "participant_alias": "00000000-0000-0000-0000-000000000001",
        "consent_version": NEARBY_PRESENCE_CONSENT_VERSION,
    }
