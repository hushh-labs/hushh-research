"""Real PostgreSQL authority/rollback/race contracts, isolated synthetic schema."""

import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text

from hushh_mcp.services.action_directive_ledger import (
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
    DocumentReviewAuthority,
)
from hushh_mcp.services.drive_sharing_contract import SHARING_ACTION
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url,  # noqa: F401
)

MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"


@pytest.fixture
def ledger_db(connector_postgres_url):  # noqa: F811 - imported shared pytest fixture
    schema = f"document_review_test_{uuid4().hex}"
    admin = create_engine(connector_postgres_url)
    with admin.begin() as connection:
        connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
    engine = create_engine(
        connector_postgres_url, connect_args={"options": f"-csearch_path={schema},public"}
    )
    try:
        with engine.connect() as connection:
            # Only dependencies of the real ledger migration; no production data.
            connection.exec_driver_sql("CREATE TABLE agent_chat_conversations(id UUID PRIMARY KEY)")
            connection.exec_driver_sql(
                "CREATE TABLE one_adk_sessions(app_name TEXT,created_at TIMESTAMPTZ)"
            )
            connection.exec_driver_sql(
                "CREATE TABLE pending_test_effects(id TEXT PRIMARY KEY,directive_id TEXT)"
            )
            connection.commit()
            for name in (
                "114_one_action_directive_ledger.sql",
                "212_location_command_runtime.sql",
                "231_document_review_authority.sql",
                "231_document_review_authority.sql",
            ):
                connection.exec_driver_sql((MIGRATIONS / name).read_text())
            connection.commit()
        yield engine
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
        admin.dispose()


def authority():
    return DocumentReviewAuthority(
        user_id="owner",
        request_id=str(uuid4()),
        revision=1,
        action_contract=SHARING_ACTION,
        slots={"recipient": "private@example.invalid", "documents": ["private-provider-id"]},
        resource_binding={
            "generation": 1,
            "recipient_identity": "verified-subject",
            "source_version": "7",
        },
    )


def store(connection=None):
    return ActionDirectiveStore(connection=connection, hmac_key="synthetic-ledger-key")


def issue(engine, terms):
    with engine.begin() as connection:
        return store(connection).issue_document_review_in_transaction(terms)


def approve(connection, issued, terms):
    ledger = store(connection)
    receipt = ledger.confirm_document_review_in_transaction(
        directive_id=issued.directive_id, authority=terms, trusted_activation=True
    )
    batch = ledger.claim_document_review_in_transaction(
        directive_id=issued.directive_id, receipt=receipt.receipt, authority=terms
    )
    connection.execute(
        text("INSERT INTO pending_test_effects VALUES (:id,:directive)"),
        {
            "id": batch,
            "directive": issued.directive_id,
        },
    )
    return batch


def test_bound_claim_and_pending_work_commit_together(ledger_db):
    terms = authority()
    issued = issue(ledger_db, terms)
    with ledger_db.begin() as connection:
        batch = approve(connection, issued, terms)
    with ledger_db.connect() as connection:
        row = dict(
            connection.execute(text("SELECT * FROM one_action_directive_ledger")).mappings().one()
        )
        assert row["state"] == "consumed"
        assert row["operation_id"] == batch
        assert connection.execute(text("SELECT count(*) FROM pending_test_effects")).scalar() == 1
        assert "private@example.invalid" not in str(row)
        assert "private-provider-id" not in str(row)
        assert "verified-subject" not in str(row)


def test_pending_insertion_failure_rolls_back_confirmation_and_claim(ledger_db):
    terms = authority()
    issued = issue(ledger_db, terms)
    with pytest.raises(RuntimeError, match="synthetic failure"):
        with ledger_db.begin() as connection:
            approve(connection, issued, terms)
            raise RuntimeError("synthetic failure")
    with ledger_db.connect() as connection:
        row = connection.execute(
            text("SELECT state,receipt_hash,consumed_at FROM one_action_directive_ledger")
        ).one()
        assert tuple(row) == ("issued", None, None)
        assert connection.execute(text("SELECT count(*) FROM pending_test_effects")).scalar() == 0


def test_four_concurrent_approvals_claim_exactly_once(ledger_db):
    terms = authority()
    issued = issue(ledger_db, terms)
    barrier = threading.Barrier(4)

    def candidate(_):
        barrier.wait(timeout=5)
        try:
            with ledger_db.begin() as connection:
                return approve(connection, issued, terms)
        except ActionDirectiveAuthorityError:
            return None

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(candidate, range(4)))
    assert sum(item is not None for item in results) == 1
    with ledger_db.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM pending_test_effects")).scalar() == 1


