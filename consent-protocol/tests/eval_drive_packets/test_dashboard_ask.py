"""Dashboard dry-run ask: the deployed request engine on synthetic data, read-only.

Synthetic owner, synthetic Drive (httpx MockTransport) and a scripted read-only
database. No network, no model, no real data. The production services, filters,
validators and the production read stores run unchanged.
"""

import asyncio
import base64
import contextlib
import json
import re
import secrets
import subprocess
from datetime import UTC, date, datetime

import httpx
import pytest

from hushh_eval.drive_packets.dashboard import ask
from hushh_eval.drive_packets.sources import ReadOnlyViolation

OWNER = "synthetic-owner-0001"
OTHER = "synthetic-owner-0002"
ACCOUNT = "owner@example.test"
WINDOW = ("2026-09-01", "2026-10-09")
PROMPT = "all brokerage statements that contains Schwab from 2026"

# Synthetic Drive. "scan" has a filename without the asked words; "history" was
# edited inside the window but its text covers 2014 to 2016; "notes" was edited
# inside the window and its text has no dates at all.
FILES = {
    "fileSept01": {
        "name": "Schwab statement 2026-09.txt",
        "modified": "2026-10-02T10:00:00.000Z",
        "text": "Charles Schwab brokerage account statement.\n"
        "Statement period: September 1, 2026 to September 30, 2026\nEnding value 100.",
    },
    "fileScan042": {
        "name": "Scan_0042.txt",
        "modified": "2026-09-20T10:00:00.000Z",
        "text": "Charles Schwab brokerage statement.\n"
        "Statement period: September 1, 2026 to September 30, 2026\nPage 1 of 1.",
    },
    "fileHistory7": {
        "name": "Schwab brokerage history.txt",
        "modified": "2026-10-05T10:00:00.000Z",
        "text": "Charles Schwab brokerage account history.\n"
        "Account history January 2014 through December 2016\nTransactions follow.",
    },
    "fileNotes33": {
        "name": "Schwab notes.txt",
        "modified": "2026-09-15T10:00:00.000Z",
        "text": "Notes about the Schwab brokerage account and questions to ask.",
    },
    # Only its name carries the asked word; edited before the window.
    "fileTitle55": {
        "name": "Schwab 2026 statement.txt",
        "modified": "2026-07-01T10:00:00.000Z",
        "text": "Monthly summary page. Nothing else is on this page.",
    },
}
SEPT = "Statement period: September 1, 2026 to September 30, 2026"
HISTORY = "Account history January 2014 through December 2016"
SUMMARY = "Monthly summary page"


# --- Scripted read-only database -------------------------------------------------------
class Result:
    def __init__(self, rows):
        self.rows = [dict(row) for row in rows]

    def mappings(self):
        return self

    def first(self):
        return self.rows[0] if self.rows else None

    def one(self):
        assert len(self.rows) == 1
        return self.rows[0]

    def one_or_none(self):
        return self.rows[0] if self.rows else None

    def scalar_one(self):
        return next(iter(self.one().values()))

    def all(self):
        return list(self.rows)

    def __iter__(self):
        return iter(self.rows)


class ScriptedConnection:
    def __init__(self, database):
        self.database = database

    def exec_driver_sql(self, statement, parameters=None, *_args, **_kwargs):
        return self.execute(statement, parameters)

    def execute(self, statement, parameters=None, *_args, **_kwargs):
        sql = " ".join(str(statement).split())
        self.database.statements.append((sql, parameters))
        if re.match(
            r"^\s*\(?\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE)", sql, re.I
        ):
            self.database.writes.append(sql)
        return Result(self.database.answer(sql, parameters or {}))

    def rollback(self):
        self.database.rollbacks += 1


