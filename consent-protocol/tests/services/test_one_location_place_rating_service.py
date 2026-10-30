"""Policy tests for rating a place you checked in at.

Backend tests run offline against a SQLite schema that contains no
`one_location_*` table at all, so the store is faked and every assertion here
is about the decision, not the SQL.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest

from hushh_mcp.operons.location.place_rating_policy import (
    PLACE_RATING_PUBLICATION_MIN_COUNT,
    bucket_rating_count,
    google_write_review_url,
    is_aggregatable_category,
    normalize_place_label,
    normalize_rating,
    publishable_average,
)
from hushh_mcp.services import one_location_place_rating_service as rating_service_module
from hushh_mcp.services.one_location_place_rating_service import (
    PLACE_RATING_CONSENT_VERSION,
    PLACE_RATING_VISIT_TTL_HOURS,
    OneLocationPlaceRatingService,
    PlaceRatingError,
    PostgresPlaceRatingStore,
    _encrypt_visit_place,
    place_token,
)

NOW = datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)
USER = "user_a"
PLACE = "ChIJbagmaker"


def _visit_row(
    *,
    user_id: str = USER,
    place_id: str = PLACE,
    label: str = "Bag Maker",
    category: str | None = "store",
    checked_in_at: datetime | None = None,
    latitude: float = 25.45,
    longitude: float = 81.85,
) -> dict[str, Any]:
    moment = checked_in_at or NOW - timedelta(hours=1)
    envelope = _encrypt_visit_place(
        {
            "schemaVersion": 1,
            "placeId": place_id,
            "label": label,
            "category": category,
            "latitude": latitude,
            "longitude": longitude,
        },
        owner_user_id=user_id,
    )
    return {
        "id": "visit-1",
        "owner_user_id": user_id,
        "place_ciphertext": envelope["ciphertext"],
        "place_iv": envelope["iv"],
        "place_tag": envelope["tag"],
        "place_algorithm": envelope["algorithm"],
        "place_key_id": envelope["key_id"],
        "place_token": place_token(place_id),
        "checked_in_at": moment,
        "ended_at": None,
        "expires_at": moment + timedelta(hours=PLACE_RATING_VISIT_TTL_HOURS),
    }


class FakeStore:
    def __init__(self, *, visits: list[dict[str, Any]] | None = None) -> None:
        self.visits = list(visits or [])
        self.ratings: dict[tuple[str, str], dict[str, Any]] = {}
        self.aggregates: dict[str, dict[str, Any]] = {}
        self.recomputed: list[str] = []
        self.rated_visits: list[Any] = []
        self.inserted_visits: list[dict[str, Any]] = []

    # visits
    def insert_visit(self, **kwargs: Any) -> dict[str, Any] | None:
        self.inserted_visits.append(kwargs)
        return {"id": "visit-new"}

    def end_open_visits(self, *, user_id: str, ended_at: datetime) -> dict[str, Any] | None:
        for visit in self.visits:
            if visit["owner_user_id"] == user_id and visit.get("ended_at") is None:
                visit["ended_at"] = ended_at
                return visit
        return None

    def get_rateable_visit(
        self, *, user_id: str, place_token_value: str, not_before: datetime
    ) -> dict[str, Any] | None:
        for visit in self.visits:
            if (
                visit["owner_user_id"] == user_id
                and visit["place_token"] == place_token_value
                and visit["checked_in_at"] >= not_before
            ):
                return visit
        return None

    def list_rateable_visits(
        self, *, user_id: str, not_before: datetime, limit: int
    ) -> list[dict[str, Any]]:
        return [
            v
            for v in self.visits
            if v["owner_user_id"] == user_id and v["checked_in_at"] >= not_before
        ][:limit]

    def latest_visit(self, *, user_id: str) -> dict[str, Any] | None:
        rows = [v for v in self.visits if v["owner_user_id"] == user_id]
        return rows[-1] if rows else None

    def mark_visit_rated(self, *, visit_id: Any, rated_at: datetime) -> None:
        self.rated_visits.append(visit_id)

    # ratings
    def upsert_rating_and_recompute(self, **kwargs: Any) -> dict[str, Any] | None:
        key = (kwargs["user_id"], kwargs["place_id"])
        existing = self.ratings.get(key)
        row = {
            "id": "rating-1",
            "place_id": kwargs["place_id"],
            "place_label": kwargs["place_label"],
            "place_category": kwargs["place_category"],
            "rating": kwargs["rating"],
            "aggregatable": kwargs["aggregatable"],
            "consent_version": kwargs["consent_version"],
            "visited_at": kwargs["visited_at"],
            "visit_count": (existing["visit_count"] + 1) if existing else 1,
            "revision": (existing["revision"] + 1) if existing else 1,
            "created_at": NOW,
            "updated_at": NOW,
        }
        self.ratings[key] = row
        self.recompute_aggregate(place_id=kwargs["place_id"])
        return row

    def list_ratings(self, *, user_id: str, limit: int) -> list[dict[str, Any]]:
        return [row for (uid, _), row in self.ratings.items() if uid == user_id][:limit]

    def delete_rating_and_recompute(self, *, user_id: str, place_id: str) -> dict[str, Any] | None:
        removed = self.ratings.pop((user_id, place_id), None)
        if removed:
            self.recompute_aggregate(place_id=place_id)
        return removed

    def recompute_aggregate(self, *, place_id: str) -> dict[str, Any] | None:
        self.recomputed.append(place_id)
        rows = [
            r
            for (_, pid), r in self.ratings.items()
            if pid == place_id
            and r["aggregatable"]
            and r["consent_version"] == PLACE_RATING_CONSENT_VERSION
            and is_aggregatable_category(r.get("place_category"))
        ]
        agg = {
            "place_id": place_id,
            "rating_count": len(rows),
            "rating_sum": sum(r["rating"] for r in rows),
        }
        self.aggregates[place_id] = agg
        return agg

    def read_aggregate(self, *, place_id: str) -> dict[str, Any] | None:
        return self.aggregates.get(place_id)

    def purge_expired_visits(self) -> int:
        return 0


def _service(store: FakeStore) -> OneLocationPlaceRatingService:
    return OneLocationPlaceRatingService(store=store, now=lambda: NOW)


def _submit(service: OneLocationPlaceRatingService, **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "user_id": USER,
        "place_id": PLACE,
        "rating": 4,
        "consent_version": PLACE_RATING_CONSENT_VERSION,
        "consent_accepted": True,
    }
    payload.update(overrides)
    return service.submit_rating(**payload)


# --- eligibility ----------------------------------------------------------


def test_rating_requires_a_recorded_visit_to_the_same_place():
    store = FakeStore(visits=[_visit_row()])
    service = _service(store)

    with pytest.raises(PlaceRatingError) as excinfo:
        _submit(service, place_id="ChIJsomewhere-else")

    assert excinfo.value.code == "PLACE_RATING_VISIT_REQUIRED"
    assert excinfo.value.status_code == 403
    assert store.ratings == {}


def test_a_visit_older_than_the_window_can_no_longer_be_rated():
    stale = _visit_row(checked_in_at=NOW - timedelta(hours=PLACE_RATING_VISIT_TTL_HOURS + 1))
    store = FakeStore(visits=[stale])

    with pytest.raises(PlaceRatingError) as excinfo:
        _submit(_service(store))

    assert excinfo.value.code == "PLACE_RATING_VISIT_REQUIRED"
    assert store.ratings == {}


# --- consent --------------------------------------------------------------


def test_an_unaccepted_consent_writes_nothing():
    store = FakeStore(visits=[_visit_row()])

    with pytest.raises(PlaceRatingError) as excinfo:
        _submit(_service(store), consent_accepted=False)

    assert excinfo.value.code == "PLACE_RATING_CONSENT_REQUIRED"
    assert store.ratings == {}


def test_a_stale_client_cannot_save_under_a_promise_it_never_showed():
    # The version is checked, not stamped. A client still displaying v1's words
    # must not be able to write a row that reads as v2 consent.
    store = FakeStore(visits=[_visit_row()])

    with pytest.raises(PlaceRatingError) as excinfo:
        _submit(_service(store), consent_version="one-location-place-rating-v0")

    assert excinfo.value.code == "PLACE_RATING_CONSENT_VERSION_UNSUPPORTED"
    assert excinfo.value.status_code == 409
    assert store.ratings == {}


# --- the rating itself ----------------------------------------------------


@pytest.mark.parametrize("bad", [0, 6, -1, "5", 3.5, True, None])
def test_only_a_whole_number_from_one_to_five_is_a_rating(bad: Any):
    store = FakeStore(visits=[_visit_row()])

    with pytest.raises(PlaceRatingError) as excinfo:
        _submit(_service(store), rating=bad)

    assert excinfo.value.code == "PLACE_RATING_INVALID"
    assert store.ratings == {}


def test_a_saved_rating_recomputes_the_average_and_retires_the_visit():
    store = FakeStore(visits=[_visit_row()])

    saved = _submit(_service(store))

    assert saved["rating"] == 4
    assert saved["placeLabel"] == "Bag Maker"
    assert saved["countsTowardAverage"] is True
    assert saved["consentCurrent"] is True
    assert store.recomputed == [PLACE]
    assert store.rated_visits == ["visit-1"]


def test_the_label_comes_from_the_recorded_visit_not_the_request():
    # Otherwise one account could rate a real venue and have it stored under
    # any name it liked.
    store = FakeStore(visits=[_visit_row(label="Bag Maker")])

    saved = _submit(_service(store), place_label="Somewhere Nicer")

    assert saved["placeLabel"] == "Bag Maker"


def test_rating_the_same_place_twice_updates_one_row():
    # One person, one vote per place. Without it the average is gameable by a
    # single account and a rate limit only slows that down.
    store = FakeStore(visits=[_visit_row()])
    service = _service(store)

    _submit(service, rating=2)
    second = _submit(service, rating=5)

    assert len(store.ratings) == 1
    assert second["rating"] == 5
    assert second["revision"] == 2
    assert second["visitCount"] == 2


def test_a_returned_rating_never_carries_an_author_identifier():
    store = FakeStore(visits=[_visit_row()])

    saved = _submit(_service(store))

    for key in saved:
        assert "author" not in key.lower()
        assert "user" not in key.lower()


# --- sensitive categories -------------------------------------------------


@pytest.mark.parametrize(
    "category", ["medical_clinic", "hospital", "mosque", "lawyer", "womens_shelter"]
)
def test_a_sensitive_place_is_rated_privately_but_never_averaged(category: str):
    store = FakeStore(visits=[_visit_row(category=category)])

    saved = _submit(_service(store))

    # The author still gets their own rating and their own history.
    assert saved["rating"] == 4
    # It simply never contributes to anything anybody else can see.
    assert saved["countsTowardAverage"] is False
    assert store.aggregates[PLACE]["rating_count"] == 0


# --- deletion -------------------------------------------------------------


def test_deleting_a_rating_recomputes_the_average_in_the_same_call():
    store = FakeStore(visits=[_visit_row()])
    service = _service(store)
    _submit(service)
    store.recomputed.clear()

    result = service.delete_rating(user_id=USER, place_id=PLACE)

    assert result == {"placeId": PLACE, "deleted": True}
    assert store.recomputed == [PLACE]
    assert store.aggregates[PLACE]["rating_count"] == 0


def test_deleting_a_rating_you_never_made_is_a_404_not_a_silent_success():
    store = FakeStore(visits=[_visit_row()])

    with pytest.raises(PlaceRatingError) as excinfo:
        _service(store).delete_rating(user_id=USER, place_id=PLACE)

    assert excinfo.value.code == "PLACE_RATING_NOT_FOUND"


def test_postgres_rating_mutations_recompute_in_the_same_statement(monkeypatch):
    calls: list[tuple[str, dict[str, Any]]] = []

    class CapturingDb:
        def execute_raw(self, sql, params):
            calls.append((sql, params))
            return SimpleNamespace(data=[{"id": "rating-1", "place_id": PLACE}])

    monkeypatch.setattr(rating_service_module, "get_db", lambda: CapturingDb())
    store = PostgresPlaceRatingStore()
    store.upsert_rating_and_recompute(
        user_id=USER,
        place_id=PLACE,
        place_label="Bag Maker",
        place_category="store",
        rating=4,
        aggregatable=True,
        consent_version=PLACE_RATING_CONSENT_VERSION,
        source_visit_id="visit-1",
        visited_at=NOW,
    )
    store.delete_rating_and_recompute(user_id=USER, place_id=PLACE)

    assert len(calls) == 2
    for sql, params in calls:
        assert "aggregate AS" in sql
        assert "CROSS JOIN aggregate" in sql
        assert "consent_version = :consent_version" in sql
        assert params["consent_version"] == PLACE_RATING_CONSENT_VERSION
        assert "medical_clinic" in params["sensitive_categories"]


def test_postgres_public_read_rechecks_consent_and_sensitive_category(monkeypatch):
    captured: dict[str, Any] = {}

    class CapturingDb:
        def execute_raw(self, sql, params):
            captured.update(sql=sql, params=params)
            return SimpleNamespace(data=[{"place_id": PLACE, "rating_count": 0, "rating_sum": 0}])

    monkeypatch.setattr(rating_service_module, "get_db", lambda: CapturingDb())
    PostgresPlaceRatingStore().read_aggregate(place_id=PLACE)

    assert "FROM one_location_place_ratings" in captured["sql"]
    assert "consent_version = :consent_version" in captured["sql"]
    assert "ANY(:sensitive_categories)" in captured["sql"]
    assert captured["params"]["consent_version"] == PLACE_RATING_CONSENT_VERSION


# --- the anonymous projection ---------------------------------------------


def test_a_place_below_the_threshold_publishes_no_average_at_all():
    store = FakeStore()
    store.aggregates[PLACE] = {"place_id": PLACE, "rating_count": 4, "rating_sum": 18}

    summary = _service(store).place_summary(place_id=PLACE)

    assert summary["average"] is None
    assert summary["countBucket"] is None
    assert summary["minimumRaters"] == PLACE_RATING_PUBLICATION_MIN_COUNT


def test_a_published_summary_is_an_average_and_a_bucket_never_an_exact_count():
    # An exact count plus an exact average lets an observer recover each new
    # rating by subtraction, at any n.
    store = FakeStore()
    store.aggregates[PLACE] = {"place_id": PLACE, "rating_count": 12, "rating_sum": 53}

    summary = _service(store).place_summary(place_id=PLACE)

    assert summary["average"] == 4.4
    assert summary["countBucket"] == "10+"
    assert "ratingCount" not in summary
    assert 12 not in summary.values()


# --- the batch projection -------------------------------------------------


def test_a_batch_omits_every_place_that_has_not_earned_an_average():
    # A row saying "no rating yet" for every unrated place is noise on a list
    # whose whole job is to be scanned, and it also confirms to a reader which
    # places nobody has rated.
    store = FakeStore()
    store.aggregates["ready"] = {"place_id": "ready", "rating_count": 8, "rating_sum": 36}
    store.aggregates["thin"] = {"place_id": "thin", "rating_count": 2, "rating_sum": 9}

    summaries = _service(store).place_summaries(place_ids=["ready", "thin", "unknown"])

    assert [s["placeId"] for s in summaries] == ["ready"]
    assert summaries[0]["average"] == 4.5
    assert summaries[0]["countBucket"] == "5+"


def test_a_batch_deduplicates_and_is_bounded():
    store = FakeStore()
    for i in range(40):
        store.aggregates[f"p{i}"] = {
            "place_id": f"p{i}",
            "rating_count": 9,
            "rating_sum": 36,
        }

    summaries = _service(store).place_summaries(
        place_ids=["p1", "p1", "p2"] + [f"p{i}" for i in range(40)],
    )

    ids = [s["placeId"] for s in summaries]
    assert len(ids) == len(set(ids))
    assert len(ids) <= 25


def test_a_batch_skips_junk_instead_of_failing_the_whole_call():
    store = FakeStore()
    store.aggregates["ok"] = {"place_id": "ok", "rating_count": 6, "rating_sum": 24}

    summaries = _service(store).place_summaries(place_ids=["", "   ", None, "ok"])

    assert [s["placeId"] for s in summaries] == ["ok"]


def test_a_summary_never_carries_a_user_or_an_exact_count():
    store = FakeStore()
    store.aggregates["p"] = {"place_id": "p", "rating_count": 37, "rating_sum": 148}

    summary = _service(store).place_summaries(place_ids=["p"])[0]

    assert summary["countBucket"] == "10+"
    assert 37 not in summary.values()
    for key in summary:
        assert "user" not in key.lower()
        assert "author" not in key.lower()


# --- visits and continuity ------------------------------------------------


def test_checkout_reports_what_can_now_be_rated():
    store = FakeStore(visits=[_visit_row()])

    prompt = _service(store).end_visit(user_id=USER)

    assert prompt is not None
    assert prompt["placeId"] == PLACE
    assert prompt["placeLabel"] == "Bag Maker"
    assert prompt["googleReviewUrl"].startswith(
        "https://search.google.com/local/writereview?placeid="
    )
    assert prompt["consentVersion"] == PLACE_RATING_CONSENT_VERSION


def test_the_continuity_point_survives_checkout():
    # This is the whole reason the visit ledger carries coordinates. `checkout`
    # NULLs the presence anchor, so without this the next check-in has no
    # travel-plausibility check at all.
    ended = _visit_row()
    ended["ended_at"] = NOW
    store = FakeStore(visits=[ended])

    point = _service(store).last_continuity_point(user_id=USER)

    assert point is not None
    assert point["latitude"] == pytest.approx(25.45)
    assert point["longitude"] == pytest.approx(81.85)


def test_recording_a_visit_encrypts_the_place():
    store = FakeStore()

    _service(store).record_visit(
        user_id=USER, place_id=PLACE, place_label="Bag Maker", latitude=25.45, longitude=81.85
    )

    written = store.inserted_visits[0]
    assert written["place_token_value"] == place_token(PLACE)
    assert PLACE not in str(written["envelope"])
    assert "Bag Maker" not in str(written["envelope"])


# --- the pure operon ------------------------------------------------------


def test_google_deep_link_uses_the_lowercase_key_google_actually_accepts():
    # `placeId` silently yields Google's generic search page instead of the
    # review composer, and is exactly the kind of thing "tidied" in review.
    url = google_write_review_url("ChIJN1t_tDeuEmsRUsoyG83frY4")

    assert url == (
        "https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4"
    )
    assert "placeid=" in url
    assert "placeId=" not in url
    assert google_write_review_url("a+b/c").endswith("placeid=a%2Bb%2Fc")
    assert google_write_review_url("   ") is None


def test_an_indic_place_label_is_never_split_at_its_matras():
    # safe-changes R20: a matra is part of the letter, not decoration on it.
    label = normalize_place_label("  तेलियरगंज  बाज़ार ")

    assert label == "तेलियरगंज बाज़ार"
    assert len(label.split()) == 2


def test_bucketing_and_publishable_average_agree_on_the_threshold():
    assert bucket_rating_count(PLACE_RATING_PUBLICATION_MIN_COUNT - 1) is None
    assert bucket_rating_count(PLACE_RATING_PUBLICATION_MIN_COUNT) == "5+"
    assert bucket_rating_count(10) == "10+"
    assert bucket_rating_count(600) == "500+"
    assert publishable_average(rating_count=4, rating_sum=20) is None
    assert publishable_average(rating_count=5, rating_sum=22) == 4.4


def test_an_unclassified_place_is_still_ratable():
    assert is_aggregatable_category("") is True
    assert is_aggregatable_category(None) is True
    assert is_aggregatable_category("HOSPITAL") is False


def test_a_bool_is_not_a_rating():
    # isinstance(True, int) is True in Python, so this needs its own guard.
    with pytest.raises(ValueError):
        normalize_rating(True)