@pytest.mark.parametrize(
    "change",
    [
        {"user_id": "other"},
        {"revision": 2},
        {"request_id": str(uuid4())},
        {"action_contract": {**SHARING_ACTION, "version": 2}},
        {"action_contract": {**SHARING_ACTION, "action_id": "documents.revoke_shared_access"}},
        {"slots": {"recipient": "substituted@example.invalid"}},
        {"resource_binding": {"generation": 2}},
    ],
)
def test_all_terms_bound_at_confirmation_and_claim(ledger_db, change):
    terms = authority()
    issued = issue(ledger_db, terms)
    with ledger_db.begin() as connection:
        ledger = store(connection)
        with pytest.raises(ActionDirectiveAuthorityError):
            ledger.confirm_document_review_in_transaction(
                directive_id=issued.directive_id,
                authority=replace(terms, **change),
                trusted_activation=True,
            )
        receipt = ledger.confirm_document_review_in_transaction(
            directive_id=issued.directive_id, authority=terms, trusted_activation=True
        )
        with pytest.raises(ActionDirectiveAuthorityError):
            ledger.claim_document_review_in_transaction(
                directive_id=issued.directive_id,
                receipt=receipt.receipt,
                authority=replace(terms, **change),
            )


def test_expiry_is_checked_after_waiting_for_the_row_lock(ledger_db):
    terms = authority()
    issued = issue(ledger_db, terms)
    started = threading.Event()
    with ledger_db.connect() as blocker:
        transaction = blocker.begin()
        blocker.execute(text("SELECT directive_id FROM one_action_directive_ledger FOR UPDATE"))

        def claimant():
            with ledger_db.begin() as connection:
                # Record transaction's old NOW() before waiting on the lock.
                connection.execute(text("SELECT now()"))
                started.set()
                with pytest.raises(ActionDirectiveAuthorityError):
                    store(connection).confirm_document_review_in_transaction(
                        directive_id=issued.directive_id, authority=terms, trusted_activation=True
                    )

        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(claimant)
            assert started.wait(timeout=5)
            # Future clock relative to claimant's transaction start, then wait
            # server-side for this synthetic authority to actually expire.
            blocker.execute(
                text(
                    "UPDATE one_action_directive_ledger SET expires_at=clock_timestamp()+INTERVAL '50 milliseconds'"
                )
            )
            blocker.execute(text("SELECT pg_sleep(0.1)"))
            transaction.commit()
            future.result(timeout=5)


@pytest.mark.asyncio
async def test_generic_action_paths_cannot_use_document_review(ledger_db):
    terms = authority()
    issued = issue(ledger_db, terms)
    with ledger_db.begin() as connection:
        ledger = store(connection)
        base = {
            "directive_id": issued.directive_id,
            "user_id": terms.user_id,
            "action_id": SHARING_ACTION["action_id"],
            "context_revision": terms.context_revision,
        }
        with pytest.raises(ActionDirectiveAuthorityError):
            await ledger.confirm(**base, trusted_activation=True)
        with pytest.raises(ActionDirectiveAuthorityError):
            await ledger.settle_direct(**base, status="succeeded", reason_code="synthetic")
        receipt = ledger.confirm_document_review_in_transaction(
            directive_id=issued.directive_id, authority=terms, trusted_activation=True
        )
        with pytest.raises(ActionDirectiveAuthorityError):
            await ledger.consume(**base, receipt=receipt.receipt)
        ledger.claim_document_review_in_transaction(
            directive_id=issued.directive_id, authority=terms, receipt=receipt.receipt
        )
        with pytest.raises(ActionDirectiveAuthorityError):
            await ledger.settle(
                **base, receipt=receipt.receipt, status="succeeded", reason_code="synthetic"
            )


def test_authority_never_falls_back_to_standalone_transaction(ledger_db):
    terms = authority()
    with pytest.raises(ActionDirectiveAuthorityError, match="caller transaction"):
        store().issue_document_review_in_transaction(terms)
    with ledger_db.connect() as connection:
        with pytest.raises(ActionDirectiveAuthorityError, match="caller transaction"):
            store(connection).issue_document_review_in_transaction(terms)


def test_same_revision_cannot_be_reissued_with_different_terms(ledger_db):
    terms = authority()
    issued = issue(ledger_db, terms)
    assert issue(ledger_db, terms).directive_id == issued.directive_id
    with pytest.raises(ActionDirectiveAuthorityError):
        issue(ledger_db, replace(terms, slots={"different": "file"}))
    with ledger_db.begin() as connection:
        approve(connection, issued, terms)
    with pytest.raises(ActionDirectiveAuthorityError):
        issue(ledger_db, terms)


def test_release_replay_of_the_ledger_migrations_keeps_document_review_rows(ledger_db):
    """UAT deploys replay every ordered migration. With a real document_review
    directive present, re-running 212 failed with CheckViolationError
    (one_action_directive_ledger_channel_check) and blocked every deploy."""
    issue(ledger_db, authority())
    with ledger_db.connect() as connection:
        for name in ("212_location_command_runtime.sql", "231_document_review_authority.sql"):
            connection.exec_driver_sql((MIGRATIONS / name).read_text())
        connection.commit()
        channels = (
            connection.exec_driver_sql("SELECT channel FROM one_action_directive_ledger")
            .scalars()
            .all()
        )
    assert channels == ["document_review"]