class ScriptedDb:
    """Answers the production read statements an ask makes, for one synthetic owner."""

    def __init__(self, *, collection=None):
        from hushh_mcp.services.google_drive_adapter import (
            DRIVE_BASE,
            DRIVE_POLICY,
            LIVE_POLICY_HASH,
        )

        self.statements = []
        self.writes = []
        self.rollbacks = 0
        self.connection_row = {
            "user_id": OWNER,
            "connector_id": "google_drive",
            "status": "connected",
            "validation_state": "verified",
            "verified_policy_hash": LIVE_POLICY_HASH,
            "connection_generation": 3,
            "envelope_version": 2,
        }
        self.registry_row = {
            "connector_id": "google_drive",
            "is_active": True,
            "transport_kind": "google_drive_rest",
            "mcp_endpoint": DRIVE_BASE,
            "capability_policy": DRIVE_POLICY,
        }
        self.collection = collection

    @contextlib.contextmanager
    def connect(self):
        yield ScriptedConnection(self)

    def answer(self, sql, parameters):
        if sql.startswith("SET ") or sql.startswith("SHOW "):
            return []
        if sql == "SELECT current_setting('transaction_read_only')":
            return [{"value": "on"}]
        if sql == "SELECT clock_timestamp()":
            return [{"now": datetime.now(UTC)}]
        if "FROM user_external_connector_connections" in sql:
            return [self.connection_row]
        if "FROM external_mcp_connectors" in sql:
            return [self.registry_row]
        if "FROM drive_live_preferences" in sql:
            return []
        if "FROM drive_collection_sync" in sql:
            return [self.collection] if self.collection else []
        if "FROM connected_documents d" in sql:
            return []
        if "FROM drive_packet_heads h" in sql:
            return []
        raise AssertionError(f"unscripted read: {sql[:160]}")


# --- Synthetic Drive -------------------------------------------------------------------
class DriveLog:
    def __init__(self):
        self.methods = []
        self.paths = []


def drive_transport(log: DriveLog):
    def listing(file_id, item):
        return {
            "id": file_id,
            "name": item["name"],
            "mimeType": "text/plain",
            "modifiedTime": item["modified"],
            "createdTime": "2026-01-02T10:00:00.000Z",
            "webViewLink": f"https://drive.google.com/file/d/{file_id}/view",
            "capabilities": {"canShare": True},
        }

    def metadata(file_id, item):
        return {
            "id": file_id,
            "name": item["name"],
            "mimeType": "text/plain",
            "version": "12",
            "modifiedTime": item["modified"],
            "createdTime": "2026-01-02T10:00:00.000Z",
            "size": str(len(item["text"].encode())),
            "trashed": False,
            "isAppAuthorized": False,
            "capabilities": {"canDownload": True, "canAccessViaGenAi": True, "canShare": True},
        }

    def streamed(payload=None, *, content=None):
        # The production adapter streams raw bytes; a prebuilt body cannot be streamed.
        body = content if content is not None else json.dumps(payload).encode()
        return httpx.Response(
            200, headers={"Content-Type": "application/json"}, stream=httpx.ByteStream(body)
        )

    def handler(request: httpx.Request):
        log.methods.append(request.method)
        log.paths.append(request.url.path)
        path = request.url.path
        if path == "/drive/v3/about":
            return streamed(
                {"user": {"permissionId": "perm-1", "emailAddress": ACCOUNT, "me": True}}
            )
        if path == "/drive/v3/drives":
            return streamed({"drives": []})
        if path == "/drive/v3/files":
            return streamed(
                {
                    "files": [listing(key, value) for key, value in FILES.items()],
                    "incompleteSearch": False,
                }
            )
        match = re.fullmatch(r"/drive/v3/files/([A-Za-z0-9_-]+)", path)
        if match and match.group(1) in FILES:
            item = FILES[match.group(1)]
            if request.url.params.get("alt") == "media":
                return streamed(content=item["text"].encode())
            return streamed(metadata(match.group(1), item))
        return httpx.Response(404)

    return httpx.MockTransport(handler)


# --- Deterministic model seams -----------------------------------------------------------
def planner(calls):
    async def plan(*, prompt, user_id):
        assert user_id == OWNER
        calls.append("plan")
        return {
            "mode": "find",
            "terms": ["Schwab"],
            "term_groups": [["Schwab"]],
            "subject_scope": "specific_records",
            "subject_complete": True,
            "file_kind": "any",
            "time_intent": "document_coverage",
        }

    return plan


