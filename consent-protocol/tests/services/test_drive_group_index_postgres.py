"""Real PostgreSQL fences for the sealed four-group Drive index; invented files, no Google call."""

# ruff: noqa: F401,F811 -- shared isolated PostgreSQL fixture dependency graph
from __future__ import annotations

from datetime import UTC, date, datetime
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from hushh_mcp.services.drive_group_index_store import (
    DISCLOSURE,
    DriveGroupIndexStore,
    GroupEntry,
)
from hushh_mcp.services.drive_groups.contract import FLAG, GroupIndexDisabled, Placement
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_ingestion import (
    collection,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    ingestion,
    lifecycle,
)

MIGRATION = Path(__file__).resolve().parents[2] / "db" / "migrations" / "368_drive_group_index.sql"
VERSION = "0123456789ab"
MOMENT = datetime(2026, 5, 2, 9, 30, tzinfo=UTC)


@pytest.fixture
async def groups(collection, monkeypatch):
    monkeypatch.setenv(FLAG, "true")
    with collection.db.engine.begin() as connection:
        connection.exec_driver_sql(MIGRATION.read_text(), execution_options={"no_parameters": True})
    return DriveGroupIndexStore(db=collection.db, cipher=collection.cipher)


def entry(
    name, group=None, *, created=None, modified=MOMENT, title_day=None, head=None, vector=None
):
    placed = group is not None
    return GroupEntry(
        file_id=f"file-{name}",
        title=f"Private {name}.pdf",
        mime_type="application/pdf",
        view_url=f"https://drive.google.com/file/d/{name}/view",
        created_time=created,
        modified_time=modified,
        title_day=title_day,
        placement=Placement(
            group=group,
            candidate=group or "financial_statements",
            best_class=group or "none",
            confidence=0.91 if placed else 0.4,
            margin=0.5,
            reason="placed" if placed else "low_confidence",
            readings=(),
            version=VERSION,
        ),
        head=head,
        vector=vector,
    )


async def opted_in(groups, zone="UTC"):
    await groups.set_processing(
        user_id="owner", enabled=True, disclosure=DISCLOSURE, time_zone=zone
    )
    job = await groups.claim(user_id="owner")
    assert job is not None
    return job


async def commit(groups, job, entries, *, more=True, keep=None, listed=None):
    return await groups.commit(
        job,
        entries,
        listed=len(entries) if listed is None else listed,
        complete=True,
        limited=False,
        keep=keep,
        more=more,
    )


def rows(groups, table="drive_group_index"):
    with groups.db.engine.connect() as connection:
        return [dict(row) for row in connection.execute(text(f"SELECT * FROM {table}")).mappings()]


async def test_the_migration_replays_and_the_database_refuses_inconsistent_rows(groups):
    with groups.db.engine.begin() as connection:
        connection.exec_driver_sql(MIGRATION.read_text(), execution_options={"no_parameters": True})
    await opted_in(groups)
    with pytest.raises(IntegrityError):
        # The aid keeps a file exactly when it did not place it.
        with groups.db.engine.begin() as connection:
            connection.execute(
                text("""INSERT INTO drive_group_index
                  (user_id,connection_generation,source_ref,shelf,confidence,reason,group_source,
                   model_version,source_modified,entry_envelope)
                  VALUES ('owner',1,:ref,'kept',0.5,'placed','organizer_v1',:version,now(),'{}')"""),
                {"ref": "a" * 64, "version": VERSION},
            )
    with pytest.raises(IntegrityError):
        # Processing cannot be on without the disclosure it was accepted under.
        with groups.db.engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE drive_group_index_state SET disclosure_version=NULL WHERE user_id='owner'"
                )
            )


