"""Migration guards for place ratings.

Three properties here cannot be fixed after launch, so they are asserted
against the shipped SQL rather than trusted to review:

1. the visit ledger stores no plaintext place id -- only ciphertext and a keyed
   equality token;
2. the rating table carries no author display name, email or phone, so no
   future read path has one to leak next to a place id;
3. one rating per person per place, which is both the anti-bombing control and
   what makes the average correct by construction.

`test_one_location_nearby_presence_migration.py` asserts `"place_id TEXT" not
in sql` against migration 126 only. That assertion is scoped to that file's
text, so this migration would not have tripped it -- which is exactly why the
same intent is restated here for the tables that actually hold one.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "consent-protocol" / "db" / "migrations"
MANIFEST = ROOT / "consent-protocol" / "db" / "release_migration_manifest.json"
UAT_CONTRACT = ROOT / "consent-protocol" / "db" / "contracts" / "uat_integrated_schema.json"
PROD_CONTRACT = ROOT / "consent-protocol" / "db" / "contracts" / "prod_core_schema.json"
DEV_CONTRACT = ROOT / "consent-protocol" / "db" / "contracts" / "dev_minimum_schema.json"

MIGRATION_NAME = "189_one_location_place_ratings.sql"
SQL = (MIGRATIONS / MIGRATION_NAME).read_text(encoding="utf-8")


def _visits_block() -> str:
    start = SQL.index("CREATE TABLE IF NOT EXISTS one_location_nearby_visits")
    return SQL[start : SQL.index(");", start)]


def _ratings_block() -> str:
    start = SQL.index("CREATE TABLE IF NOT EXISTS one_location_place_ratings")
    return SQL[start : SQL.index(");", start)]


def test_place_rating_migration_is_registered_in_every_lane():
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))

    assert MIGRATION_NAME in manifest["ordered_migrations"]
    assert MIGRATION_NAME in manifest["groups"]["iam"]

    for contract_path in (UAT_CONTRACT, PROD_CONTRACT, DEV_CONTRACT):
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
        assert contract["expected_migration_version"] >= 189

    for contract_path in (UAT_CONTRACT, PROD_CONTRACT):
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
        for table in (
            "one_location_nearby_visits",
            "one_location_place_ratings",
            "one_location_place_rating_aggregates",
        ):
            assert table in contract["required_tables"]


def test_visit_ledger_never_stores_a_plaintext_place():
    visits = _visits_block()

    assert "place_ciphertext TEXT NOT NULL" in visits
    assert "place_iv TEXT NOT NULL" in visits
    assert "place_tag TEXT NOT NULL" in visits
    assert "place_token TEXT NOT NULL" in visits
    # The whole point of the table: the venue is readable only with the key.
    assert "place_id" not in visits
    assert "place_label" not in visits
    assert "latitude" not in visits.lower()
    assert "longitude" not in visits.lower()
    # A visit that never expires is a movement log.
    assert "expires_at TIMESTAMPTZ NOT NULL" in visits


def test_rating_row_carries_no_author_identity_beyond_the_owning_user():
    ratings = _ratings_block()

    assert "author_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE" in (
        ratings
    )
    assert "rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5)" in ratings
    assert "consent_version TEXT NOT NULL" in ratings
    assert "consent_accepted_at TIMESTAMPTZ NOT NULL" in ratings
    # No display identity of any kind, and no review text. Both are the columns
    # a future public projection would reach for first.
    for forbidden in (
        "author_display_name",
        "author_display_label",
        "author_person_ref",
        "author_email",
        "author_phone",
        "note",
        "review_text",
        "comment",
    ):
        assert forbidden not in ratings


def test_one_rating_per_person_per_place():
    assert "CREATE UNIQUE INDEX IF NOT EXISTS uq_one_location_place_ratings_author_place" in SQL
    assert "ON one_location_place_ratings (author_user_id, place_id)" in SQL


def test_aggregate_table_holds_no_user_reference():
    start = SQL.index("CREATE TABLE IF NOT EXISTS one_location_place_rating_aggregates")
    block = SQL[start : SQL.index(");", start)]

    assert "rating_count INTEGER NOT NULL" in block
    assert "rating_sum INTEGER NOT NULL" in block
    assert "user_id" not in block
    assert "author" not in block


def test_event_type_widen_is_replay_safe():
    # DROP before ADD is what makes a replayed migration idempotent; 158/159
    # rolled back both production revisions by getting this wrong.
    drop_at = SQL.index("DROP CONSTRAINT IF EXISTS one_location_events_event_type_check")
    add_at = SQL.index("ADD CONSTRAINT one_location_events_event_type_check")
    assert drop_at < add_at

    for event_type in (
        "location_place_rating_saved",
        "location_place_rating_updated",
        "location_place_rating_withdrawn",
        # The pre-existing list must survive intact -- a CHECK is replaced whole.
        "location_sms_contact_added",
        "circle_member_added",
    ):
        assert f"'{event_type}'" in SQL


def test_rollback_refuses_to_drop_a_table_with_rows_in_it():
    rollback = (MIGRATIONS / "rollback" / "189_one_location_place_ratings.rollback.sql").read_text(
        encoding="utf-8"
    )

    for table in (
        "one_location_place_ratings",
        "one_location_nearby_visits",
        "one_location_place_rating_aggregates",
    ):
        assert f"migration_189_rollback_refused_nonempty_table:{table}" in rollback
        assert f"DROP TABLE IF EXISTS {table}" in rollback

    # Leaving the widened constraint behind would allow an event the restored
    # schema has nowhere to put.
    assert "location_place_rating_saved" not in rollback
    assert "location_sms_contact_removed" in rollback