def documents_model(calls, *, adversarial=False):
    """Honest: only text-proven September statements are included. Adversarial: also
    includes the 2014-2016 history and the undated notes (the 13-Oct failure)."""

    async def assess(*, prompt, user_id):
        calls.append("assess_documents")
        payload = json.loads(prompt)
        answers = []
        for source in payload["retrieved_documents"]["untrusted_external_content"]:
            ref, source_ref, text = source["document_ref"], source["source_ref"], source["text"]
            if SEPT in text:
                answers.append(
                    {
                        "document_ref": ref,
                        "decision": "include",
                        "confidence": 90,
                        "reason": "September 2026 Schwab statement.",
                        "citations": [{"source_ref": source_ref, "quote": SEPT}],
                        "covered_periods": [
                            {
                                "period_start": "2026-09-01",
                                "period_end": "2026-09-30",
                                "source_refs": [source_ref],
                            }
                        ],
                    }
                )
            elif HISTORY in text:
                answers.append(
                    {
                        "document_ref": ref,
                        "decision": "include" if adversarial else "exclude",
                        "confidence": 60,
                        "reason": "Account history from 2014 to 2016.",
                        "citations": [{"source_ref": source_ref, "quote": HISTORY}],
                        "covered_periods": [
                            {
                                "period_start": "2014-01-01",
                                "period_end": "2016-12-31",
                                "source_refs": [source_ref],
                            }
                        ],
                    }
                )
            elif SUMMARY in text:
                answers.append(
                    {
                        "document_ref": ref,
                        "decision": "include" if adversarial else "exclude",
                        "confidence": 20,
                        "reason": "Only the file name names the issuer.",
                        "citations": [{"source_ref": source_ref, "quote": SUMMARY}],
                        "covered_periods": [],
                    }
                )
            else:
                answers.append(
                    {
                        "document_ref": ref,
                        "decision": "include" if adversarial else "exclude",
                        "confidence": 30,
                        "reason": "Notes, not a statement.",
                        "citations": [{"source_ref": source_ref, "quote": "Schwab brokerage"}],
                        "covered_periods": [],
                    }
                )
        return {"documents": answers}

    return assess


def package_model(calls):
    async def assess(*, prompt, user_id):
        calls.append("assess_package")
        payload = json.loads(prompt)
        refs = [
            item["document_ref"]
            for item in payload["document_assessments"]
            if item["decision"] == "include"
        ]
        if not refs:
            return {
                "decision": "no_match",
                "coverage_status": "unknown",
                "selected_document_refs": [],
                "confidence": 80,
                "importance": 1,
                "suggested_price_cents": 50,
                "rationale": "Nothing matched.",
                "coverage_summary": "No matching statements.",
                "gaps": [],
            }
        return {
            "decision": "partial",
            "coverage_status": "partial",
            "selected_document_refs": refs,
            "confidence": 70,
            "importance": 40,
            "suggested_price_cents": 300,
            "rationale": "Two monthly statements.",
            "coverage_summary": "Schwab statements for September 2026.",
            "gaps": ["October 1 to 9 is not covered."],
        }

    return assess


async def no_packet_model(*, prompt, user_id, output_schema):
    raise AssertionError("no packet check is expected on the provider route")


class SyntheticCredential:
    owner_id = OWNER

    def __init__(self, database):
        self.database = database

    async def row(self):
        return dict(self.database.connection_row)

    async def current(self):
        return dict(self.database.connection_row), {
            "accessToken": "synthetic-access-token",
            "accountLabel": ACCOUNT,
            "profile": "live",
        }