async def test_the_opt_in_needs_the_flag_and_the_exact_disclosure_and_pausing_deletes_nothing(
    groups, monkeypatch
):
    monkeypatch.delenv(FLAG)
    with pytest.raises(GroupIndexDisabled):
        await groups.set_processing(user_id="owner", enabled=True, disclosure=DISCLOSURE)
    assert await groups.due_owners() == []
    monkeypatch.setenv(FLAG, "true")
    for bad in ("drive-four-group-v0", None):
        with pytest.raises(DriveReadError, match="confirmation_required"):
            await groups.set_processing(user_id="owner", enabled=True, disclosure=bad)
    with pytest.raises(DriveReadError, match="invalid_argument"):
        await groups.set_processing(
            user_id="owner", enabled=True, disclosure=DISCLOSURE, time_zone="Not/AZone"
        )
    job = await opted_in(groups)
    await commit(groups, job, [entry("a", "financial_statements")])
    paused = await groups.set_processing(user_id="owner", enabled=False, disclosure=None)
    assert paused["enabled"] is False and len(rows(groups)) == 1
    with pytest.raises(DriveReadError, match="group_index_processing_required"):
        await groups.claim(user_id="owner")


async def test_names_ids_links_and_text_starts_are_sealed_and_only_kept_files_keep_a_text_start(
    groups,
):
    job = await opted_in(groups)
    vector = tuple([0.0] * 383 + [1.0])
    await commit(
        groups,
        job,
        [
            entry("a", "financial_statements", created=MOMENT),
            entry(
                "b", None, created=MOMENT, head="Private account text of ravi-sharma", vector=vector
            ),
        ],
    )
    stored = rows(groups)
    assert len(stored) == 2
    for row in stored:
        assert not any(
            secret in str(row)
            for secret in ("file-a", "file-b", "Private", "drive.google.com", "ravi-sharma")
        )
        assert set(row["entry_envelope"]) == {"version", "iv", "ciphertext"}
    by_shelf = {row["shelf"]: groups.sealer.open_entry(row) for row in stored}
    assert by_shelf["financial_statements"]["head"] is None
    assert by_shelf["financial_statements"]["vec"] is None
    assert by_shelf["kept"]["head"] == "Private account text of ravi-sharma"
    assert by_shelf["kept"]["vec"] is not None
    # Only the owner's own page is opened, and by that owner alone.
    page = await groups.files(user_id="owner", shelf="financial_statements")
    assert [item["title"] for item in page["items"]] == ["Private a.pdf"]
    assert "ravi-sharma" not in str(page)


async def test_a_sealed_entry_opens_only_for_its_own_owner_file_and_connection(groups):
    job = await opted_in(groups)
    await commit(
        groups, job, [entry("a", "financial_statements"), entry("b", "insurance_statements")]
    )
    first, second = rows(groups)
    assert groups.sealer.open_entry(first)["id"].startswith("file-")
    for substitution in (
        {"user_id": "other-owner"},
        {"source_ref": second["source_ref"]},
        {"connection_generation": 2},
        {"entry_envelope": second["entry_envelope"]},
    ):
        with pytest.raises(DriveReadError, match="document_storage_unavailable"):
            groups.sealer.open_entry({**first, **substitution})
    assert groups.sealer.ref("owner", "file-a") != groups.sealer.ref("other-owner", "file-a")


async def test_a_changed_connection_removes_the_index_and_the_opt_in(groups):
    job = await opted_in(groups)
    await commit(groups, job, [entry("a", "financial_statements")])
    with groups.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE user_external_connector_connections SET connection_generation=2"
                " WHERE user_id='owner' AND connector_id='google_drive'"
            )
        )
    assert rows(groups) == [] and rows(groups, "drive_group_index_state") == []


async def test_a_run_that_lost_its_lease_its_opt_in_or_its_background_access_cannot_commit(groups):
    job = await opted_in(groups)
    await groups.set_processing(user_id="owner", enabled=True, disclosure=DISCLOSURE)
    with pytest.raises(DriveReadError, match="group_index_processing_required"):
        await commit(groups, job, [entry("a", "financial_statements")])
    assert rows(groups) == []
    job = await groups.claim(user_id="owner")
    await groups.set_background(user_id="owner", enabled=False, confirmed=True)
    assert await groups.due_owners() == []
    with pytest.raises(DriveReadError, match="background_preparation_required"):
        await commit(groups, job, [entry("a", "financial_statements")])
    assert rows(groups) == []


async def test_a_complete_listing_prunes_missing_files_and_an_owner_move_survives_a_rerun(groups):
    job = await opted_in(groups)
    await commit(
        groups, job, [entry("a", "financial_statements"), entry("b", "insurance_statements")]
    )
    with groups.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_group_index SET shelf='personal_documents', group_source='owner'"
                " WHERE source_ref=:ref"
            ),
            {"ref": groups.sealer.ref("owner", "file-a")},
        )
    job = await groups.claim(user_id="owner")
    refs = {groups.sealer.ref("owner", "file-a")}
    await commit(groups, job, [entry("a", "financial_statements")], more=False, keep=refs)
    left = rows(groups)
    assert [(row["shelf"], row["group_source"]) for row in left] == [
        ("personal_documents", "owner")
    ]
    known = await groups.claim(user_id="owner")
    assert known is None  # a finished run waits before the next one


async def test_folders_and_files_follow_the_owners_fiscal_quarter_and_time_zone(groups):
    job = await opted_in(groups, zone="Asia/Kolkata")
    late_march_utc = datetime(2025, 3, 31, 20, 0, tzinfo=UTC)
    await commit(
        groups,
        job,
        [
            entry("a", "financial_statements", created=late_march_utc),
            entry("b", "financial_statements", created=MOMENT, title_day=date(2025, 9, 14)),
            entry("c", "financial_statements", created=None, modified=MOMENT),
            entry("d", None, created=MOMENT, head="kept text"),
        ],
    )

    async def names():
        return [(item["name"], item["count"]) for item in await groups.folders(user_id="owner")]

    # Newest quarter first; the kept folder has no quarter. File "a" was created at 01:30
    # on 1 April in India, which is FY 26 Q1.
    assert await names() == [
        ("Financial Assets (FY 27 Q1)", 1),
        ("Financial Assets (FY 26 Q2)", 1),
        ("Financial Assets (FY 26 Q1)", 1),
        ("Not sorted yet", 1),
    ]
    first = await groups.files(user_id="owner", shelf="financial_statements", period="FY26-Q1")
    assert [(item["day"], item["dayBasis"]) for item in first["items"]] == [
        ("2025-04-01", "created")
    ]
    everything = await groups.files(user_id="owner", shelf="financial_statements")
    assert [item["day"] for item in everything["items"]] == [
        "2026-05-02",
        "2025-09-14",
        "2025-04-01",
    ]
    page = await groups.files(user_id="owner", shelf="financial_statements", limit=2)
    assert page["nextCursor"] == 2 and page["total"] == 3
    # The same file is FY 25 Q4 for an owner in UTC: the zone is the owner's, read when asked.
    await groups.set_processing(
        user_id="owner", enabled=True, disclosure=DISCLOSURE, time_zone="UTC"
    )
    assert ("Financial Assets (FY 25 Q4)", 1) in await names()
    for bad in ("FY26", "FY26-Q5", "kept"):
        with pytest.raises(DriveReadError, match="invalid_argument"):
            await groups.files(user_id="owner", shelf="financial_statements", period=bad)
    with pytest.raises(DriveReadError, match="invalid_argument"):
        await groups.files(user_id="owner", shelf="kept", period="undated")


async def test_erasing_the_index_deletes_every_entry_and_withdraws_the_opt_in(groups):
    job = await opted_in(groups)
    await commit(groups, job, [entry("a", "financial_statements"), entry("b", None, head="x")])
    assert (await groups.erase(user_id="owner"))["removed"] == 2
    assert rows(groups) == []
    status = await groups.status(user_id="owner")
    assert status["enabled"] is False and status["indexedFiles"] == 0 and status["state"] == "off"