@pytest.fixture
def engine_env(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    for name in ("GOOGLE_DRIVE_LIVE", "DRIVE_DOCUMENT_INDEXING", "DRIVE_DOCUMENT_SHARING"):
        monkeypatch.setenv(name, "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", OWNER)
    monkeypatch.delenv("CONNECTOR_UAT_ALL_USERS", raising=False)
    monkeypatch.delenv("DRIVE_WORK_DRAIN_ENABLED", raising=False)
    monkeypatch.setenv(
        "DRIVE_DOCUMENT_KEY_V1", base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()
    )


def build_runtime(tmp_path, *, adversarial=False):
    database = ScriptedDb()
    log = DriveLog()
    calls = []
    runtime = ask.EngineRuntime(
        owner_id=OWNER,
        db=ask.ReadOnlyDb(database, OWNER, cursor_guard=False),
        credential=SyntheticCredential(database),
        interpreters=ask.Interpreters(
            planner=planner(calls),
            document=documents_model(calls, adversarial=adversarial),
            package=package_model(calls),
            packet=no_packet_model,
        ),
        engine={
            "deployed_revision": "synthetic-revision",
            "deployed_sha": "a" * 40,
            "engine_sha": "a" * 40,
            "match": True,
            "differing_files": [],
        },
        model="gemini-3.6-flash",
        agent_packages_enabled=True,
        http_transport=drive_transport(log),
        private_dir=tmp_path / "private",
    )
    return runtime, database, log, calls


def run_session(runtime):
    ask_input = ask.parse_ask(PROMPT, *WINDOW, as_of="2026-10-13")
    session = ask.AskSession(runtime, ask_input, limits=runtime.limits)
    return session, asyncio.run(session.run())


def by_name(result):
    return {row["file_name"]: row for row in result["documents"]}


# --- End to end -------------------------------------------------------------------------
def test_dry_run_enters_the_real_engine_and_writes_nothing(engine_env, tmp_path):
    from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
    from hushh_mcp.services.drive_request_bulk_service import DriveRequestBulkService
    from hushh_mcp.services.drive_request_package_service import DriveRequestPackageService

    runtime, database, log, calls = build_runtime(tmp_path)
    session, result = run_session(runtime)

    assert result["outcome"] == {"status": "completed", "code": None}, result["errors"]
    # The entry point is the production one, reached through the production classes.
    assert ask.entry_point() is DriveRequestBulkService.start_search
    assert ask.entry_point().__module__ == "hushh_mcp.services.drive_request_bulk_service"
    assert ask.entry_point().__qualname__ == "DriveRequestBulkService.start_search"
    assert type(session.bulk) is DriveRequestBulkService
    assert type(session.packages) is DriveRequestPackageService
    assert isinstance(session.search, DriveOwnerSearchService)
    assert result["engine"]["entry_point"] == ask.ENTRY_POINT
    assert result["engine"]["dry_run"] is True and result["engine"]["mode"] == "deployed"
    assert result["engine"]["authority_mode"] == "agent_package"
    assert result["understood"]["route"] == "provider"
    assert result["understood"]["terms"] == ["Schwab"]

    # Zero write statements reached the database; the production placeholder upsert
    # was intercepted (elided) instead, and every transaction was rolled back.
    assert database.writes == []
    stats = runtime.db.stats.public()
    assert stats["writes_sent"] == 0 and stats["refused"] == 0
    assert stats["elided"] >= 1 and stats["locks_stripped"] >= 1
    assert database.rollbacks == stats["transactions"] > 0
    assert all(
        " FOR UPDATE" not in sql and " FOR SHARE" not in sql for sql, _ in database.statements
    )
    reads = [
        (sql, params)
        for sql, params in database.statements
        if sql.startswith(("SELECT", "WITH")) and "external_mcp_connectors" not in sql
    ]
    assert reads and all(
        OWNER in json.dumps(params, default=str)
        or sql == "SELECT clock_timestamp()"
        or sql.startswith("SELECT current_setting")
        for sql, params in reads
    )

    # Google Drive: GET only, Drive v3 only.
    assert log.methods and set(log.methods) == {"GET"}
    assert all(path.startswith("/drive/v3/") for path in log.paths)
    assert result["drive_api"]["summary"]["by_operation"]["about"] == 1

    # Model calls: one plan, one document batch, one package check; one at a time.
    assert calls == ["plan", "assess_documents", "assess_package"]
    assert result["model_calls"] == 3 and result["est_cost_usd"] > 0

    # The private trace is saved 0600 in a 0700 directory, never in the repository.
    saved = tmp_path / "private" / "asks" / f"{result['ask_id']}.json"
    assert saved.is_file() and oct(saved.stat().st_mode & 0o777) == "0o600"
    assert oct((tmp_path / "private").stat().st_mode & 0o777) == "0o700"
    assert ask.load_ask(tmp_path / "private", result["ask_id"])["ask_id"] == result["ask_id"]


def test_filename_without_the_words_is_still_considered(engine_env, tmp_path):
    runtime, _, _, _ = build_runtime(tmp_path)
    _, result = run_session(runtime)
    rows = {row["file_name"]: row for row in result["drive_api"]["rows"]}
    assert rows["Scan_0042.txt"]["kept"] is True
    assert rows["Scan_0042.txt"]["drop_reason"] is None
    scan = by_name(result)["Scan_0042.txt"]
    assert "filename_lacks_request_words" in scan["flags"]
    assert scan["evaluated"] is True and scan["decision"] == "include"
    assert scan["selected"] is True and scan["claimed"] is True
    assert scan["period_start"] == "2026-09-01" and scan["evidence_quote"] == SEPT
    assert result["pattern_13oct"]["filename_rule_drops"] == 0
    assert result["rejected_by_reason"].get("filename_rule", 0) == 0


def test_modified_time_alone_never_counts_as_a_proven_match(engine_env, tmp_path):
    runtime, _, _, _ = build_runtime(tmp_path)
    _, result = run_session(runtime)
    documents = by_name(result)
    notes = documents["Schwab notes.txt"]
    assert "modified_in_window" in notes["flags"]
    assert "dated_only_by_modified_time" in notes["flags"]
    assert notes["selected"] is False and notes["claimed"] is False
    history = documents["Schwab brokerage history.txt"]
    assert history["selected"] is False
    assert "content_period_outside_window" in history["flags"]
    assert history["period_start"] == "2014-01-01"
    review = result["owner_review"]
    assert sorted(item["file_name"] for item in review["files"]) == [
        "Scan_0042.txt",
        "Schwab statement 2026-09.txt",
    ]
    assert review["would_allow_now"] is True and review["price_cents"] == 300
    assert review["coverage_sentence"] == "Covers Sep 1, 2026 to Sep 30, 2026"
    assert result["counts"]["claimed"] == result["counts"]["selected"] == 2
    assert result["pattern_13oct"]["verdict"] == "not_seen"
    assert result["pattern_13oct"]["reappeared"] is False
    statuses = {item["name"]: item["status"] for item in result["buyer_checks"]}
    assert statuses["requester_google_identity"] == "skipped_in_dry_run"
    assert statuses["checkout_and_payment"] == "skipped_in_dry_run"
    assert statuses["owner_drive_identity"] == "passed"


def test_engine_selection_by_modified_time_is_flagged_not_claimed(engine_env, tmp_path):
    runtime, database, _, _ = build_runtime(tmp_path, adversarial=True)
    _, result = run_session(runtime)
    documents = by_name(result)
    notes = documents["Schwab notes.txt"]
    assert notes["selected"] is True, "the engine's own choice is shown as it is"
    assert notes["claimed"] is False and notes["period_proven"] is False
    assert {"selected_only_by_modified_time", "selected_period_not_proven"} <= set(notes["flags"])
    # The notes' cited text says "Schwab"; the title-only file's never does.
    assert "selected_by_filename_only" not in notes["flags"]
    title_only = documents["Schwab 2026 statement.txt"]
    assert title_only["selected"] is True and title_only["claimed"] is False
    assert "selected_by_filename_only" in title_only["flags"]
    assert "selected_only_by_modified_time" not in title_only["flags"]
    history = documents["Schwab brokerage history.txt"]
    assert history["claimed"] is False
    assert "selected_period_outside_window" in history["flags"]
    pattern = result["pattern_13oct"]
    assert pattern["reappeared"] is True and pattern["verdict"] == "reappeared"
    # Both were edited inside the window and neither text proves a date inside it:
    # the history file is the 13-Oct shape (2014-2016 content, edited in Oct 2026).
    assert pattern["selected_only_by_modified_time"] == 2
    assert "selected_only_by_modified_time" in history["flags"]
    assert pattern["selected_by_filename_only"] == 1
    assert result["counts"]["selected"] == 5 and result["counts"]["claimed"] == 2
    summary = ask.ask_summary(result)
    assert len(summary["claimed"]) == 2 and summary["pattern_13oct_reappeared"] is True
    assert database.writes == []


def test_model_cap_stops_the_engine_and_reports_unchecked(engine_env, tmp_path):
    runtime, database, _, calls = build_runtime(tmp_path)
    ask_input = ask.parse_ask(PROMPT, *WINDOW, as_of="2026-10-13")
    session = ask.AskSession(runtime, ask_input, limits=ask.AskLimits(max_model_calls=1))
    result = asyncio.run(session.run())
    assert result["outcome"]["status"] == "capped"
    assert calls == ["plan"]
    assert result["model"]["capped"] == "max_model_calls"
    assert {row["decision"] for row in result["documents"]} == {"not_evaluated"}
    assert result["pattern_13oct"]["verdict"] == "not_determinable"
    assert database.writes == []


def test_undated_ask_is_refused_by_the_engine_without_model_calls(engine_env, tmp_path):
    runtime, database, _, calls = build_runtime(tmp_path)
    result = asyncio.run(ask.run_ask(runtime, PROMPT))
    assert result["outcome"]["status"] in {"error", "refused"}
    assert "date_range_required" in result["outcome"]["code"]
    assert calls == [] and database.writes == []


# --- Read-only guard --------------------------------------------------------------------
@pytest.mark.parametrize(
    "sql",
    [
        "INSERT INTO drive_owner_search_jobs(job_id) VALUES(:job)",
        "UPDATE drive_share_requests SET status='approved' WHERE user_id=:user",
        "DELETE FROM drive_owner_search_results WHERE user_id=:user",
        "WITH x AS (UPDATE connected_documents SET status='ready' WHERE user_id=:user "
        "RETURNING 1) SELECT * FROM x",
        "SELECT 1 WHERE :user IS NOT NULL; DELETE FROM connected_documents",
        "SELECT pg_advisory_xact_lock(1) WHERE :user IS NOT NULL",
        "SELECT nextval('seq') WHERE :user IS NOT NULL",
    ],
)
def test_guard_refuses_every_write(sql):
    with pytest.raises(ReadOnlyViolation):
        ask.classify_statement(sql, {"user": OWNER}, OWNER)
    with pytest.raises(ReadOnlyViolation):
        ask.check_cursor_statement(sql, {"user": OWNER}, OWNER)


def test_guard_strips_row_locks_and_elides_only_the_owner_no_ops():
    action, sql = ask.classify_statement(
        "SELECT * FROM drive_collection_sync WHERE user_id=:user FOR UPDATE", {"user": OWNER}, OWNER
    )
    assert action == "read" and "FOR UPDATE" not in sql
    action, sql = ask.classify_statement(
        "SELECT d.* FROM connected_documents d JOIN drive_document_facts f ON f.document_id=d.document_id"
        " WHERE d.user_id=:user FOR SHARE OF d,f",
        {"user": OWNER},
        OWNER,
    )
    assert action == "read" and "FOR SHARE" not in sql
    upsert = (
        "INSERT INTO user_external_connector_connections (user_id, connector_id, status)\n"
        "  VALUES (:user_id, :connector_id, 'revoked')\n"
        "  ON CONFLICT (user_id, connector_id) DO NOTHING"
    )
    assert (
        ask.classify_statement(upsert, {"user_id": OWNER, "connector_id": "google_drive"}, OWNER)[0]
        == "elide"
    )
    with pytest.raises(ask.OwnerMismatch):
        ask.classify_statement(upsert, {"user_id": OTHER, "connector_id": "google_drive"}, OWNER)
    advisory = (
        "WITH ordered_users AS MATERIALIZED ( SELECT user_id FROM UNNEST(CAST(:user_ids AS TEXT[])) "
        "AS item(user_id) ORDER BY user_id ) SELECT pg_advisory_xact_lock( hashtextextended(user_id, "
        ":lock_namespace) ) FROM ordered_users ORDER BY user_id"
    )
    assert ask.classify_statement(advisory, {"user_ids": [OWNER], "lock_namespace": 7}, OWNER)[
        0
    ] == ("elide")
    with pytest.raises(ask.OwnerMismatch):
        ask.classify_statement(advisory, {"user_ids": [OTHER, OWNER], "lock_namespace": 7}, OWNER)


def test_guard_requires_the_owner_id_on_every_owner_read():
    with pytest.raises(ask.OwnerMismatch):
        ask.classify_statement(
            "SELECT * FROM connected_documents WHERE user_id=:user", {"user": OTHER}, OWNER
        )
    with pytest.raises(ask.OwnerMismatch):
        ask.classify_statement("SELECT count(*) FROM connected_documents", None, OWNER)
    with pytest.raises(ask.OwnerMismatch):
        ask.check_cursor_statement(
            "SELECT * FROM connected_documents WHERE user_id=%(user)s", {"user": OTHER}, OWNER
        )
    registry = "SELECT * FROM external_mcp_connectors WHERE connector_id='google_drive' FOR SHARE"
    assert ask.classify_statement(registry, {}, OWNER)[0] == "read"
    ask.check_cursor_statement(
        "SELECT * FROM external_mcp_connectors WHERE connector_id='google_drive'", {}, OWNER
    )


def test_cursor_guard_blocks_writes_before_the_database():
    sqlalchemy = pytest.importorskip("sqlalchemy")
    engine = sqlalchemy.create_engine("sqlite://")
    stats = ask.DbStats()
    ask.install_cursor_guard(engine, OWNER, stats)
    with engine.connect() as connection:
        value = connection.execute(sqlalchemy.text("SELECT :user AS owner"), {"user": OWNER})
        assert value.scalar_one() == OWNER
        with pytest.raises(ReadOnlyViolation):
            connection.execute(sqlalchemy.text("CREATE TABLE t (user_id TEXT)"))
        with pytest.raises(ReadOnlyViolation):
            connection.execute(sqlalchemy.text("SELECT :user AS owner"), {"user": OTHER})
    assert stats.refused == 2
    with pytest.raises(ask.OwnerMismatch):
        ask.install_cursor_guard(engine, OTHER, stats)


def test_guarded_connection_refuses_commit_and_raw_sql():
    database = ScriptedDb()
    db = ask.ReadOnlyDb(database, OWNER, cursor_guard=False)
    with db.engine.begin() as connection:
        with pytest.raises(ReadOnlyViolation):
            connection.commit()
        with pytest.raises(ReadOnlyViolation):
            connection.exec_driver_sql("DELETE FROM connected_documents")
        with pytest.raises(ReadOnlyViolation):
            connection.execute(
                "UPDATE connected_documents SET status='x' WHERE user_id=:user", {"user": OWNER}
            )
    assert database.writes == [] and database.rollbacks == 1
    with pytest.raises(ReadOnlyViolation):
        db.execute_raw("SELECT 1")


def test_production_index_read_runs_through_the_guard(engine_env):
    from hushh_mcp.services.drive_document_facts_store import DriveDocumentFactsStore

    database = ScriptedDb(
        collection={
            "user_id": OWNER,
            "connection_generation": 3,
            "processing_enabled": True,
            "disclosure_version": "live-drive-collection-v1",
            "revision": 5,
            "last_synced_at": datetime.now(UTC),
            "initial_completed_at": datetime.now(UTC),
            "phase": "changes",
            "incomplete_search": False,
            "last_error_code": None,
        }
    )
    db = ask.ReadOnlyDb(database, OWNER, cursor_guard=False)
    status = asyncio.run(DriveDocumentFactsStore(db=db).current_index_status(owner_user_id=OWNER))
    assert status["discovered"] == 0 and status["complete"] is True
    assert database.writes == [] and db.stats.elided >= 1 and db.stats.locks_stripped >= 1
    assert all("FOR UPDATE" not in sql and "FOR SHARE" not in sql for sql, _ in database.statements)


# --- Drive and identity fences ------------------------------------------------------------
def test_drive_client_is_get_only_and_drive_only():
    seen = []

    def handler(request):
        seen.append(request.method)
        return httpx.Response(200, json={})

    async def scenario():
        client = ask.get_only_client(httpx.MockTransport(handler))
        try:
            await client.get("https://www.googleapis.com/drive/v3/files")
            with pytest.raises(ReadOnlyViolation):
                await client.post("https://www.googleapis.com/drive/v3/files", json={})
            with pytest.raises(ReadOnlyViolation):
                await client.patch("https://www.googleapis.com/drive/v3/files/abc", json={})
            with pytest.raises(ReadOnlyViolation):
                await client.get("https://example.com/drive/v3/files")
        finally:
            await client.aclose()

    asyncio.run(scenario())
    assert seen == ["GET"]


def test_drive_credential_and_stores_refuse_another_owner(engine_env, tmp_path):
    database = ScriptedDb()
    oauth = ask.ReadOnlyDriveOAuth(SyntheticCredential(database))
    with pytest.raises(ask.OwnerMismatch):
        asyncio.run(oauth.current_credential(user_id=OTHER, required_profile="live"))
    with pytest.raises(ask.OwnerMismatch):
        asyncio.run(oauth.read(user_id=OTHER, connector_id="google_drive"))
    trace = ask.AskTrace()
    fence = ask.IndexFence(None, OWNER, mode="frozen", trace=trace)
    store = ask.DryRunSearchStore(owner_id=OWNER, generation=3, trace=trace, fence=fence)
    with pytest.raises(ask.OwnerMismatch):
        asyncio.run(store.by_client(user_id=OTHER, client_request_id="x"))
    with pytest.raises(ReadOnlyViolation):
        asyncio.run(ask.RefusingWriter().share_file())


def test_identity_mismatch_stops_before_any_search(engine_env, tmp_path):
    runtime, database, log, calls = build_runtime(tmp_path)
    runtime.expected_account_label = "someone-else@example.test"
    result = asyncio.run(ask.run_ask(runtime, PROMPT, *WINDOW))
    assert result["outcome"] == {"status": "refused", "code": "drive_identity_mismatch"}
    assert calls == [] and "/drive/v3/files" not in log.paths


def test_hosted_environment_is_refused(engine_env, tmp_path, monkeypatch):
    runtime, _, log, calls = build_runtime(tmp_path)
    monkeypatch.setenv("ENVIRONMENT", "uat")
    result = asyncio.run(ask.run_ask(runtime, PROMPT, *WINDOW))
    assert result["outcome"]["status"] == "refused"
    assert "dry_run_requires_non_hosted_environment" in result["outcome"]["code"]
    assert calls == [] and log.paths == []


# --- Presets, input and engine identity -----------------------------------------------------
def test_presets_replay_the_demo_and_end_today():
    items = ask.presets(date(2026, 10, 16))
    assert [item["id"] for item in items] == [
        "demo-2026-10-13-last-month",
        "demo-2026-10-13-schwab",
        "six-months-to-today",
        "eight-months-to-today",
    ]
    first, second, six, eight = items
    assert first["prompt"] == "Last months brokerage statements" and first["as_of"] == "2026-10-13"
    assert (second["period_start"], second["period_end"]) == ("2026-09-01", "2026-10-09")
    assert second["prompt"] == PROMPT
    assert (six["period_start"], six["period_end"]) == ("2026-04-16", "2026-10-16")
    assert (eight["period_start"], eight["period_end"]) == ("2026-02-16", "2026-10-16")
    assert all(
        set(item) == {"id", "label", "prompt", "period_start", "period_end", "as_of"}
        for item in items
    )


def test_ask_input_uses_the_request_contract():
    parsed = ask.parse_ask("  I need statements  ", "2026-01-01", "2026-02-01", as_of="2026-10-13")
    assert parsed.prompt == "I need statements"
    assert parsed.purpose == {
        "purpose": "I need statements",
        "periodStart": "2026-01-01",
        "periodEnd": "2026-02-01",
    }
    for bad in (("", None, None), ("x", "2026-02-01", "2026-01-01"), ("x", "2026-01-01", None)):
        with pytest.raises(ask.AskRefused):
            ask.parse_ask(*bad)
    with pytest.raises(ask.AskRefused):
        ask.AskLimits().bounded(max_model_calls=0)


def test_engine_identity_compares_the_engine_tree_with_the_deployed_sha(tmp_path):
    repo = tmp_path / "repo"
    path = repo / "consent-protocol/hushh_mcp/services"
    path.mkdir(parents=True)
    entry = path / "drive_request_bulk_service.py"
    entry.write_text(
        "class DriveRequestBulkService:\n    async def start_search(self):\n        pass\n"
    )

    def git(*args):
        return subprocess.run(  # noqa: S603 - fixed local git commands in a temp repository
            ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", *args],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    git("init", "-q")
    git("add", "-A")
    git("commit", "-q", "-m", "engine")
    deployed = git("rev-parse", "HEAD")
    same = ask.engine_identity(deployed_revision="rev-1", deployed_sha=deployed, root=repo)
    assert same["match"] is True and same["differing_files"] == []
    assert same["entry_point_at_deployed_sha"] is True and same["engine_sha"] == deployed
    entry.write_text(entry.read_text() + "# local change\n")
    changed = ask.engine_identity(deployed_revision="rev-1", deployed_sha=deployed, root=repo)
    assert changed["match"] is False
    assert changed["differing_files"] == [
        "consent-protocol/hushh_mcp/services/drive_request_bulk_service.py"
    ]
    unknown = ask.engine_identity(deployed_revision="rev-1", deployed_sha="b" * 40, root=repo)
    assert unknown["match"] is False and unknown["reason"] == "deployed_sha_not_fetched"


def test_owner_id_comes_only_from_the_eval_configuration(tmp_path, monkeypatch):
    founder = tmp_path / "founder.json"
    founder.write_text(
        json.dumps({"identities": {"owner": {"user_id": OWNER}, "recipient": {"user_id": OTHER}}})
    )
    live_env = tmp_path / "live-env.sh"
    live_env.write_text(
        'export DRIVE_PACKET_EVAL_OWNER="$(python3 -c \'import json;print(json.load(open("'
        + str(founder)
        + '"))["identities"]["owner"]["user_id"])\')"\n'
    )
    monkeypatch.delenv("DRIVE_PACKET_EVAL_OWNER", raising=False)
    assert ask.resolve_owner_id(live_env) == OWNER
    monkeypatch.setenv("DRIVE_PACKET_EVAL_OWNER", OWNER)
    assert ask.resolve_owner_id(tmp_path / "missing.sh") == OWNER
    monkeypatch.delenv("DRIVE_PACKET_EVAL_OWNER")
    with pytest.raises(ask.AskRefused):
        ask.resolve_owner_id(tmp_path / "missing.sh")


def test_watchdog_wakes_a_stalled_database_read():
    import socket
    from types import SimpleNamespace

    left, right = socket.socketpair()

    class StalledRaw:
        connection = SimpleNamespace(dbapi_connection=SimpleNamespace(fileno=left.fileno))

        def exec_driver_sql(self, *_args, **_kwargs):
            return Result([])

        def execute(self, *_args, **_kwargs):
            return Result([{"value": "on"}])

        def rollback(self):
            pass

    class Engine:
        @contextlib.contextmanager
        def connect(self):
            yield StalledRaw()

    stats = ask.DbStats()
    engine = ask.GuardedEngine(Engine(), OWNER, stats, deadline=0.2)
    try:
        with engine.begin():
            # A read on a dead link would block forever; the watchdog shuts it down.
            assert left.recv(1) == b""
    finally:
        left.close()
        right.close()
    assert stats.watchdog_closed == 1
