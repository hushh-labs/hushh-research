"""Dry-run a buyer's "Request files" ask on the deployed engine, for the dashboard's one owner.

Chris (simulated) asks; Manish's Agent One answers with the code UAT serves. The dry
run calls the entry point the Drive worker calls for an agent-package request,
``DriveRequestBulkService.start_search`` (reached from
``DriveTrustedAutoService.start_pending``), continues the durable search with
``DriveOwnerSearchService.run_one`` as ``DriveOwnerSearchWorker`` does, and evaluates
the package with ``DriveRequestPackageService.run_one`` as ``DriveSuggestionWorker``
does. The services, planner, filters, assessors, validators and disclosure are the
production ones, imported from the checked-out engine and compared with the SHA UAT
serves.

Nothing is written to UAT, Drive or Stripe:

- request, search-job, evaluation and package state live in memory. The ``DryRun*``
  stores implement the store methods those services call and reuse the pure functions
  beneath the production writes (``view``, ``_bounded_selection``, the observation
  validator, ``PackageAssessment``, ``_public_package``, ``build_package_disclosure``);
- UAT reads use the production read stores through ``ReadOnlyDb``: one read-only
  transaction per read, asserted read-only; row-lock clauses are stripped, the
  connection-row placeholder upsert and the graph advisory lock are elided, and any
  other statement is refused unless it is a plain read carrying the owner id (or one of
  two global reads). A cursor-level guard repeats the check;
- Google Drive is read with GET only, with the owner's own credential refreshed in
  memory, after ``/about`` proves it is the owner's account;
- model calls go through the engine's own interpreter seams, one at a time, capped per
  ask, with estimated cost;
- wake-ups are no-ops (``ENVIRONMENT`` is never ``uat`` or ``production`` here), and no
  request row, search job, notification, payment or share is created.

The full trace (file names, quotes, logs) is private: it is saved only in the 0700
dashboard directory and shown only on the local dashboard.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import copy
import functools
import hashlib
import inspect
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

from hushh_eval.drive_packets.privacy import PrivateWorkdir
from hushh_eval.drive_packets.sources import ReadOnlyViolation, assert_read_only
from hushh_eval.drive_packets.usage import (
    Budget,
    BudgetExhausted,
    estimate_tokens,
    load_pricing,
    usage_row,
)

OWNER_LABEL = "Manish"
AS_BUYER = "Chris (simulated)"
SIMULATED_BUYER_ID = "dry-run-simulated-buyer"
ENTRY_MODULE = "hushh_mcp.services.drive_request_bulk_service"
ENTRY_QUALNAME = "DriveRequestBulkService.start_search"
ENTRY_POINT = f"{ENTRY_MODULE}:{ENTRY_QUALNAME}"
CONTINUATIONS = (
    "hushh_mcp.services.drive_owner_search_service:DriveOwnerSearchService.run_one",
    "hushh_mcp.services.drive_request_package_service:DriveRequestPackageService.run_one",
)
ENGINE_TREE = "consent-protocol/hushh_mcp"
DEFAULT_PRIVATE_DIR = Path(
    "/Volumes/AnkitSSD/DevCache/drive-packets-real-eval-20261014-private/dashboard"
)
LIVE_ENV_FILE = Path("/Volumes/AnkitSSD/DevCache/p0-20261015/drive-eval-scratch/live-env.sh")
MAX_PROMPT_CHARS = 2048
DEMO_DAY = "2026-10-13"
ASK_ID = re.compile(r"^ask-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$")


class AskRefused(ValueError):
    """The ask was refused before the engine ran; ``code`` is a fixed code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class ModelCapReached(BudgetExhausted):
    """The per-ask model-call or cost cap stopped the engine; the rest is reported."""


class OwnerMismatch(ReadOnlyViolation):
    """Something tried to act for a user other than the dashboard's owner."""


@dataclass(frozen=True)
class AskLimits:
    """Per-ask caps. Model calls run one at a time; the caps stop the engine early."""

    max_model_calls: int = 40
    max_cost_usd: float = 2.0
    max_search_slices: int = 120
    max_seconds: float = 1500.0

    def bounded(self, *, max_model_calls: int | None = None) -> AskLimits:
        if max_model_calls is None:
            return self
        if type(max_model_calls) is not int or not 1 <= max_model_calls <= 400:
            raise AskRefused("max_model_calls_invalid")
        return AskLimits(
            max_model_calls=max_model_calls,
            max_cost_usd=self.max_cost_usd,
            max_search_slices=self.max_search_slices,
            max_seconds=self.max_seconds,
        )


# --- Presets --------------------------------------------------------------------------
def _months_before(day: date, months: int) -> date:
    """The production month window (``compile_request_queries``): same day N months back."""
    from calendar import monthrange

    index = day.year * 12 + day.month - 1 - months
    year, month = divmod(index, 12)
    month += 1
    return date(year, month, min(day.day, monthrange(year, month)[1]))


def presets(today: date | None = None) -> list[dict]:
    """The two asks from the 13 Oct demo, then two asks that end today."""
    today = today or datetime.now(UTC).date()
    return [
        {
            "id": "demo-2026-10-13-last-month",
            "label": "13 Oct demo: Last months brokerage statements (Sep 1 to Oct 12)",
            "prompt": "Last months brokerage statements",
            "period_start": "2026-09-01",
            "period_end": "2026-10-12",
            "as_of": DEMO_DAY,
        },
        {
            "id": "demo-2026-10-13-schwab",
            "label": "13 Oct demo: Schwab brokerage statements from 2026 (Sep 1 to Oct 9)",
            "prompt": "all brokerage statements that contains Schwab from 2026",
            "period_start": "2026-09-01",
            "period_end": "2026-10-09",
            "as_of": DEMO_DAY,
        },
        {
            "id": "six-months-to-today",
            "label": "Six months of financial statements, ending today",
            "prompt": "I need six months of financial statements",
            "period_start": _months_before(today, 6).isoformat(),
            "period_end": today.isoformat(),
            "as_of": today.isoformat(),
        },
        {
            "id": "eight-months-to-today",
            "label": "Eight months of financial statements, ending today",
            "prompt": "I need eight months of financial statements",
            "period_start": _months_before(today, 8).isoformat(),
            "period_end": today.isoformat(),
            "as_of": today.isoformat(),
        },
    ]


def preset(preset_id: str, today: date | None = None) -> dict:
    for item in presets(today):
        if item["id"] == preset_id:
            return item
    raise AskRefused("preset_unknown")


# --- Ask input ------------------------------------------------------------------------
@dataclass(frozen=True)
class AskInput:
    prompt: str
    period_start: str | None
    period_end: str | None
    as_of: datetime
    time_zone: str = "UTC"

    @property
    def purpose(self) -> dict:
        return {
            "purpose": self.prompt,
            "periodStart": self.period_start,
            "periodEnd": self.period_end,
        }


def parse_ask(prompt, period_start=None, period_end=None, *, as_of=None) -> AskInput:
    """Validate an ask with the request contract the app's API uses."""
    from hushh_mcp.services.drive_sharing_contract import ShareRequestPurpose

    if not isinstance(prompt, str) or not prompt.strip():
        raise AskRefused("prompt_required")
    prompt = prompt.strip()
    if len(prompt) > MAX_PROMPT_CHARS or len(prompt.encode()) > MAX_PROMPT_CHARS:
        raise AskRefused("prompt_too_long")
    try:
        purpose = ShareRequestPurpose(
            purpose=prompt, periodStart=period_start or None, periodEnd=period_end or None
        )
    except ValueError:
        raise AskRefused("period_invalid") from None
    if as_of is None:
        moment = datetime.now(UTC)
    elif isinstance(as_of, datetime):
        moment = as_of if as_of.tzinfo else as_of.replace(tzinfo=UTC)
    else:
        try:
            moment = datetime.combine(date.fromisoformat(str(as_of)), datetime.min.time(), UTC)
        except ValueError:
            raise AskRefused("as_of_invalid") from None
    return AskInput(
        prompt=purpose.purpose,
        period_start=purpose.periodStart,
        period_end=purpose.periodEnd,
        as_of=moment.astimezone(UTC),
    )


# --- Engine identity ------------------------------------------------------------------
def _git(root: Path, *args: str) -> tuple[int, str]:
    result = subprocess.run(  # noqa: S603 - fixed git read commands, local repository only
        ["git", *args], cwd=root, capture_output=True, text=True, check=False, timeout=60
    )
    return result.returncode, result.stdout.strip()


def engine_root() -> Path:
    """The checkout whose ``hushh_mcp`` this process imports (the engine that runs)."""
    from hushh_mcp.services import drive_request_bulk_service

    here = Path(inspect.getfile(drive_request_bulk_service)).resolve().parent
    code, top = _git(here, "rev-parse", "--show-toplevel")
    if code:
        raise RuntimeError("engine_checkout_not_git")
    return Path(top)


def engine_identity(*, deployed_revision: str | None, deployed_sha: str | None, root=None):
    """Which code runs here, and whether it is byte-for-byte the code UAT serves."""
    root = Path(root) if root else engine_root()
    _, head = _git(root, "rev-parse", "HEAD")
    result = {
        "deployed_revision": deployed_revision,
        "deployed_sha": deployed_sha,
        "engine_sha": head or None,
        "match": False,
        "differing_files": [],
        "entry_point": ENTRY_POINT,
        "entry_point_at_deployed_sha": None,
        "checked_at": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    if not deployed_sha:
        result["reason"] = "deployed_sha_unknown"
        return result
    if _git(root, "cat-file", "-e", f"{deployed_sha}^{{commit}}")[0]:
        result["reason"] = "deployed_sha_not_fetched"
        return result
    _, changed = _git(root, "diff", "--name-only", deployed_sha, "--", ENGINE_TREE)
    _, untracked = _git(root, "ls-files", "--others", "--exclude-standard", "--", ENGINE_TREE)
    differing = sorted({line for line in (changed + "\n" + untracked).splitlines() if line})
    entry_path = ENGINE_TREE + "/services/drive_request_bulk_service.py"
    code, deployed_source = _git(root, "show", f"{deployed_sha}:{entry_path}")
    result["entry_point_at_deployed_sha"] = bool(
        not code and re.search(r"^\s+async def start_search\(", deployed_source, re.M)
    )
    result["differing_files"] = differing
    result["match"] = not differing and result["entry_point_at_deployed_sha"] is True
    if differing:
        result["reason"] = "engine_code_differs_from_deployed"
    return result


def entry_point():
    """The function the dry run enters, imported from the engine (not a copy)."""
    from hushh_mcp.services.drive_request_bulk_service import DriveRequestBulkService

    return DriveRequestBulkService.start_search


# --- Read-only database ---------------------------------------------------------------
_LOCK_CLAUSE = re.compile(
    r"\s+FOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)"
    r"(?:\s+OF\s+[A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*)?"
    r"(?:\s+(?:NOWAIT|SKIP\s+LOCKED))?",
    re.IGNORECASE,
)
_SESSION = re.compile(
    r"^(?:SET LOCAL (?:statement_timeout|lock_timeout) = '\d+(?:ms|s|min)?'"
    r"|SET TRANSACTION READ ONLY"
    r"|SELECT current_setting\('transaction_read_only'\)"
    r"|SHOW transaction_read_only)$",
    re.IGNORECASE,
)
_WRITE_WORDS = re.compile(
    r"\b(?:insert|update|delete|merge|upsert|truncate|drop|alter|create|grant|revoke|copy|"
    r"call|lock|vacuum|analyze|cluster|reindex|refresh|notify|listen|prepare|execute|comment|"
    r"security|import|into|nextval|setval|set_config|dblink\w*|lo_\w+|pg_advisory\w*|"
    r"pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile)\b",
    re.IGNORECASE,
)
_LOCKING_READ = re.compile(r"\bfor\s+(?:no\s+key\s+)?(?:update|share|key\s+share)\b", re.I)
# ExternalConnectorLifecycleStore._lock: a placeholder row for an owner who never
# connected. The owner's row exists (checked before every ask), so it is a no-op.
_PLACEHOLDER_UPSERT = (
    "INSERT INTO user_external_connector_connections (user_id, connector_id, status) "
    "VALUES (:user_id, :connector_id, 'revoked') ON CONFLICT (user_id, connector_id) DO NOTHING"
)
# connection_graph_service.lock_connection_graph_users: a transaction advisory lock.
_ADVISORY_PREFIX = (
    "WITH ordered_users AS MATERIALIZED ( SELECT user_id FROM UNNEST(CAST(:user_ids AS TEXT[]))"
)
# Reads that touch no owner's data: the Drive connector registry row and the clock.
_GLOBAL_READS = frozenset(
    {
        "SELECT * FROM external_mcp_connectors WHERE connector_id='google_drive'",
        "SELECT * FROM external_mcp_connectors WHERE connector_id = 'google_drive'",
        "SELECT clock_timestamp()",
    }
)
_GLOBAL_CURSOR = re.compile(
    r"^SELECT (?:\* FROM external_mcp_connectors WHERE connector_id ?= ?'google_drive'"
    r"|clock_timestamp\(\))$"
)


def _normalized(sql: str) -> str:
    return " ".join(str(sql).split())


def _binds_owner(parameters: Any, owner_id: str) -> bool:
    if isinstance(parameters, dict):
        return any(
            value == owner_id
            or isinstance(value, list | tuple)
            and owner_id in value
            and all(item == owner_id for item in value)
            for value in parameters.values()
        )
    if isinstance(parameters, list | tuple) and parameters:
        if all(isinstance(item, dict) for item in parameters):
            return all(_binds_owner(item, owner_id) for item in parameters)
        return owner_id in parameters
    return False


def classify_statement(sql: str, parameters: Any, owner_id: str) -> tuple[str, str]:
    """Return ``(action, sql)``: ``session``, ``elide`` or ``read`` (locks stripped).

    Anything else raises ``ReadOnlyViolation`` before it reaches the database.
    """
    normalized = _normalized(sql)
    if _SESSION.match(normalized):
        return "session", sql
    if normalized == _PLACEHOLDER_UPSERT:
        if parameters == {"user_id": owner_id, "connector_id": "google_drive"}:
            return "elide", ""
        raise OwnerMismatch("placeholder_upsert_for_another_user")
    if normalized.startswith(_ADVISORY_PREFIX) and "pg_advisory_xact_lock" in normalized:
        users = parameters.get("user_ids") if isinstance(parameters, dict) else None
        if isinstance(users, list | tuple) and list(users) == [owner_id]:
            return "elide", ""
        raise OwnerMismatch("advisory_lock_for_another_user")
    stripped = _LOCK_CLAUSE.sub("", sql)
    body = _normalized(stripped).rstrip("; ")
    if ";" in body:
        raise ReadOnlyViolation("statement_not_single")
    head = body.lstrip("( ").split(" ", 1)[0].upper()
    if head not in {"SELECT", "WITH"} or _WRITE_WORDS.search(body) or _LOCKING_READ.search(body):
        raise ReadOnlyViolation("statement_not_read_only")
    if body in _GLOBAL_READS:
        return "read", stripped
    if not _binds_owner(parameters, owner_id):
        raise OwnerMismatch("statement_not_owner_bound")
    return "read", stripped


def check_cursor_statement(statement: str, parameters: Any, owner_id: str) -> None:
    """Second fence, on the DBAPI cursor: a plain read for the owner, or a session check."""
    normalized = _normalized(statement)
    if _SESSION.match(normalized):
        return
    body = normalized.rstrip("; ")
    head = body.lstrip("( ").split(" ", 1)[0].upper()
    if (
        ";" in body
        or head not in {"SELECT", "WITH"}
        or _WRITE_WORDS.search(body)
        or _LOCKING_READ.search(body)
    ):
        raise ReadOnlyViolation("cursor_statement_not_read_only")
    if not (_binds_owner(parameters, owner_id) or _GLOBAL_CURSOR.match(body)):
        raise OwnerMismatch("cursor_statement_not_owner_bound")


class _NoRows:
    """Result of an elided statement; production code never reads it."""

    def mappings(self):
        return self

    def first(self):
        return None

    def __iter__(self):
        return iter(())


@dataclass
class DbStats:
    reads: int = 0
    sessions: int = 0
    elided: int = 0
    locks_stripped: int = 0
    refused: int = 0
    writes_sent: int = 0
    transactions: int = 0
    watchdog_closed: int = 0
    timeouts_relaxed: int = 0
    errors: Counter = field(default_factory=Counter)
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add(self, name: str, amount: int = 1) -> None:
        with self.lock:
            setattr(self, name, getattr(self, name) + amount)

    def error(self, error: BaseException) -> None:
        """The database error behind a production ``connector_storage_unavailable``."""
        original = getattr(error, "orig", None)
        code = getattr(original, "pgcode", None) or getattr(error, "code", None)
        with self.lock:
            self.errors[f"{type(original or error).__name__}:{code or 'none'}"] += 1

    def public(self) -> dict:
        return {
            key: getattr(self, key)
            for key in (
                "transactions",
                "reads",
                "sessions",
                "elided",
                "locks_stripped",
                "refused",
                "writes_sent",
                "watchdog_closed",
                "timeouts_relaxed",
            )
        } | {"errors": dict(self.errors)}


_STATEMENT_TIMEOUT = re.compile(r"^SET LOCAL statement_timeout = '\d+(?:ms|s|min)?'$", re.I)
RELAXED_STATEMENT_TIMEOUT = "45s"


class GuardedConnection:
    """What a production store sees as its connection: reads for the owner only."""

    def __init__(self, raw, owner_id: str, stats: DbStats):
        self._raw = raw
        self._owner = owner_id
        self._stats = stats

    def execute(self, statement, parameters=None, *args, **kwargs):
        from sqlalchemy import text

        sql = statement if isinstance(statement, str) else str(statement)
        try:
            action, rewritten = classify_statement(sql, parameters, self._owner)
        except ReadOnlyViolation:
            self._stats.add("refused")
            raise
        if action == "elide":
            self._stats.add("elided")
            return _NoRows()
        if action == "session":
            self._stats.add("sessions")
            if _STATEMENT_TIMEOUT.match(_normalized(sql)):
                # UAT bounds each store transaction at 5 s on its in-VPC database link.
                # Through the local proxy the same 71k-row index read streams slower,
                # so the dry run allows RELAXED_STATEMENT_TIMEOUT (a listed deviation).
                self._stats.add("timeouts_relaxed")
                sql = f"SET LOCAL statement_timeout = '{RELAXED_STATEMENT_TIMEOUT}'"
            return self._run(text(sql), parameters, args, kwargs)
        if rewritten != sql:
            self._stats.add("locks_stripped")
        self._stats.add("reads")
        return self._run(text(rewritten), parameters, args, kwargs)

    def _run(self, clause, parameters, args, kwargs):
        try:
            return self._raw.execute(clause, parameters, *args, **kwargs)
        except Exception as error:
            self._stats.error(error)
            raise

    def exec_driver_sql(self, statement, parameters=None, *args, **kwargs):
        if not _SESSION.match(_normalized(statement)):
            self._stats.add("refused")
            raise ReadOnlyViolation("driver_sql_refused")
        self._stats.add("sessions")
        return self._raw.exec_driver_sql(statement, parameters, *args, **kwargs)

    def commit(self):
        raise ReadOnlyViolation("commit_refused")

    def __getattr__(self, name):
        raise ReadOnlyViolation(f"connection_attribute_refused:{name}")


DB_DEADLINE_SECONDS = 60.0


def _shut_socket(raw) -> bool:
    """Wake a read blocked on a dead proxy link: shut the client socket down.

    libpq then fails the statement ("server closed the connection") and the pool drops
    the connection, so one silent network stall cannot hang an ask.
    """
    import socket

    try:
        descriptor = raw.connection.dbapi_connection.fileno()
    except Exception:  # noqa: BLE001 - nothing to wake
        return False
    try:
        with socket.socket(fileno=os.dup(descriptor)) as sock:
            sock.shutdown(socket.SHUT_RDWR)
        return True
    except OSError:
        return False


class GuardedEngine:
    """``engine.begin()`` for production stores: a read-only transaction, always rolled back.

    A transaction that outlives ``deadline`` seconds has its socket shut down by a
    watchdog; the statement fails instead of waiting forever on a dead proxy link.
    """

    def __init__(self, engine, owner_id: str, stats: DbStats, *, deadline=DB_DEADLINE_SECONDS):
        self._engine = engine
        self._owner = owner_id
        self._stats = stats
        self._deadline = deadline

    @contextlib.contextmanager
    def begin(self):
        with self._engine.connect() as raw:

            def expire():
                if _shut_socket(raw):
                    self._stats.add("watchdog_closed")

            watchdog = threading.Timer(self._deadline, expire)
            watchdog.daemon = True
            watchdog.start()
            try:
                raw.exec_driver_sql("SET TRANSACTION READ ONLY")
                assert_read_only(raw)
                self._stats.add("transactions")
                yield GuardedConnection(raw, self._owner, self._stats)
            finally:
                watchdog.cancel()
                try:
                    raw.rollback()
                except Exception:  # noqa: BLE001 - a dead connection is discarded
                    with contextlib.suppress(Exception):
                        raw.invalidate()

    connect = begin

    def __getattr__(self, name):
        raise ReadOnlyViolation(f"engine_attribute_refused:{name}")


def install_cursor_guard(engine, owner_id: str, stats: DbStats) -> None:
    from sqlalchemy import event

    if getattr(engine, "_dry_run_owner", None) not in {None, owner_id}:
        raise OwnerMismatch("engine_bound_to_another_owner")
    if getattr(engine, "_dry_run_owner", None) == owner_id:
        return

    def guard(_connection, _cursor, statement, parameters, _context, _executemany):
        try:
            check_cursor_statement(statement, parameters, owner_id)
        except ReadOnlyViolation:
            stats.add("refused")
            raise

    event.listen(engine, "before_cursor_execute", guard)
    engine._dry_run_owner = owner_id


class ReadOnlyDb:
    """A ``db`` for production stores (they use only ``db.engine.begin()``)."""

    def __init__(self, engine, owner_id: str, *, cursor_guard: bool = True):
        self.owner_id = owner_id
        self.stats = DbStats()
        if cursor_guard:
            install_cursor_guard(engine, owner_id, self.stats)
        self.engine = GuardedEngine(engine, owner_id, self.stats)

    async def read(self, operation):
        """Run ``operation(connection)`` in one guarded read-only transaction."""

        def run():
            with self.engine.begin() as connection:
                return operation(connection)

        return await asyncio.to_thread(run)

    def __getattr__(self, name):
        raise ReadOnlyViolation(f"db_attribute_refused:{name}")


# --- Drive access ---------------------------------------------------------------------
DRIVE_HOST = "www.googleapis.com"
DRIVE_PATH = "/drive/v3/"


def _get_only_transport_class():
    import httpx

    class GetOnlyTransport(httpx.AsyncBaseTransport):
        """Refuses every method but GET, and every URL outside the Drive v3 API."""

        def __init__(self, inner):
            self.inner = inner
            self.requests = 0

        async def handle_async_request(self, request):
            if request.method != "GET":
                raise ReadOnlyViolation(f"drive_method_refused:{request.method}")
            if (
                request.url.scheme != "https"
                or request.url.host != DRIVE_HOST
                or not request.url.path.startswith(DRIVE_PATH)
            ):
                raise ReadOnlyViolation("drive_url_refused")
            self.requests += 1
            return await self.inner.handle_async_request(request)

        async def aclose(self):
            await self.inner.aclose()

    return GetOnlyTransport


def get_only_client(inner=None):
    """An httpx client that can only GET the Drive v3 API."""
    import httpx

    transport = _get_only_transport_class()(inner or httpx.AsyncHTTPTransport())
    return httpx.AsyncClient(transport=transport, timeout=15, follow_redirects=False)


@functools.cache
def _tracing_adapter_class():
    from hushh_mcp.services.google_drive_adapter import DriveReadError, GoogleDriveAdapter

    class TracingDriveAdapter(GoogleDriveAdapter):
        """The production adapter, on a GET-only client, recording every call."""

        def __init__(self, trace, client):
            super().__init__()
            self._trace = trace
            self._guarded = client

        @contextlib.asynccontextmanager
        async def read_session(self):
            if self._read_client.get() is not None:
                yield
                return
            marker = self._read_client.set(self._guarded)
            try:
                yield
            finally:
                self._read_client.reset(marker)

        async def _get_private(self, path, *, access_token, params, limit, resource_keys=None):
            marker = self._read_client.set(self._guarded)
            started = time.perf_counter()
            outcome, body = "error", None
            try:
                body = await super()._get_private(
                    path,
                    access_token=access_token,
                    params=params,
                    limit=limit,
                    **({"resource_keys": resource_keys} if resource_keys else {}),
                )
                outcome = "ok"
                return body
            except DriveReadError as error:
                outcome = str(error)
                raise
            finally:
                self._read_client.reset(marker)
                self._trace.drive_call(
                    path=path,
                    params=dict(params),
                    body=body,
                    ms=(time.perf_counter() - started) * 1000,
                    outcome=outcome,
                )

    return TracingDriveAdapter


class RefusingWriter:
    """The transport's write adapter. The dry run never writes to Drive."""

    def __getattr__(self, name):
        async def refused(*_args, **_kwargs):
            raise ReadOnlyViolation(f"drive_write_refused:{name}")

        return refused


class OwnerCredential:
    """The owner's live Drive credential: read-only row, decrypted and refreshed in memory."""

    TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 - public endpoint

    def __init__(self, *, owner_id, db, client_id, client_secret, refresh=None):
        self.owner_id = owner_id
        self.db = db
        self.client_id = client_id
        self.client_secret = client_secret
        self._refresh = refresh or self._refresh_token
        self._token: tuple[str, datetime] | None = None
        self.refreshes = 0

    async def row(self) -> dict | None:
        from sqlalchemy import text

        def operation(connection):
            found = (
                connection.execute(
                    text(
                        "SELECT * FROM user_external_connector_connections "
                        "WHERE user_id=:user_id AND connector_id='google_drive'"
                    ),
                    {"user_id": self.owner_id},
                )
                .mappings()
                .first()
            )
            return dict(found) if found is not None else None

        return await self.db.read(operation)

    def _refresh_token(self, refresh_token: str) -> tuple[str, int]:
        import httpx

        response = httpx.post(
            self.TOKEN_URL,
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            },
            timeout=30,
        )
        if response.status_code != 200:
            raise RuntimeError("drive_token_refresh_failed")
        body = response.json()
        return body["access_token"], int(body.get("expires_in", 600))

    async def current(self) -> tuple[dict, dict]:
        """The production checks of ``current_credential``, without its writes."""
        from hushh_mcp.services.external_connector_credentials_service import (
            ExternalConnectorCredentialsService,
        )
        from hushh_mcp.services.external_connector_google_oauth import (
            DRIVE_FILE_SCOPE,
            LIVE_SCOPES,
            DriveOAuthError,
        )

        row = await self.row()
        if not row or row["status"] not in {"connected", "verifying"}:
            raise DriveOAuthError("reconnect_required", status_code=401)
        if row["envelope_version"] != 2:
            raise DriveOAuthError("reconnect_required", status_code=401)
        credential = ExternalConnectorCredentialsService(db=self.db).open_credential(
            user_id=self.owner_id, connector_id="google_drive", row=row
        )
        scopes = set(credential.get("grantedScopes", []))
        if credential.get("profile") != "live" or scopes not in (
            set(LIVE_SCOPES),
            set(LIVE_SCOPES) | {DRIVE_FILE_SCOPE},
        ):
            raise DriveOAuthError("reconnect_required", status_code=401)
        if credential.get("oauthClientId") != self.client_id:
            raise DriveOAuthError("reconnect_required", status_code=401)
        now = datetime.now(UTC)
        if row["credential_expires_at"] > now + timedelta(seconds=90):
            return row, credential
        if self._token is None or self._token[1] <= now + timedelta(seconds=90):
            token, seconds = await asyncio.to_thread(self._refresh, credential["refreshToken"])
            self._token = (token, now + timedelta(seconds=seconds))
            self.refreshes += 1
        return row, {**credential, "accessToken": self._token[0]}


class ReadOnlyDriveOAuth:
    """``oauth`` for the transport and the live reader: owner only, no writes."""

    def __init__(self, credential: OwnerCredential):
        self.credential = credential
        self.lifecycle = self

    def _owner(self, user_id):
        if user_id != self.credential.owner_id:
            raise OwnerMismatch("drive_credential_for_another_user")

    async def current_credential(self, *, user_id, required_profile=None):
        self._owner(user_id)
        row, credential = await self.credential.current()
        if required_profile not in {None, credential.get("profile")}:
            from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError

            raise DriveOAuthError("reconnect_required", status_code=401)
        return row, credential

    async def read(self, *, user_id, connector_id, purge=False):
        self._owner(user_id)
        if connector_id != "google_drive":
            raise ReadOnlyViolation("connector_refused")
        return await self.credential.row()


# --- Trace ----------------------------------------------------------------------------
_COUNTER_REASONS = (
    ("excludedByFilenameCount", "filename_rule"),
    ("excludedByKindCount", "file_type_not_requested"),
    ("excludedByNoteTypeCount", "note_type_rule"),
    ("excludedByTopicCount", "folder_child_topic_mismatch"),
    ("excludedByDateCount", "file_date_outside_window"),
    ("excludedFolderTopicCount", "folder_name_not_on_topic"),
    ("invalidMetadataCount", "invalid_metadata"),
    ("unavailableShortcutCount", "shortcut_target_unavailable"),
    ("workLimitReached", "search_work_limit"),
)
FOLDER_MIME = "application/vnd.google-apps.folder"
SHORTCUT_MIME = "application/vnd.google-apps.shortcut"


def _operation(path: str, params: dict) -> str:
    if path == "/files":
        return "list"
    if path == "/drives":
        return "drives"
    if path == "/about":
        return "about"
    if path.endswith("/export"):
        return "export"
    if params.get("alt") == "media":
        return "content"
    return "metadata" if path.startswith("/files/") else "other"


def _json(body) -> dict:
    try:
        value = json.loads(body) if body else {}
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


class AskTrace:
    """Everything one dry run did, in order. Private: it holds names and quotes."""

    def __init__(self):
        self.started = time.perf_counter()
        self.lock = threading.Lock()
        self.calls: list[dict] = []
        self.rows: dict[str, dict] = {}
        self.row_order: list[str] = []
        self._pages: dict[tuple, int] = {}
        self.search_pages: list[dict] = []
        self.candidates: dict[int, dict] = {}
        self.pruned: list[str] = []
        self.deduplicated = 0
        self.observations: dict[int, dict] = {}
        self.package: dict | None = None
        self.errors: list[dict] = []
        self.logs: list[dict] = []
        self.marks: dict[str, int] = {}
        self.checkpoint: dict = {}
        self.planner_plan: dict | None = None
        self.skipped: list[str] = []

    def ms(self) -> int:
        return round((time.perf_counter() - self.started) * 1000)

    def mark(self, name: str) -> None:
        self.marks.setdefault(name, self.ms())

    def error(self, stage: str, code: str) -> None:
        self.errors.append({"t": self.ms(), "stage": stage, "code": code})

    # Drive ---------------------------------------------------------------------------
    def drive_call(self, *, path, params, body, ms, outcome) -> None:
        op = _operation(path, params)
        entry = {"op": op, "t": self.ms(), "ms": round(ms), "outcome": outcome}
        with self.lock:
            index = len(self.calls)
            if op == "list":
                corpus = "drive" if params.get("corpora") == "drive" else "user"
                key = (params.get("q"), corpus, params.get("driveId"))
                page = self._pages.get(key, 0) + 1 if params.get("pageToken") else 1
                self._pages[key] = page
                payload = _json(body)
                files = payload.get("files") if isinstance(payload.get("files"), list) else []
                entry.update(
                    q=params.get("q"),
                    page=page,
                    corpus=corpus,
                    shared_drive=bool(params.get("driveId")),
                    order_by=params.get("orderBy"),
                    page_size=int(params.get("pageSize") or 0),
                    rows=len(files),
                    incomplete_search=payload.get("incompleteSearch") is True,
                    more=bool(payload.get("nextPageToken")),
                )
                for item in files:
                    self._register(item, index)
            elif op == "drives":
                payload = _json(body)
                drives = payload.get("drives") if isinstance(payload.get("drives"), list) else []
                entry.update(rows=len(drives), q=None, page=None)
            else:
                entry.update(q=None, page=None, rows=None)
                parts = path.split("/")
                if op in {"metadata", "content", "export"} and len(parts) > 2:
                    entry["file_id"] = parts[2]
                if op in {"content", "export"} and body is not None:
                    entry["bytes"] = len(body)
            self.calls.append(entry)

    def _register(self, item: dict, call_index: int) -> None:
        file_id = item.get("id")
        if not isinstance(file_id, str):
            return
        row = self.rows.get(file_id)
        if row is not None:
            row["seen"] += 1
            return
        details = (
            item.get("shortcutDetails") if isinstance(item.get("shortcutDetails"), dict) else {}
        )
        self.rows[file_id] = {
            "file_id": file_id,
            "file_name": item.get("name"),
            "mime": item.get("mimeType"),
            "modified_time": item.get("modifiedTime"),
            "created_time": item.get("createdTime"),
            "shortcut_target": details.get("targetId"),
            "first_call": call_index,
            "seen": 1,
            "kept": None,
            "drop_stage": None,
            "drop_reason": None,
            "candidate_file_id": None,
        }
        self.row_order.append(file_id)

    def row_outcome(self, candidate, kept: list[dict], delta: dict, *, folder_scoped: bool) -> None:
        file_id = candidate.get("id") if isinstance(candidate, dict) else None
        with self.lock:
            row = self.rows.get(file_id)
            if row is None or row["kept"] is not None:
                return
            if kept:
                row.update(kept=True, candidate_file_id=kept[0].get("id"))
                return
            if delta.get("matchingFoldersDiscovered"):
                row.update(kept=False, drop_stage="folder", drop_reason="folder_contents_searched")
                return
            reason = next((code for key, code in _COUNTER_REASONS if delta.get(key)), None)
            if reason is None and candidate.get("mimeType") == FOLDER_MIME:
                reason = "folder_already_queued" if folder_scoped else "folder_not_searched"
            row.update(
                kept=False, drop_stage="search_filter", drop_reason=reason or "dropped_by_filter"
            )

    # Search store ---------------------------------------------------------------------
    def candidate(self, position: int, item: dict) -> None:
        source = "index" if item.get("indexedEvidence") else "drive_search"
        self.candidates[position] = {
            "position": position,
            "file": copy.deepcopy(item),
            "source": source,
        }

    def renumber(self, mapping: dict[int, int], dropped_ids: list[str]) -> None:
        self.candidates = {
            mapping[position]: {**value, "position": mapping[position]}
            for position, value in self.candidates.items()
            if position in mapping
        }
        for file_id in dropped_ids:
            self.pruned.append(file_id)
            row = self.rows.get(file_id)
            if row is not None:
                row.update(
                    kept=False, drop_stage="rank_limit", drop_reason="beyond_requested_count"
                )


# --- Logs -----------------------------------------------------------------------------
_LOGGERS = ("hushh_mcp", "drive_owner_search", "drive_bulk_share", "drive_chat_service")


class _LogCapture(logging.Handler):
    def __init__(self, trace: AskTrace):
        super().__init__(level=logging.INFO)
        self.trace = trace

    def emit(self, record):
        try:
            message = record.getMessage()
        except Exception:  # noqa: BLE001 - a malformed record is skipped, never raised
            return
        self.trace.logs.append(
            {
                "t": self.trace.ms(),
                "level": record.levelname,
                "logger": record.name,
                "msg": message[:500],
            }
        )


@contextlib.contextmanager
def capture_logs(trace: AskTrace):
    handler = _LogCapture(trace)
    saved = []
    for name in _LOGGERS:
        logger = logging.getLogger(name)
        saved.append((logger, logger.level))
        if logger.getEffectiveLevel() > logging.INFO:
            logger.setLevel(logging.INFO)
        logger.addHandler(handler)
    try:
        yield handler
    finally:
        for logger, level in saved:
            logger.removeHandler(handler)
            logger.setLevel(level)


# --- Model calls ----------------------------------------------------------------------
class ModelMeter:
    """One model call at a time, capped per ask, with estimated tokens and cost."""

    def __init__(self, *, model: str, limits: AskLimits, trace: AskTrace):
        self.model = model
        self.limits = limits
        self.trace = trace
        self.semaphore = asyncio.Semaphore(1)
        self.budget = Budget(max_usd=limits.max_cost_usd)
        self.pricing = load_pricing()
        self.usage: list[dict] = []
        self.capped: str | None = None

    def _reserve(self, prompt: str) -> None:
        if len(self.usage) >= self.limits.max_model_calls:
            self.capped = "max_model_calls"
            raise ModelCapReached("model_call_cap")
        tokens = estimate_tokens(len(prompt.encode()))
        expected = usage_row(
            model=self.model,
            input_tokens=tokens,
            output_tokens=tokens // 4 + 1024,
            estimated=True,
            pricing=self.pricing,
        )["cost_usd"]
        try:
            self.budget.reserve(expected)
        except BudgetExhausted:
            self.capped = "max_cost_usd"
            raise ModelCapReached("model_cost_cap") from None

    async def _call(self, stage: str, function, prompt: str, kwargs: dict):
        async with self.semaphore:
            self._reserve(prompt)
            started = time.perf_counter()
            ok = False
            answer = None
            failure = None
            try:
                answer = await function(prompt=prompt, **kwargs)
                ok = True
                return answer
            except Exception as error:
                failure = _error_code(error)
                raise
            finally:
                output = json.dumps(answer, default=str).encode() if answer is not None else b""
                row = usage_row(
                    model=self.model,
                    input_tokens=estimate_tokens(len(prompt.encode())),
                    output_tokens=2 * estimate_tokens(len(output)) if ok else 0,
                    estimated=True,
                    pricing=self.pricing,
                )
                row.update(
                    stage=stage,
                    ok=ok,
                    error=failure,
                    ms=round((time.perf_counter() - started) * 1000),
                    t=self.trace.ms(),
                )
                if failure:
                    self.trace.error(f"model_{stage}", failure)
                self.budget.record(row)
                self.usage.append(row)
                if stage == "plan" and ok and isinstance(answer, dict):
                    self.trace.planner_plan = copy.deepcopy(answer)

    def text(self, stage: str, function):
        """Wrap ``function(prompt=..., user_id=...)`` (planner, package assessors)."""

        async def call(*, prompt, **kwargs):
            return await self._call(stage, function, prompt, kwargs)

        return call

    def schema(self, stage: str, function):
        """Wrap ``interpret(prompt=..., user_id=..., output_schema=...)`` (packet checks)."""

        async def call(*, prompt, **kwargs):
            return await self._call(stage, function, prompt, kwargs)

        return call

    def summary(self) -> dict:
        cost = sum(item["cost_usd"] or 0.0 for item in self.usage)
        return {
            "calls": len(self.usage),
            "est_cost_usd": round(cost, 4),
            "by_stage": dict(Counter(item["stage"] for item in self.usage)),
            "failed": sum(not item["ok"] for item in self.usage),
            "errors": dict(Counter(item["error"] for item in self.usage if item.get("error"))),
            "capped": self.capped,
            "max_model_calls": self.limits.max_model_calls,
            "max_cost_usd": self.limits.max_cost_usd,
            "model": self.model,
            "prices_verified": False,
        }


# --- In-memory request, search and package state -------------------------------------
def _uuid() -> str:
    return str(uuid.uuid4())


INDEX_FENCES = ("deployed", "frozen")


class IndexFence:
    """The production evidence fence (``_evidence_current``) of the search and package stores.

    ``deployed``: like UAT, a store call fails with ``source_changed`` when the owner's
    index changed since the route was chosen. One full index scan takes seconds through
    the local proxy, so a passing check is reused for ``reuse_seconds``. ``frozen``
    (what-if): the index is held at the route's snapshot for the whole ask.
    """

    def __init__(self, facts, owner_id: str, *, mode: str, trace: AskTrace, reuse_seconds=20.0):
        if mode not in INDEX_FENCES:
            raise AskRefused("index_fence_invalid")
        self.facts = facts
        self.owner_id = owner_id
        self.mode = mode
        self.trace = trace
        self.reuse_seconds = reuse_seconds
        self.checks = 0
        self.reused = 0
        self.skipped = 0
        self._passed: dict[str, float] = {}

    async def check(self, checkpoint: dict) -> None:
        from hushh_mcp.services.google_drive_adapter import DriveReadError

        route = (checkpoint or {}).get("evidence_route")
        if route not in {"index", "hybrid"}:
            return
        if self.mode == "frozen":
            self.skipped += 1
            return
        expected = ((checkpoint or {}).get("index_snapshot") or {}).get("signature")
        passed = self._passed.get(expected or "")
        if passed is not None and time.monotonic() - passed < self.reuse_seconds:
            self.reused += 1
            return
        self.checks += 1
        current = await self.facts.current_index_status(owner_user_id=self.owner_id)
        if route == "index" and not current["complete"] or current["signature"] != expected:
            self.trace.error("index_fence", "source_changed")
            raise DriveReadError("source_changed")
        self._passed[expected] = time.monotonic()

    def summary(self) -> dict:
        return {
            "mode": self.mode,
            "checks": self.checks,
            "reused": self.reused,
            "skipped": self.skipped,
        }


class FrozenIndexFacts:
    """What-if only: the first index status of the ask is returned for the rest of it."""

    def __init__(self, facts):
        self._facts = facts
        self._status = None
        self.served_frozen = 0

    async def current_index_status(self, *, owner_user_id, policy_version=None):
        if self._status is None:
            self._status = await self._facts.current_index_status(
                owner_user_id=owner_user_id, policy_version=policy_version
            )
        else:
            self.served_frozen += 1
        return copy.deepcopy(self._status)

    def __getattr__(self, name):
        return getattr(self._facts, name)


class DryRunSharing:
    """The DriveSharingStore methods ``start_search`` calls, for one simulated request."""

    db = None

    def __init__(self, *, owner_id, request_id, ask: AskInput, agent_package: bool, authority):
        self.owner_id = owner_id
        self.request_id = request_id
        self.ask = ask
        self.agent_package = agent_package
        self.authority = authority
        self.search_started = False

    def _check(self, user_id, request_id):
        if user_id != self.owner_id:
            raise OwnerMismatch("request_for_another_owner")
        if str(request_id) != self.request_id:
            raise ReadOnlyViolation("request_unknown")

    async def request_bulk_context(self, *, user_id, request_id, start=False):
        self._check(user_id, request_id)
        if start:
            self.search_started = True
        return {
            "requestId": self.request_id,
            "revision": 1,
            "status": "pending",
            "purpose": dict(self.ask.purpose),
            "requestTimeZone": self.ask.time_zone,
            "requestCreatedAt": self.ask.as_of,
            "recipient": {"user_id": SIMULATED_BUYER_ID, "subject": None, "email": None},
            "recipientUserId": SIMULATED_BUYER_ID,
            "recipientBinding": None,
            "searchStarted": self.search_started,
            "accessStopRequested": False,
            "agentPackageRequired": self.agent_package,
            "packageAllowed": False,
            "reusablePacket": None,
        }

    async def package_preparation_authority(self, *, user_id, request_id):
        self._check(user_id, request_id)
        await self.authority()
        return {"requestId": self.request_id, "revision": 1, "agentPackageRequired": True}

    def __getattr__(self, name):
        raise ReadOnlyViolation(f"sharing_store_method_not_in_dry_run:{name}")


class RefusingStore:
    """Bulk share, payment and other write stores: unreachable in a dry run."""

    db = None

    def __init__(self, name: str):
        self._name = name

    def __getattr__(self, attribute):
        raise ReadOnlyViolation(f"{self._name}_refused:{attribute}")


class DryRunSearchStore:
    """The DriveOwnerSearchStore methods the request search calls, in memory.

    ``commit_page`` keeps the production rules: dedupe by file, the 10,000-result
    ceiling, the latest-N retention for a counted request and the state machine.
    """

    db = None
    ACTIVE = frozenset({"queued", "running"})

    def __init__(self, *, owner_id: str, generation: int, trace: AskTrace, fence: IndexFence):
        self.owner_id = owner_id
        self.generation = generation
        self.trace = trace
        self.fence = fence
        self.jobs: dict[str, dict] = {}
        self.results: dict[str, list[dict]] = {}

    def _owner(self, user_id):
        if user_id != self.owner_id:
            raise OwnerMismatch("search_for_another_owner")

    def row(self, job_id) -> dict:
        from hushh_mcp.services.google_drive_adapter import DriveReadError

        row = self.jobs.get(str(job_id))
        if row is None:
            raise DriveReadError("search_not_found")
        return row

    def _view(self, row):
        from hushh_mcp.services.drive_owner_search_store import (
            _bounded_selection,
            _selection_ready,
            view,
        )

        result = view(row)
        checkpoint = row["checkpoint"]
        counts = checkpoint.get("coverage_counts", {})
        manifest = checkpoint.get("coverage_manifest") or {}
        result["coverage"] = {
            **{key: manifest[key] for key in manifest if key != "requestedPeriod"},
            **dict(counts),
            "requestedPeriod": manifest.get("requestedPeriod"),
        }
        selection = _bounded_selection(checkpoint)
        if selection is not None and not _selection_ready(row, checkpoint):
            result["matched"] = 0
        return result

    async def clear_legacy_completed_request(self, *, user_id, request_id):
        self._owner(user_id)
        return False

    async def by_client(self, *, user_id, client_request_id):
        self._owner(user_id)
        for row in self.jobs.values():
            if row["client_request_id"] == str(client_request_id):
                return self._view(row)
        return None

    async def clear_terminal_request(self, *, user_id, request_id):
        self._owner(user_id)
        for job_id, row in list(self.jobs.items()):
            if row["client_request_id"] == str(request_id) and row["status"] in {
                "failed",
                "limited",
                "stopped",
            }:
                self.jobs.pop(job_id)
                self.results.pop(job_id, None)

    async def takeover_request(self, *, user_id, request_id):
        self._owner(user_id)
        return None

    async def align_request_expiry(self, *, user_id, request_id):
        self._owner(user_id)

    async def create(self, *, user_id, client_request_id, request, checkpoint, confirmed):
        from hushh_mcp.services.google_drive_adapter import DriveReadError

        self._owner(user_id)
        if confirmed is not True:
            raise DriveReadError("confirmation_required")
        for row in self.jobs.values():
            if row["client_request_id"] == str(client_request_id):
                return self._view(row), False
        now = datetime.now(UTC)
        job_id = _uuid()
        self.jobs[job_id] = {
            "job_id": job_id,
            "user_id": user_id,
            "client_request_id": str(client_request_id),
            "status": "queued",
            "revision": 1,
            "matched": 0,
            "unshareable_count": 0,
            "pages_scanned": 0,
            "incomplete_search": False,
            "created_at": now,
            "updated_at": now,
            "expires_at": now + timedelta(days=7),
            "error_code": None,
            "lease_id": None,
            "retry_count": 0,
            "connection_generation": self.generation,
            "checkpoint": copy.deepcopy(checkpoint),
            "request": dict(request),
            "evaluation_status": "pending",
            "evaluation_attempts": 0,
            "evaluation_error_code": None,
            "evaluation_lease": None,
        }
        self.results[job_id] = []
        self.trace.checkpoint = copy.deepcopy(checkpoint)
        self.trace.mark("search_created")
        return self._view(self.jobs[job_id]), True

    async def status(self, *, user_id, job_id):
        self._owner(user_id)
        return self._view(self.row(job_id))

    async def claim(self, *, user_id, job_id):
        self._owner(user_id)
        row = self.row(job_id)
        if row["status"] not in self.ACTIVE or row["lease_id"]:
            return None
        lease = _uuid()
        row.update(status="running", lease_id=lease, revision=row["revision"] + 1)
        return {
            "job_id": row["job_id"],
            "user_id": user_id,
            "generation": row["connection_generation"],
            "lease_id": lease,
            "checkpoint": copy.deepcopy(row["checkpoint"]),
        }

    def _current(self, job) -> dict:
        from hushh_mcp.services.google_drive_adapter import DriveReadError

        row = self.row(job["job_id"])
        if (
            row["status"] != "running"
            or row["lease_id"] != job["lease_id"]
            or row["checkpoint"].get("authority_mode", "owner")
            != job["checkpoint"].get("authority_mode", "owner")
        ):
            raise DriveReadError("search_superseded")
        return row

    async def require_current(self, job):
        self._current(job)
        await self.fence.check(job["checkpoint"])

    def _retain_latest(self, job_id: str, selection) -> tuple[int, int] | None:
        limit, field_name = selection
        ranked = []
        for result in self.results[job_id]:
            value = result["item"].get(field_name)
            try:
                if not isinstance(value, str):
                    return None
                stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if stamp.tzinfo is None or stamp.utcoffset() is None:
                    return None
            except (ValueError, OverflowError):
                return None
            ranked.append((stamp.astimezone(UTC), result["item"]["id"], result))
        ranked.sort(key=lambda entry: entry[1])
        ranked.sort(key=lambda entry: entry[0], reverse=True)
        kept = ranked[:limit]
        mapping = {}
        retained = []
        for position, (_, _, result) in enumerate(kept, start=1):
            mapping[result["position"]] = position
            retained.append({**result, "position": position})
        dropped = [entry[2]["item"]["id"] for entry in ranked[limit:]]
        self.results[job_id] = retained
        self.trace.renumber(mapping, dropped)
        return len(retained), sum(item["item"].get("shareable") is False for item in retained)

    async def commit_page(self, job, *, checkpoint, files, incomplete=False, done=False):
        from hushh_mcp.services.drive_owner_search_store import MAX_RESULTS, _bounded_selection
        from hushh_mcp.services.google_drive_adapter import DriveReadError

        if not isinstance(files, list) or len(files) > 100:
            raise DriveReadError("invalid_argument")
        row = self._current(job)
        await self.fence.check(job["checkpoint"])
        job_id = row["job_id"]
        selection = _bounded_selection(row["checkpoint"])
        if _bounded_selection(checkpoint) != selection:
            raise DriveReadError("search_superseded")
        results = self.results[job_id]
        known = {item["item"]["id"] for item in results}
        count = row["matched"]
        unshareable = row["unshareable_count"]
        limited = invalid_ranking = False
        for item in files:
            if item["id"] in known:
                if checkpoint.get("coverage_manifest"):
                    counts = checkpoint.setdefault("coverage_counts", {})
                    counts["deduplicatedCount"] = counts.get("deduplicatedCount", 0) + 1
                self.trace.deduplicated += 1
                continue
            if count == MAX_RESULTS:
                if selection is None or selection[0] >= MAX_RESULTS:
                    limited = True
                    break
                retained = self._retain_latest(job_id, selection)
                if retained is None:
                    limited = invalid_ranking = True
                    break
                count, unshareable = retained
                checkpoint["request_candidate_pool_pruned"] = True
            count += 1
            unshareable += int(item.get("shareable") is False)
            digest = hashlib.sha256(f"{job_id}\0{item['id']}".encode()).hexdigest()
            results.append(
                {
                    "position": count,
                    "file_digest": digest,
                    "item": copy.deepcopy(item),
                    "evaluated": False,
                    "evaluation": None,
                }
            )
            known.add(item["id"])
            self.trace.candidate(count, item)
        limited = limited or selection is None and count == MAX_RESULTS and not done
        is_incomplete = incomplete or row["incomplete_search"] or limited
        if selection is not None:
            checkpoint["request_results_finalized"] = False
            checkpoint["request_candidate_count"] = count
            if done and not is_incomplete:
                selected = self._retain_latest(job_id, selection)
                if selected is None:
                    is_incomplete = invalid_ranking = True
                else:
                    count, unshareable = selected
                    checkpoint["request_results_finalized"] = True
        state = (
            "limited" if limited or done and is_incomplete else "completed" if done else "running"
        )
        terminal = state != "running"
        row.update(
            matched=count,
            pages_scanned=row["pages_scanned"] + 1,
            unshareable_count=unshareable,
            incomplete_search=is_incomplete,
            status=state,
            checkpoint=copy.deepcopy(checkpoint),
            retry_count=0,
            error_code="provider_response_invalid"
            if invalid_ranking
            else "search_limit"
            if limited
            else None,
            lease_id=None if terminal else row["lease_id"],
            revision=row["revision"] + 1,
            updated_at=datetime.now(UTC),
        )
        self.trace.checkpoint = copy.deepcopy(checkpoint)
        self.trace.search_pages.append(
            {
                "t": self.trace.ms(),
                "phase": job["checkpoint"].get("phase"),
                "files": len(files),
                "matched": count,
                "incomplete": is_incomplete,
                "state": state,
            }
        )
        if state == "completed" and checkpoint.get("request_origin_id"):
            self.trace.skipped.append("refresh_request: reconciles the stored request row")
        return self._view(row)

    async def release(self, job, *, error=None, retryable=False):
        row = self.row(job["job_id"])
        if row["status"] != "running" or row["lease_id"] != job["lease_id"]:
            return row["status"]
        retries = row["retry_count"] + int(error is not None)
        retry = retryable and retries < 3
        state = "queued" if error is None or retry else "failed"
        code = (
            error
            if error
            in {
                "provider_unavailable",
                "connection_changed",
                "connector_unavailable",
                "provider_response_invalid",
            }
            else "provider_unavailable"
            if error
            else None
        )
        if error:
            self.trace.error("search", str(error))
        row.update(
            status=state,
            error_code=code,
            retry_count=min(retries, 3),
            lease_id=None,
            revision=row["revision"] + 1,
            updated_at=datetime.now(UTC),
        )
        return state

    async def pause_for_background(self, job):
        row = self.row(job["job_id"])
        if row["status"] != "running" or row["lease_id"] != job["lease_id"]:
            return row["status"]
        self.trace.error("search", "background_preparation_required")
        row.update(status="queued", error_code=None, lease_id=None)
        return "queued"

    def __getattr__(self, name):
        raise ReadOnlyViolation(f"search_store_method_not_in_dry_run:{name}")


class DryRunPackageStore:
    """The DriveRequestPackageStore methods the package service calls, in memory."""

    db = None

    def __init__(self, search: DryRunSearchStore, *, sharing: DryRunSharing, facts, trace):
        self.search = search
        self.sharing = sharing
        self.facts = facts
        self.trace = trace
        self.last_error: str | None = None

    async def _request_current(self, row):
        from hushh_mcp.services.drive_sharing_contract import DriveSharingError

        checkpoint = row["checkpoint"]
        if (
            row["status"] != "completed"
            or row["incomplete_search"]
            or checkpoint.get("request_origin_id") != self.sharing.request_id
            or (
                checkpoint.get("request_result_limit") is not None
                and checkpoint.get("request_results_finalized") is not True
            )
        ):
            raise DriveSharingError("package_changed")
        await self.search.fence.check(checkpoint)
        return checkpoint

    async def _current(self, job):
        from hushh_mcp.services.drive_sharing_contract import DriveSharingError

        row = self.search.row(job["job_id"])
        checkpoint = await self._request_current(row)
        if row["evaluation_status"] != "running" or row["evaluation_lease"] != job["lease_id"]:
            raise DriveSharingError("package_changed")
        return row, checkpoint

    async def claim_evaluation(self, *, user_id, job_id, batch_size=None):
        from hushh_mcp.services.drive_request_package_store import MAX_BATCH, document_ref

        batch_size = MAX_BATCH if batch_size is None else batch_size
        if type(batch_size) is not int or not 1 <= batch_size <= MAX_BATCH:
            raise ValueError("invalid evaluation batch size")
        self.search._owner(user_id)
        row = self.search.row(job_id)
        checkpoint = await self._request_current(row)
        if row["evaluation_status"] not in {"pending", "running"} or row["evaluation_lease"]:
            return None
        pending = [item for item in self.search.results[row["job_id"]] if not item["evaluated"]]
        candidates = [
            {
                "position": item["position"],
                "document_ref": document_ref(item["position"]),
                "file_digest": item["file_digest"],
                "metadata": copy.deepcopy(item["item"]),
            }
            for item in pending[:batch_size]
        ]
        if checkpoint.get("evidence_route") in {"index", "hybrid"}:
            retained, budget = [], 0
            for candidate in candidates:
                size = candidate["metadata"].get("indexedEvidenceBytes", 128 * 1024)
                if retained and budget + size > 128 * 1024:
                    break
                retained.append(candidate)
                budget += size
            candidates = retained
        lease = _uuid()
        row.update(evaluation_status="running", evaluation_lease=lease, evaluation_error_code=None)
        return {
            "user_id": user_id,
            "job_id": row["job_id"],
            "request_id": self.sharing.request_id,
            "request_revision": 1,
            "generation": row["connection_generation"],
            "lease_id": lease,
            "purpose": dict(self.sharing.ask.purpose),
            "checkpoint": copy.deepcopy(checkpoint),
            "candidates": candidates,
            "remaining": len(pending) - len(candidates),
            "candidate_count": row["matched"],
        }

    async def require_evaluation_current(self, job):
        await self._current(job)

    async def commit_evaluations(self, job, *, observations):
        from hushh_mcp.services.drive_request_package_store import DriveRequestPackageStore
        from hushh_mcp.services.drive_sharing_contract import DriveSharingError

        expected = {item["position"]: item for item in job["candidates"]}
        if (
            not isinstance(observations, list)
            or len(observations) != len(expected)
            or not expected
            or {item.get("position") for item in observations if isinstance(item, dict)}
            != set(expected)
        ):
            raise ValueError("evaluation must account for the entire claimed batch")
        # The production validator; it reads no state.
        values = [
            DriveRequestPackageStore._observation(None, item, expected[item["position"]])
            for item in observations
        ]
        row, _ = await self._current(job)
        for value in values:
            if value.get("indexed_evidence"):
                await self.facts.current_document(
                    owner_user_id=job["user_id"], **value["indexed_evidence"]
                )
        by_position = {item["position"]: item for item in self.search.results[row["job_id"]]}
        for value in values:
            result = by_position.get(value["position"])
            if (
                result is None
                or result["file_digest"] != value["file_digest"]
                or result["evaluated"]
            ):
                raise DriveSharingError("package_changed")
            result.update(evaluated=True, evaluation=copy.deepcopy(value))
            self.trace.observations[value["position"]] = copy.deepcopy(value)
        row["evaluation_attempts"] = 0
        return {"committed": len(values)}

    async def release_evaluation(self, job, *, retryable=False, error=None):
        from hushh_mcp.services.drive_request_package_store import _SAFE_ERRORS

        code = error if error in _SAFE_ERRORS else "preparation_unavailable" if error else None
        row = self.search.row(job["job_id"])
        if row["evaluation_lease"] != job["lease_id"] or row["evaluation_status"] != "running":
            return "superseded"
        paused = code == "background_preparation_required"
        attempts = min(3, row["evaluation_attempts"] + int(code is not None and not paused))
        status = "pending" if code is None or paused or retryable and attempts < 3 else "failed"
        if code:
            self.trace.error("package", self.last_error or code)
            self.last_error = None
        row.update(
            evaluation_status=status,
            evaluation_attempts=attempts,
            evaluation_error_code=code,
            evaluation_lease=None,
        )
        return status

    async def package_evidence_page(self, job, *, after_position=0, limit=100):
        if (
            type(after_position) is not int
            or not 0 <= after_position <= 10000
            or type(limit) is not int
            or not 1 <= limit <= 100
        ):
            raise ValueError("invalid package evidence page")
        row, _ = await self._current(job)
        results = self.search.results[row["job_id"]]
        items = [
            copy.deepcopy(item["evaluation"])
            for item in sorted(results, key=lambda value: value["position"])
            if item["evaluated"] and item["position"] > after_position
        ][: limit + 1]
        more = len(items) > limit
        return {
            "items": items[:limit],
            "next_position": items[limit - 1]["position"] if more else None,
            "counts": {
                "candidates": len(results),
                "evaluated": sum(item["evaluated"] for item in results),
            },
        }

    def _manifest(self, row, positions):
        from hushh_mcp.services.drive_sharing_contract import DriveSharingError

        selected = set(positions)
        if len(selected) != len(positions):
            raise DriveSharingError("package_changed")
        results = self.search.results[row["job_id"]]
        counts = {
            "candidates": len(results),
            "evaluated": sum(item["evaluated"] for item in results),
            "unreadable": 0,
            "truncated": 0,
            "uncertain": 0,
        }
        sources = []
        for result in sorted(results, key=lambda value: value["position"]):
            item = result["evaluation"]
            if item is None:
                continue
            counts["unreadable"] += int(item["unreadable_reason"] is not None)
            counts["truncated"] += int(item["truncated"])
            assessment = item.get("assessment")
            counts["uncertain"] += int(
                bool(assessment and assessment.get("decision") == "uncertain")
            )
            if item["position"] in selected:
                if (
                    not assessment
                    or assessment.get("decision") != "include"
                    or item["unreadable_reason"]
                ):
                    raise DriveSharingError("package_changed")
                sources.append(
                    {
                        key: item[key]
                        for key in (
                            "position",
                            "file_digest",
                            "source_version",
                            "content_fingerprint",
                        )
                    }
                    | (
                        {"indexed_evidence": item["indexed_evidence"]}
                        if item.get("indexed_evidence")
                        else {}
                    )
                )
        if (
            len(sources) != len(selected)
            or counts["candidates"] != row["matched"]
            or counts["evaluated"] != counts["candidates"]
        ):
            raise DriveSharingError("package_incomplete")
        return sources, counts

    async def finalize_package(self, job, *, assessment, policy_version):
        from hushh_mcp.services.drive_request_package_assessment import PackageAssessment
        from hushh_mcp.services.drive_request_package_store import (
            PACKAGE_KEY,
            PACKAGE_VERSION,
            _public_package,
        )
        from hushh_mcp.services.drive_sharing_contract import DriveSharingError

        answer = PackageAssessment.model_validate(assessment).model_dump(mode="json")
        if not isinstance(policy_version, str) or not 1 <= len(policy_version) <= 128:
            raise ValueError("invalid package policy version")
        positions = []
        for ref in answer["selected_document_refs"]:
            if not re.fullmatch(r"p[1-9][0-9]{0,4}", ref) or int(ref[1:]) > 10000:
                raise ValueError("invalid selected document reference")
            positions.append(int(ref[1:]))
        row, checkpoint = await self._current(job)
        try:
            sources, counts = self._manifest(row, positions)
            if answer["decision"] == "ready" and any(
                counts[key] for key in ("unreadable", "truncated", "uncertain")
            ):
                raise DriveSharingError("package_incomplete")
            if (checkpoint.get("reusable_packet") or checkpoint.get("matched_packet")) and (
                answer["decision"] != "ready" or len(positions) != counts["candidates"]
            ):
                raise DriveSharingError("package_changed")
            if (
                checkpoint.get("coverage_manifest", {}).get("fallbackReason")
                and answer["decision"] == "ready"
            ):
                raise DriveSharingError("package_incomplete")
        except DriveSharingError as error:
            self.last_error = f"finalize:{error}"
            self.trace.package = {"assessment": answer, "finalize_error": str(error)}
            raise
        previous = checkpoint.get(PACKAGE_KEY, {})
        package = {
            "schema_version": PACKAGE_VERSION,
            **{
                key: checkpoint[key]
                for key in ("reusable_packet", "matched_packet", "request_packet_verification")
                if key in checkpoint
            },
            "revision": previous.get("revision", 0) + 1,
            "policy_version": policy_version,
            "assessment": answer,
            "selected_positions": sorted(positions),
            "counts": counts,
            "request_revision": 1,
            "connection_generation": row["connection_generation"],
        }
        # The production digest is an HMAC under the sharing key; a dry run has no
        # request to bind, so this digest only identifies the package in the trace.
        package["digest"] = hashlib.sha256(
            json.dumps([package, sources], sort_keys=True, default=str).encode()
        ).hexdigest()
        checkpoint[PACKAGE_KEY] = package
        row["checkpoint"] = copy.deepcopy(checkpoint)
        status = (
            "ready" if positions else "no_match" if answer["decision"] == "no_match" else "failed"
        )
        row.update(evaluation_status=status, evaluation_lease=None, evaluation_error_code=None)
        public = _public_package(package, status="unavailable" if status == "failed" else status)
        self.trace.package = {
            "package": copy.deepcopy(package),
            "public": copy.deepcopy(public),
            "sources": copy.deepcopy(sources),
            "status": status,
        }
        return public

    def __getattr__(self, name):
        raise ReadOnlyViolation(f"package_store_method_not_in_dry_run:{name}")


@functools.cache
def _tracing_search_class():
    from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService

    class TracingOwnerSearchService(DriveOwnerSearchService):
        """The production search, with each provider row filtered on its own.

        ``_request_candidates`` runs unchanged, one row at a time, so the change in
        the production exclusion counters names the rule that dropped each row.
        The rows, the order, the counters and the kept files are the same; only the
        shortcut-target reads of one page run one after another instead of together.
        """

        def __init__(self, *args, trace: AskTrace, **kwargs):
            super().__init__(*args, **kwargs)
            self._trace = trace

        async def _request_candidates(
            self, job, checkpoint, candidates, *, folder_scoped, drive_id
        ):
            files, incomplete = [], False
            for candidate in candidates:
                before = dict(checkpoint.get("coverage_counts", {}))
                kept, partial = await super()._request_candidates(
                    job, checkpoint, [candidate], folder_scoped=folder_scoped, drive_id=drive_id
                )
                after = checkpoint.get("coverage_counts", {})
                delta = {
                    key: after.get(key, 0) - before.get(key, 0)
                    for key in after
                    if after.get(key, 0) != before.get(key, 0)
                }
                self._trace.row_outcome(candidate, kept, delta, folder_scoped=folder_scoped)
                files.extend(kept)
                incomplete = incomplete or partial
            return files, incomplete

    return TracingOwnerSearchService


# --- Runtime --------------------------------------------------------------------------
@dataclass
class Interpreters:
    """The raw model seams. Live: the engine's own. Tests: deterministic fakes."""

    planner: Callable
    document: Callable
    package: Callable
    packet: Callable

    @classmethod
    def deployed(cls) -> Interpreters:
        from hushh_mcp.services.drive_packet_intelligence import match_request_packet
        from hushh_mcp.services.drive_request_package_assessment import (
            interpret_document_batch,
            interpret_package,
        )
        from hushh_mcp.services.drive_suggestion_service import interpret_live_search

        packet = inspect.signature(match_request_packet).parameters["interpret"].default
        return cls(
            planner=interpret_live_search,
            document=interpret_document_batch,
            package=interpret_package,
            packet=packet,
        )


@dataclass
class EngineRuntime:
    """Everything an ask needs that outlives one ask. One owner, read-only."""

    owner_id: str
    db: ReadOnlyDb
    credential: OwnerCredential
    interpreters: Interpreters
    engine: dict
    model: str
    agent_packages_enabled: bool
    http_transport: Any = None
    private_dir: Path | None = None
    limits: AskLimits = field(default_factory=AskLimits)
    admission: dict = field(default_factory=dict)
    environment_notes: list[str] = field(default_factory=list)
    expected_account_label: str | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def require_safe_environment(self) -> None:
        if os.getenv("ENVIRONMENT", "").strip().lower() in {"uat", "production"}:
            raise ReadOnlyViolation("dry_run_requires_non_hosted_environment")
        if os.getenv("DRIVE_WORK_DRAIN_ENABLED", "").strip().lower() == "true":
            raise ReadOnlyViolation("dry_run_requires_drain_wake_disabled")


class AskSession:
    """One dry run: production services wired to in-memory state and read-only access."""

    def __init__(
        self, runtime: EngineRuntime, ask: AskInput, *, limits: AskLimits, index_fence="deployed"
    ):
        from hushh_mcp.services.drive_document_facts_store import DriveDocumentFactsStore
        from hushh_mcp.services.drive_live_reader import DriveLiveReader
        from hushh_mcp.services.drive_packet_intelligence import (
            match_request_packet,
            verify_packet,
        )
        from hushh_mcp.services.drive_packet_store import DrivePacketStore
        from hushh_mcp.services.drive_request_bulk_service import DriveRequestBulkService
        from hushh_mcp.services.drive_request_package_assessment import (
            assess_document_batch,
            assess_package,
        )
        from hushh_mcp.services.drive_request_package_service import DriveRequestPackageService
        from hushh_mcp.services.google_drive_rest_transport import GoogleDriveRestTransport

        self.runtime = runtime
        self.ask = ask
        self.limits = limits
        self.owner = runtime.owner_id
        self.ask_id = f"ask-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:6]}"
        self.request_id = _uuid()
        self.trace = AskTrace()
        self.meter = ModelMeter(model=runtime.model, limits=limits, trace=self.trace)
        self.client = get_only_client(runtime.http_transport)
        self.adapter = _tracing_adapter_class()(self.trace, self.client)
        self.oauth = ReadOnlyDriveOAuth(runtime.credential)
        self.transport = GoogleDriveRestTransport(
            oauth=self.oauth, adapter=self.adapter, writer=RefusingWriter()
        )
        self.facts = DriveDocumentFactsStore(db=runtime.db)
        self.packets = DrivePacketStore(db=runtime.db)
        self.fence = IndexFence(self.facts, self.owner, mode=index_fence, trace=self.trace)
        # The search service's own index reads (route choice, index pages). Frozen only
        # in the what-if mode; deployed mode uses the production store directly.
        self.search_facts = FrozenIndexFacts(self.facts) if index_fence == "frozen" else self.facts
        self._authority_checked = 0.0
        self.generation: int | None = None
        self.sharing = DryRunSharing(
            owner_id=self.owner,
            request_id=self.request_id,
            ask=ask,
            agent_package=runtime.agent_packages_enabled,
            authority=self.owner_authority,
        )
        self.search_store: DryRunSearchStore | None = None
        self.package_store: DryRunPackageStore | None = None
        packet_interpret = self.meter.schema("packet_check", runtime.interpreters.packet)
        self._services = {
            "DriveRequestBulkService": DriveRequestBulkService,
            "DriveRequestPackageService": DriveRequestPackageService,
            "DriveLiveReader": DriveLiveReader,
            "assess_document_batch": assess_document_batch,
            "assess_package": assess_package,
            "match_request_packet": functools.partial(
                match_request_packet, interpret=packet_interpret
            ),
            "verify_packet": functools.partial(verify_packet, interpret=packet_interpret),
        }
        self.bulk = None
        self.search = None
        self.packages = None
        self.owner_checks: dict[str, Any] = {}
        self.on_progress: Callable[[dict], None] | None = None

    def progress(self) -> dict:
        """Counts and codes only (no names, ids or quotes): safe for a console."""
        trace = self.trace
        stage = max(trace.marks, key=trace.marks.get) if trace.marks else "starting"
        return {
            "t_s": round(trace.ms() / 1000, 1),
            "stage": stage,
            "drive_calls": len(trace.calls),
            "list_rows": sum(call.get("rows") or 0 for call in trace.calls if call["op"] == "list"),
            "search_pages": len(trace.search_pages),
            "candidates": len(trace.candidates),
            "evaluated": len(trace.observations),
            "model_calls": len(self.meter.usage),
            "errors": [item["code"] for item in trace.errors][-5:],
            "db": self.runtime.db.stats.public(),
        }

    async def _ticker(self, seconds: float = 15.0) -> None:
        while True:
            await asyncio.sleep(seconds)
            with contextlib.suppress(Exception):
                self.on_progress(self.progress())

    # Owner authority (the owner-side half of the production authority checks) ------------
    async def owner_authority(self) -> None:
        from hushh_mcp.services.drive_live_preferences import DriveLivePreferences

        now = time.monotonic()
        if now - self._authority_checked < 10:
            return
        preferences = DriveLivePreferences(db=self.runtime.db)

        def operation(connection):
            current = preferences.live_active(connection, user_id=self.owner)
            preferences.background_current(
                connection, user_id=self.owner, generation=current["connection_generation"]
            )
            return current["connection_generation"]

        generation = await self.runtime.db.read(operation)
        if self.generation is not None and generation != self.generation:
            from hushh_mcp.services.google_drive_adapter import DriveReadError

            raise DriveReadError("connection_changed")
        self._authority_checked = now

    def _wire(self, generation: int) -> None:
        trace = self.trace
        self.search_store = DryRunSearchStore(
            owner_id=self.owner, generation=generation, trace=trace, fence=self.fence
        )
        self.package_store = DryRunPackageStore(
            self.search_store, sharing=self.sharing, facts=self.facts, trace=trace
        )
        services = self._services
        self.search = _tracing_search_class()(
            store=self.search_store,
            transport=self.transport,
            sharing=self.sharing,
            facts=self.search_facts,
            packets=self.packets,
            packet_matcher=services["match_request_packet"],
            packet_checker=services["verify_packet"],
            trace=trace,
        )
        self.bulk = services["DriveRequestBulkService"](
            sharing=self.sharing,
            search=self.search,
            bulk=RefusingStore("bulk_share_store"),
            planner=self.meter.text("plan", self.runtime.interpreters.planner),
            recipient_identity=_refuse_recipient_identity,
            require_owner=self.owner_authority,
            wake=_no_wake,
        )
        document = self.meter.text("assess_documents", self.runtime.interpreters.document)
        package = self.meter.text("assess_package", self.runtime.interpreters.package)
        self.packages = services["DriveRequestPackageService"](
            store=self.package_store,
            reader_factory=functools.partial(
                services["DriveLiveReader"],
                oauth=self.oauth,
                mcp=self.transport,
                adapter=self.adapter,
            ),
            document_assessor=_recording(
                trace, "assess_documents", services["assess_document_batch"], interpreter=document
            ),
            package_assessor=_recording(
                trace, "assess_package", services["assess_package"], interpreter=package
            ),
            wake=_no_wake,
            facts=self.facts,
            packets=self.packets,
        )

    # Preflight --------------------------------------------------------------------------
    async def preflight(self) -> None:
        from hushh_mcp.services.google_drive_adapter import LIVE_POLICY_HASH

        self.runtime.require_safe_environment()
        row = await self.runtime.credential.row()
        if row is None:
            raise AskRefused("owner_drive_not_connected")
        live = (
            row["status"] == "connected"
            and row["validation_state"] == "verified"
            and row["verified_policy_hash"] == LIVE_POLICY_HASH
        )
        self.owner_checks["drive_live_verified"] = live
        if not live:
            raise AskRefused("owner_drive_not_live")
        self.generation = row["connection_generation"]
        _, credential = await self.runtime.credential.current()
        account = await self.adapter.account(access_token=credential["accessToken"])
        expected = self.runtime.expected_account_label or credential.get("accountLabel")
        matches = bool(
            expected
            and isinstance(account.get("accountLabel"), str)
            and account["accountLabel"].casefold() == str(expected).casefold()
        )
        self.owner_checks["drive_identity_matches_owner"] = matches
        if not matches:
            raise AskRefused("drive_identity_mismatch")
        try:
            await self.owner_authority()
            self.owner_checks["background_preparation"] = "on"
        except Exception as error:  # noqa: BLE001 - reported as the owner-side check result
            self.owner_checks["background_preparation"] = str(error) or type(error).__name__
            raise
        self._wire(self.generation)

    # Run --------------------------------------------------------------------------------
    async def run(self) -> dict:
        outcome = {"status": "completed", "code": None}
        async with self.runtime.lock:
            ticker = asyncio.create_task(self._ticker()) if self.on_progress else None
            with capture_logs(self.trace):
                try:
                    async with asyncio.timeout(self.limits.max_seconds):
                        await self._run(outcome)
                except ModelCapReached as error:
                    outcome.update(status="capped", code=str(error))
                except AskRefused as error:
                    outcome.update(status="refused", code=error.code)
                except ReadOnlyViolation as error:
                    outcome.update(status="refused", code=f"read_only_guard:{error}")
                except TimeoutError:
                    outcome.update(status="capped", code="ask_time_limit")
                except Exception as error:  # noqa: BLE001 - the dashboard shows the failure code
                    outcome.update(status="error", code=_error_code(error))
                finally:
                    await self.client.aclose()
                self.trace.mark("engine_done")
                states = await self._safe(self._document_states, {})
                packets = await self._safe(self._matching_packets, [])
            if ticker is not None:
                ticker.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await ticker
        result = shape_result(self, outcome, states, packets)
        self._save(result)
        return result

    async def _safe(self, function, default):
        try:
            return await function()
        except Exception as error:  # noqa: BLE001 - side panels never hide the engine result
            self.trace.error("dashboard", _error_code(error))
            return default

    async def _run(self, outcome: dict) -> None:
        await self.preflight()
        self.trace.mark("preflight_done")
        mode = "agent_package" if self.runtime.agent_packages_enabled else "owner"
        state = await self.bulk.start_search(
            user_id=self.owner, request_id=self.request_id, authority_mode=mode
        )
        self.trace.mark("search_started")
        job_id = state["jobId"]
        slices = 0
        while state["status"] in {"queued", "running"}:
            if self.meter.capped:
                raise ModelCapReached(self.meter.capped)
            slices += 1
            if slices > self.limits.max_search_slices:
                outcome.update(status="capped", code="search_slice_cap")
                self.trace.error("search", "search_slice_cap")
                break
            result = await self.search.run_one(
                user_id=self.owner,
                job_id=job_id,
                deadline_seconds=90,
                require_current=self.owner_authority,
            )
            state = await self.search_store.status(user_id=self.owner, job_id=job_id)
            if result == "not_claimed" and state["status"] in {"queued", "running"}:
                await asyncio.sleep(0.5)
        self.trace.mark("search_done")
        if self.meter.capped:
            raise ModelCapReached(self.meter.capped)
        if state["status"] != "completed" or state["incompleteSearch"]:
            if outcome["status"] == "completed":
                reason = self._last_error({"search", "index_fence"}) or state.get("errorCode")
                outcome.update(
                    status="stopped",
                    code=f"search_{state['status']}" + (f":{reason}" if reason else ""),
                )
            return
        if mode != "agent_package":
            outcome.update(status="stopped", code="agent_packages_disabled_owner_reviews_search")
            return
        attempts = 0
        while True:
            if self.meter.capped:
                raise ModelCapReached(self.meter.capped)
            status = await self.packages.run_one(user_id=self.owner, job_id=job_id)
            if self.meter.capped:
                raise ModelCapReached(self.meter.capped)
            if status == "queued":
                continue
            row = self.search_store.row(job_id)
            if status == "unavailable" and row["evaluation_status"] == "pending" and attempts < 3:
                attempts += 1
                continue
            if status not in {"ready", "no_match"}:
                reason = self._last_error(
                    {"package", "assess_documents", "assess_package", "index_fence"}
                )
                outcome.update(
                    status="stopped",
                    code=f"package_{status}" + (f":{reason}" if reason else ""),
                )
            break
        self.trace.mark("package_done")

    def _last_error(self, stages: set[str]) -> str | None:
        return next(
            (item["code"] for item in reversed(self.trace.errors) if item["stage"] in stages),
            None,
        )

    # Side panels ---------------------------------------------------------------------------
    async def _document_states(self) -> dict:
        """Index, extraction and facts state of every candidate, owner-bound and read-only."""
        from sqlalchemy import text

        from hushh_mcp.services.drive_document_pages import EXTRACTION_PROFILE
        from hushh_mcp.services.drive_packet_intelligence import facts_policy_version

        if not self.trace.candidates or self.generation is None:
            return {}
        cipher = self.facts.cipher
        by_fingerprint = {}
        for candidate in self.trace.candidates.values():
            file_id = candidate["file"].get("id")
            if isinstance(file_id, str):
                by_fingerprint[cipher.fingerprint(self.owner, file_id)] = file_id
        policy = facts_policy_version()
        statement = text(
            """SELECT d.document_id, d.user_id, d.connection_generation, d.source_fingerprint,
              d.status, d.active_version, d.source_version, d.last_error_code,
              e.complete AS extraction_complete, e.has_gaps AS extraction_has_gaps,
              e.total_pages, e.unit_kind,
              f.status AS facts_status, f.has_gaps AS facts_has_gaps, f.facts_version,
              f.facts_envelope, f.connection_generation AS facts_generation
            FROM connected_documents d
            LEFT JOIN drive_document_extractions e
              ON e.user_id=:user AND e.document_id=d.document_id
             AND e.extraction_version=d.active_version
            LEFT JOIN drive_document_facts f
              ON f.user_id=:user AND f.document_id=d.document_id
             AND f.source_version=d.source_version AND f.extraction_version=d.active_version
             AND f.extraction_profile=:profile AND f.facts_profile=:policy
            WHERE d.user_id=:user AND d.connection_generation=:generation
              AND d.source_profile='live'
              AND d.source_fingerprint=ANY(CAST(:fingerprints AS text[]))"""
        )
        fingerprints = sorted(by_fingerprint)
        states: dict[str, dict] = {}
        for start in range(0, len(fingerprints), 400):
            chunk = fingerprints[start : start + 400]

            def operation(connection, chunk=chunk):
                return [
                    dict(row)
                    for row in connection.execute(
                        statement,
                        {
                            "user": self.owner,
                            "generation": self.generation,
                            "profile": EXTRACTION_PROFILE,
                            "policy": policy,
                            "fingerprints": chunk,
                        },
                    ).mappings()
                ]

            for row in await self.runtime.db.read(operation):
                file_id = by_fingerprint.get(row["source_fingerprint"])
                if file_id is None:
                    continue
                facts = None
                if row.get("facts_envelope"):
                    try:
                        facts = self.facts.facts(
                            {
                                "user_id": row["user_id"],
                                "document_id": row["document_id"],
                                "connection_generation": row["facts_generation"],
                                "facts_version": row["facts_version"],
                                "facts_envelope": row["facts_envelope"],
                            }
                        )
                    except Exception:  # noqa: BLE001 - shown as unreadable facts
                        facts = None
                states[file_id] = {**row, "facts": facts, "facts_envelope": None}
        return states

    async def _matching_packets(self) -> list[dict]:
        """The owner's packets that could answer this ask (owner-bound, read-only)."""
        from sqlalchemy import text

        from hushh_mcp.services.drive_packet_intelligence import facts_policy_version

        if self.generation is None:
            return []
        statement = text(
            """SELECT h.packet_id, h.user_id, h.connection_generation, h.key_envelope,
              h.current_version, h.dirty, h.updated_at,
              v.version, v.state, v.available, v.document_count, v.price_cents,
              v.policy_version, v.verified_at, v.manifest_envelope,
              l.enabled AS listing_enabled, l.price_cents AS listing_price_cents
            FROM drive_packet_heads h
            JOIN drive_packet_versions v
              ON v.user_id=:user AND v.packet_id=h.packet_id AND v.version=h.current_version
            LEFT JOIN drive_packet_listings l
              ON l.user_id=:user AND l.packet_id=h.packet_id AND l.version=h.current_version
            WHERE h.user_id=:user AND h.connection_generation=:generation
            ORDER BY v.verified_at DESC NULLS LAST LIMIT 500"""
        )

        def operation(connection):
            return [
                dict(row)
                for row in connection.execute(
                    statement, {"user": self.owner, "generation": self.generation}
                ).mappings()
            ]

        rows = await self.runtime.db.read(operation)
        policy = facts_policy_version()
        return match_packets(
            rows,
            self.packets,
            ask=self.ask,
            terms=_plan_terms(self.trace),
            policy=policy,
            engine_packet=(self.trace.checkpoint or {}).get("matched_packet"),
        )

    def _save(self, result: dict) -> None:
        directory = self.runtime.private_dir
        if directory is None:
            return
        workdir = PrivateWorkdir(Path(directory))
        folder = workdir.directory("asks")
        workdir.write_json(
            folder / f"{self.ask_id}.json",
            {
                "result": result,
                "trace": {
                    "calls": self.trace.calls,
                    "rows": [self.trace.rows[key] for key in self.trace.row_order],
                    "search_pages": self.trace.search_pages,
                    "observations": self.trace.observations,
                    "package": self.trace.package,
                    "checkpoint": _checkpoint_view(self.trace.checkpoint),
                    "planner_plan": self.trace.planner_plan,
                    "errors": self.trace.errors,
                    "logs": self.trace.logs,
                    "skipped": self.trace.skipped,
                    "db": self.runtime.db.stats.public(),
                },
            },
        )


async def _no_wake(*_args, **_kwargs):
    return False


async def _refuse_recipient_identity(*_args, **_kwargs):
    raise ReadOnlyViolation("recipient_identity_refused_in_dry_run")


def _recording(trace: AskTrace, stage: str, function, **bound):
    """Bind the metered interpreter; keep the validator's fixed failure text in the trace."""

    async def call(**kwargs):
        try:
            return await function(**kwargs, **bound)
        except Exception as error:
            trace.error(stage, _error_code(error))
            raise

    return call


_SAFE_TEXT = re.compile(r"^[A-Za-z0-9 _:,.()/-]{1,160}$")


def _error_code(error: BaseException) -> str:
    """A fixed, value-free code: class name, plus a safe message or schema location."""
    text_value = str(error)
    if isinstance(error, ModelCapReached):
        return text_value
    name = type(error).__name__
    errors = getattr(error, "errors", None)
    if name == "ValidationError" and callable(errors):
        try:
            found = errors()
            first = found[0]
            location = ".".join(str(part) for part in first.get("loc", ()))[:80] or "root"
            return f"{name}:{len(found)}:{location}:{first.get('type')}"
        except Exception:  # noqa: BLE001 - fall back to the class name
            return name
    return f"{name}:{text_value}" if _SAFE_TEXT.fullmatch(text_value) else name


def _checkpoint_view(checkpoint: dict) -> dict:
    keep = (
        "evidence_route",
        "authority_mode",
        "request_time_intent",
        "request_owner_review_required",
        "request_file_kind",
        "request_subject_terms",
        "request_exact_title",
        "request_result_limit",
        "request_order_field",
        "request_direct_originals",
        "requested_period",
        "coverage_manifest",
        "coverage_counts",
        "index_snapshot",
        "matched_packet",
        "phase",
    )
    view = {key: copy.deepcopy(checkpoint.get(key)) for key in keep if key in checkpoint}
    view["queries"] = [
        (query.get("arguments") or {}).get("query") for query in checkpoint.get("queries", [])
    ]
    return view


def _plan_terms(trace: AskTrace) -> list[str]:
    checkpoint = trace.checkpoint or {}
    terms = list(checkpoint.get("request_subject_terms") or [])
    plan = trace.planner_plan or {}
    for group in plan.get("term_groups") or []:
        for term in group:
            if isinstance(term, str) and term not in terms:
                terms.append(term)
    if checkpoint.get("request_exact_title"):
        terms.append(checkpoint["request_exact_title"])
    return terms


# --- Shaping --------------------------------------------------------------------------
def _day(value) -> date | None:
    if not isinstance(value, str) or len(value) < 10:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def _in_window(value, start: date | None, end: date | None) -> bool:
    day = _day(value)
    return bool(day and start and end and start <= day <= end)


def _overlaps(period_start, period_end, start: date | None, end: date | None) -> bool:
    low, high = _day(period_start), _day(period_end)
    return bool(low and high and start and end and low <= end and high >= start)


def proven_periods(assessment: dict | None) -> list[dict]:
    """Covered periods whose source refs are all cited in the same assessment."""
    if not assessment:
        return []
    cited = {}
    for citation in assessment.get("citations") or []:
        cited.setdefault(citation.get("source_ref"), citation.get("quote"))
    periods = []
    for period in assessment.get("covered_periods") or []:
        refs = period.get("source_refs") or []
        if refs and all(ref in cited for ref in refs):
            periods.append(
                {
                    "start": period.get("period_start"),
                    "end": period.get("period_end"),
                    "quote": cited.get(refs[0]),
                }
            )
    return periods


def _facts_period(facts: dict | None) -> dict | None:
    """The index's own period for a document: content periods, else dated evidence."""
    if not facts:
        return None
    periods = [p for p in facts.get("periods") or [] if p.get("start") and p.get("end")]
    role = "content_period"
    if not periods:
        periods = [p for p in facts.get("date_evidence") or [] if p.get("start") and p.get("end")]
        if not periods:
            return None
        role = Counter(p.get("role") or "unknown" for p in periods).most_common(1)[0][0]
    citations = [c for p in periods for c in p.get("citations") or [] if c.get("quote")]
    return {
        "start": min(p["start"] for p in periods),
        "end": max(p["end"] for p in periods),
        "role": role,
        "quote": citations[0]["quote"] if citations else None,
        "page": citations[0].get("page") if citations else None,
    }


def _quote_page(facts: dict | None, quote: str | None) -> int | None:
    if not facts or not quote:
        return None
    records = [
        facts.get("document_type"),
        facts.get("issuer"),
        facts.get("subject"),
        facts.get("account"),
        facts.get("record_status"),
        *(facts.get("periods") or []),
        *(facts.get("date_evidence") or []),
        *(facts.get("topics") or []),
        *(facts.get("facts") or []),
    ]
    for record in records:
        for citation in (record or {}).get("citations") or []:
            text_value = citation.get("quote") or ""
            if text_value and (quote in text_value or text_value in quote):
                return citation.get("page")
    return None


def _fact_value(facts: dict | None, key: str):
    value = (facts or {}).get(key)
    if isinstance(value, dict):
        value = value.get("value")
    return value if isinstance(value, str) and value.strip() else None


def _states(state: dict | None) -> tuple[str, str, str]:
    if state is None:
        return "not_in_index", "not_in_index", "none"
    extraction = (
        "ready"
        if state.get("status") == "ready" and state.get("active_version") is not None
        else state.get("last_error_code") or state.get("status") or "unknown"
    )
    if state.get("facts_status") == "complete":
        facts_state = "complete_with_gaps" if state.get("facts_has_gaps") else "complete"
    else:
        facts_state = state.get("facts_status") or "none"
    indexed = "indexed" if facts_state == "complete" and extraction == "ready" else "not_indexed"
    return indexed, extraction, facts_state


def _name_lacks_terms(name: str | None, terms: list[str]) -> bool:
    if not name or not terms:
        return False
    folded = name.casefold()
    return not any(term.casefold() in folded for term in terms if isinstance(term, str))


def document_rows(session: AskSession, states: dict) -> list[dict]:
    """One row per search candidate, in evaluation order, with the engine's verdict."""
    trace = session.trace
    start, end = _day(session.ask.period_start), _day(session.ask.period_end)
    package = (trace.package or {}).get("package") or {}
    selected = set(package.get("selected_positions") or [])
    terms = _plan_terms(trace)
    rows = []
    for position in sorted(trace.candidates):
        candidate = trace.candidates[position]
        item = candidate["file"]
        file_id = item.get("id")
        state = states.get(file_id)
        facts = (state or {}).get("facts")
        indexed, extraction, facts_state = _states(state)
        observation = trace.observations.get(position)
        assessment = (observation or {}).get("assessment") or None
        unreadable = (observation or {}).get("unreadable_reason")
        proven = proven_periods(assessment)
        in_window = [p for p in proven if _overlaps(p["start"], p["end"], start, end)]
        index_period = _facts_period(facts)
        period, period_source = None, None
        if in_window or proven:
            chosen = (in_window or proven)[0]
            period = {
                "start": min(p["start"] for p in (in_window or proven)),
                "end": max(p["end"] for p in (in_window or proven)),
                "role": "content_period",
                "quote": chosen["quote"],
                "page": _quote_page(facts, chosen["quote"]),
            }
            period_source = "engine_assessment"
        elif index_period:
            period, period_source = index_period, "index_facts"
        decision = (
            "not_evaluated"
            if observation is None
            else "unreadable"
            if unreadable
            else (assessment or {}).get("decision") or "unknown"
        )
        is_selected = position in selected
        period_proven = bool(in_window)
        modified_in_window = _in_window(item.get("modifiedTime"), start, end)
        flags = []
        if _name_lacks_terms(item.get("name"), terms):
            flags.append("filename_lacks_request_words")
        if modified_in_window:
            flags.append("modified_in_window")
        if modified_in_window and not proven and not index_period:
            flags.append("dated_only_by_modified_time")
        if proven and not in_window:
            flags.append("content_period_outside_window")
        if is_selected and not period_proven:
            flags.append("selected_period_not_proven")
            if modified_in_window:
                flags.append("selected_only_by_modified_time")
            if proven:
                flags.append("selected_period_outside_window")
            quotes = " ".join(
                str(citation.get("quote") or "")
                for citation in (assessment or {}).get("citations") or []
            ).casefold()
            if (
                not proven
                and terms
                and not _name_lacks_terms(item.get("name"), terms)
                and not any(str(term).casefold() in quotes for term in terms)
            ):
                # No date proven by its text, and the asked words appear only in
                # its file name: the selection rests on the file name.
                flags.append("selected_by_filename_only")
        if (observation or {}).get("truncated"):
            flags.append("read_truncated")
        if unreadable:
            flags.append(f"unreadable:{unreadable}")
        rows.append(
            {
                "document_id": str(state["document_id"]) if state else None,
                "position": position,
                "file_name": item.get("name"),
                "mime": item.get("mimeType"),
                "modified_time": item.get("modifiedTime"),
                "created_time": item.get("createdTime"),
                "source": candidate["source"],
                "kind": _fact_value(facts, "document_type"),
                "issuer": _fact_value(facts, "issuer"),
                "indexed_state": indexed,
                "extraction_state": extraction,
                "facts_state": facts_state,
                "period_start": (period or {}).get("start"),
                "period_end": (period or {}).get("end"),
                "period_role": (period or {}).get("role"),
                "period_source": period_source,
                "evidence_quote": (period or {}).get("quote"),
                "page": (period or {}).get("page"),
                "evaluated": observation is not None,
                "decision": decision,
                "confidence": (assessment or {}).get("confidence"),
                "engine_reason": (assessment or {}).get("reason"),
                "selected": is_selected,
                "period_proven": period_proven,
                "claimed": is_selected and period_proven,
                "reason": _document_reason(
                    decision=decision,
                    selected=is_selected,
                    period_proven=period_proven,
                    proven=proven,
                    unreadable=unreadable,
                    engine_reason=(assessment or {}).get("reason"),
                    capped=session.meter.capped,
                ),
                "flags": flags,
            }
        )
    return rows


def _document_reason(
    *, decision, selected, period_proven, proven, unreadable, engine_reason, capped
) -> str:
    if selected and period_proven:
        return "Selected: the document's own text proves dates inside the ask."
    if selected and proven:
        return "Selected, but the dates its text proves are outside the ask."
    if selected:
        return "Selected WITHOUT dates proven by the document's text."
    if decision == "include":
        return "Matched the request but was left out of the final package."
    if decision == "exclude":
        if proven:
            return "Left out: its text covers dates outside the ask."
        return f"Left out: {engine_reason}" if engine_reason else "Left out by the document check."
    if decision == "uncertain":
        return f"Uncertain: {engine_reason}" if engine_reason else "Uncertain."
    if decision == "unreadable":
        return f"Could not be read ({unreadable})."
    if decision == "not_evaluated":
        return (
            "Not checked: the per-ask model-call cap stopped the run."
            if capped
            else "Not checked: the run stopped before this document."
        )
    return decision


_ORDINAL_MONTHS = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)


def _span_text(start: str, end: str) -> str:
    low, high = _day(start), _day(end)
    if not low or not high:
        return f"{start} to {end}"
    return (
        f"{_ORDINAL_MONTHS[low.month - 1]} {low.day}, {low.year} to "
        f"{_ORDINAL_MONTHS[high.month - 1]} {high.day}, {high.year}"
    )


def owner_review(session: AskSession, documents: list[dict], outcome: dict) -> dict:
    """What Manish would see before Allow: files, coverage, price, and whether Allow is on."""
    from hushh_mcp.services.drive_request_package_disclosure import build_package_disclosure

    trace = session.trace
    record = trace.package or {}
    package = record.get("package")
    public = record.get("public") or {}
    by_position = {row["position"]: row for row in documents}
    files = []
    disclosure = None
    if package:
        for position in package.get("selected_positions") or []:
            row = by_position.get(position, {})
            files.append(
                {
                    "position": position,
                    "document_id": row.get("document_id"),
                    "file_name": row.get("file_name"),
                    "period_start": row.get("period_start") if row.get("period_proven") else None,
                    "period_end": row.get("period_end") if row.get("period_proven") else None,
                    "flags": row.get("flags", []),
                }
            )
        try:
            disclosure = build_package_disclosure(
                package=package,
                purpose=session.ask.purpose,
                observations=list(trace.observations.values()),
            )
        except Exception as error:  # noqa: BLE001 - shown as the disclosure failure
            trace.error("disclosure", _error_code(error))
    periods = (disclosure or {}).get("periods") or []
    sentence = (
        "Covers " + "; ".join(_span_text(item["start"], item["end"]) for item in periods)
        if periods
        else "No dates inside the ask are proven by the selected documents."
        if package
        else None
    )
    answer = (package or {}).get("assessment") or (record.get("assessment") or {})
    would_allow = bool(public.get("canAllow"))
    why_not = None
    if not would_allow:
        why_not = (
            record.get("finalize_error")
            or (f"package_{record.get('status')}" if record.get("status") else None)
            or outcome.get("code")
            or "package_not_reached"
        )
    return {
        "status": public.get("status") or record.get("status") or "not_reached",
        "files": files,
        "coverage_text": public.get("summary") or answer.get("coverage_summary"),
        "coverage_sentence": sentence,
        "coverage_status": (disclosure or {}).get("coverageStatus")
        or answer.get("coverage_status"),
        "limitations": (disclosure or {}).get("limitations") or [],
        "gaps": answer.get("gaps") or [],
        "decision": answer.get("decision"),
        "confidence": answer.get("confidence"),
        "importance": answer.get("importance"),
        "price_cents": public.get("suggestedPriceCents") or answer.get("suggested_price_cents"),
        "price_reason": public.get("priceReason") or answer.get("rationale"),
        "would_allow_now": would_allow,
        "why_not": why_not,
    }


def buyer_checks(session: AskSession) -> list[dict]:
    admission = session.runtime.admission or {}
    owner = session.owner_checks

    def owner_check(name, value, note):
        status = (
            "passed"
            if value is True or value == "on"
            else "failed"
            if value is not None
            else "not_run"
        )
        return {"name": name, "status": status, "note": note}

    return [
        owner_check(
            "owner_drive_live_and_verified",
            owner.get("drive_live_verified"),
            "Manish's Drive connection is live and verified (read-only check).",
        ),
        owner_check(
            "owner_drive_identity",
            owner.get("drive_identity_matches_owner"),
            "Google Drive /about names the account Manish connected.",
        ),
        owner_check(
            "owner_background_preparation",
            owner.get("background_preparation"),
            "Manish allows background preparation (read-only check).",
        ),
        {
            "name": "owner_sharing_admission",
            "status": "passed" if admission.get("drive_document_sharing") else "failed",
            "note": "UAT's rollout settings admit Manish for document sharing.",
        },
        {
            "name": "agent_package_enrollment",
            "status": "passed" if session.runtime.agent_packages_enabled else "failed",
            "note": "UAT prepares a package for Manish's Allow (DRIVE_AGENT_PACKAGES_ENABLED).",
        },
        {
            "name": "requester_google_identity",
            "status": "skipped_in_dry_run",
            "note": "Chris is simulated. The app requires exactly one linked Google account.",
        },
        {
            "name": "requester_connection_with_owner",
            "status": "skipped_in_dry_run",
            "note": "The app requires an active connection between Chris and Manish.",
        },
        {
            "name": "requester_sharing_admission",
            "status": "skipped_in_dry_run",
            "note": "The app checks Chris is admitted to document sharing.",
        },
        {
            "name": "existing_access_preflight",
            "status": "skipped_in_dry_run",
            "note": "Before checkout the app checks which files Chris can already open.",
        },
        {
            "name": "checkout_and_payment",
            "status": "skipped_in_dry_run",
            "note": "No order or Stripe session. UAT checkout uses live Stripe keys.",
        },
        {
            "name": "delivery",
            "status": "skipped_in_dry_run",
            "note": "No Drive permission is created; nothing is shared.",
        },
    ]


def match_packets(rows, store, *, ask: AskInput, terms, policy, engine_packet=None) -> list[dict]:
    """Rank the owner's packets for this ask: the engine's match first, then overlaps."""
    start, end = _day(ask.period_start), _day(ask.period_end)
    words = {
        word
        for term in [*terms, *re.findall(r"[A-Za-z]{4,}", ask.prompt)]
        for word in re.findall(r"[a-z0-9]{4,}", str(term).casefold())
    } - {
        "need",
        "months",
        "month",
        "from",
        "that",
        "contains",
        "with",
        "last",
        "this",
        "statements",
    }
    engine_id = (engine_packet or {}).get("packetId")
    matches = []
    for row in rows:
        try:
            manifest = store._manifest(row) if row.get("manifest_envelope") else {}
            key = store._key(row) if row.get("key_envelope") else {}
        except Exception:  # noqa: BLE001 - an unreadable envelope is skipped
            continue
        assessment = manifest.get("assessment") or {}
        title = assessment.get("title") or key.get("title") or "Packet"
        text_value = " ".join(
            str(value)
            for value in (title, assessment.get("description"), assessment.get("coverage_summary"))
            if value
        ).casefold()
        periods = [
            item
            for item in assessment.get("periods") or []
            if isinstance(item, dict) and item.get("start") and item.get("end")
        ]
        overlap = [item for item in periods if _overlaps(item["start"], item["end"], start, end)]
        hits = sorted(word for word in words if word in text_value)
        packet_id = str(row["packet_id"])
        engine_match = packet_id == engine_id
        if not (engine_match or overlap and hits):
            continue
        reasons = []
        if engine_match:
            reasons.append("the engine matched this packet exactly")
        if overlap:
            reasons.append(
                "covers "
                + "; ".join(_span_text(item["start"], item["end"]) for item in overlap[:3])
            )
        if hits:
            reasons.append("mentions " + ", ".join(hits[:4]))
        status = (
            "old_policy" if row.get("policy_version") != policy else row.get("state") or "unknown"
        )
        label = ""
        if periods:
            low = min(item["start"] for item in periods)
            high = max(item["end"] for item in periods)
            label = _span_text(low, high)
        matches.append(
            {
                "packet_id": packet_id,
                "title": title,
                "status": status,
                "period_label": label,
                "member_count": int(row.get("document_count") or 0),
                "listed": bool(row.get("listing_enabled")),
                "price_cents": row.get("listing_price_cents") or row.get("price_cents"),
                "why_matched": "; ".join(reasons),
                "engine_match": engine_match,
                "_score": (engine_match, status == "ready", len(hits), len(overlap)),
            }
        )
    matches.sort(key=lambda item: item["_score"], reverse=True)
    for item in matches:
        item.pop("_score")
    return matches[:20]


def _understood(session: AskSession) -> dict:
    trace = session.trace
    checkpoint = trace.checkpoint or {}
    plan = trace.planner_plan or {}
    route = checkpoint.get("evidence_route")
    terms = list(checkpoint.get("request_subject_terms") or [])
    groups = plan.get("term_groups") or [[term] for term in terms]
    kind = checkpoint.get("request_file_kind") or plan.get("file_kind")
    snapshot = checkpoint.get("index_snapshot") or {}
    parts = []
    if groups:
        parts.append(
            "search words: " + " AND ".join("(" + " OR ".join(group) + ")" for group in groups)
        )
    elif checkpoint.get("request_exact_title"):
        parts.append("the file named " + json.dumps(checkpoint["request_exact_title"]))
    elif route in {"index", "packet"}:
        parts.append("every indexed document, judged by meaning")
    if kind and kind != "any":
        parts.append(f"file type: {kind}")
    if session.ask.period_start and session.ask.period_end:
        parts.append(
            "dates "
            + _span_text(session.ask.period_start, session.ask.period_end)
            + " (checked against each document's text)"
        )
    if route == "hybrid":
        parts.append(
            f"index not complete ({snapshot.get('indexed', 0)} of "
            f"{snapshot.get('discovered', 0)} files indexed): indexed files plus a Drive search"
        )
    elif route == "provider":
        parts.append("index not used: Drive search only")
    elif route == "index":
        parts.append("complete index: every indexed file is a candidate")
    elif route == "packet":
        parts.append("an existing packet matched")
    return {
        "summary": "; ".join(parts) if parts else None,
        "kinds": [kind] if kind else [],
        "period_start": session.ask.period_start,
        "period_end": session.ask.period_end,
        "terms": terms,
        "term_groups": groups,
        "exact_title": checkpoint.get("request_exact_title"),
        "result_limit": checkpoint.get("request_result_limit"),
        "time_intent": checkpoint.get("request_time_intent") or plan.get("time_intent"),
        "route": route,
        "fallback_reason": (checkpoint.get("coverage_manifest") or {}).get("fallbackReason"),
        "index": {
            key: snapshot.get(key)
            for key in ("complete", "discovered", "indexed", "failed", "pending")
        }
        if snapshot
        else None,
        "plan_source": "planner_model"
        if trace.planner_plan
        else "fixed_index_plan"
        if route in {"index", "packet"}
        else "none",
    }


def _rows_view(trace: AskTrace) -> list[dict]:
    direct = bool((trace.checkpoint or {}).get("request_direct_originals"))
    rows = []
    for file_id in trace.row_order:
        row = trace.rows[file_id]
        if row["kept"] is None and direct and row["mime"] in {FOLDER_MIME, SHORTCUT_MIME}:
            row.update(kept=False, drop_stage="search_filter", drop_reason="direct_originals_only")
        rows.append(
            {
                "file_id": file_id,
                "file_name": row["file_name"],
                "mime": row["mime"],
                "modified_time": row["modified_time"],
                "created_time": row["created_time"],
                "kept": row["kept"] is True,
                "drop_stage": row["drop_stage"] if row["kept"] is not None else "not_filtered",
                "drop_reason": row["drop_reason"]
                if row["kept"] is not None
                else "search_stopped_before_this_row",
                "seen": row["seen"],
            }
        )
    return rows


def shape_result(session: AskSession, outcome: dict, states: dict, packets: list) -> dict:
    """The /api/ask payload."""
    trace = session.trace
    documents = document_rows(session, states)
    review = owner_review(session, documents, outcome)
    rows = _rows_view(trace)
    checkpoint = trace.checkpoint or {}
    counters = checkpoint.get("coverage_counts") or {}
    marks = trace.marks
    total = trace.ms()
    list_calls = [call for call in trace.calls if call["op"] == "list"]
    search_end = marks.get("search_done", marks.get("engine_done", total))
    search_start = marks.get("search_created", marks.get("preflight_done", 0))
    drive_ms = sum(
        call["ms"]
        for call in trace.calls
        if search_start <= call["t"] <= search_end and call["op"] != "about"
    )
    plan_ms = max(0, search_start - marks.get("preflight_done", 0))
    search_ms = max(0, search_end - search_start)
    select_ms = max(0, marks.get("package_done", marks.get("engine_done", total)) - search_end)
    rejected: Counter = Counter()
    for row in rows:
        if not row["kept"] and row["drop_stage"] == "search_filter":
            rejected[row["drop_reason"]] += 1
        elif row["drop_stage"] == "rank_limit":
            rejected["beyond_requested_count"] += 1
    for document in documents:
        decision = document["decision"]
        if decision == "exclude":
            rejected[
                "content_period_outside_window"
                if "content_period_outside_window" in document["flags"]
                else "content_does_not_match"
            ] += 1
        elif decision == "uncertain":
            rejected["uncertain"] += 1
        elif decision == "unreadable":
            rejected[
                f"unreadable:{(trace.observations.get(document['position']) or {}).get('unreadable_reason')}"
            ] += 1
        elif decision == "not_evaluated":
            rejected["not_evaluated"] += 1
        elif decision == "include" and not document["selected"]:
            rejected["not_in_final_package"] += 1
    selected = [row for row in documents if row["selected"]]
    included = [row for row in documents if row["decision"] == "include"]
    counts = {
        "drive_rows": len(rows),
        "candidates": len(documents),
        "indexed": sum(row["indexed_state"] == "indexed" for row in documents),
        "period_proven": sum(row["period_proven"] for row in included),
        "selected": len(selected),
        "not_indexed": sum(row["indexed_state"] != "indexed" for row in documents),
        "evaluated": sum(row["evaluated"] for row in documents),
        "included": len(included),
        "claimed": sum(row["claimed"] for row in documents),
        "from_index": sum(row["source"] == "index" for row in documents),
        "from_drive_search": sum(row["source"] == "drive_search" for row in documents),
        "list_calls": len(list_calls),
        "list_rows": sum(call.get("rows") or 0 for call in list_calls),
    }
    pattern = {
        "filename_rule_drops": int(counters.get("excludedByFilenameCount", 0)),
        "file_date_rule_drops": int(counters.get("excludedByDateCount", 0)),
        "selected_only_by_modified_time": sum(
            "selected_only_by_modified_time" in row["flags"] for row in documents
        ),
        "selected_period_not_proven": sum(
            "selected_period_not_proven" in row["flags"] for row in documents
        ),
        "selected_period_outside_window": sum(
            "selected_period_outside_window" in row["flags"] for row in documents
        ),
        "selected_by_filename_only": sum(
            "selected_by_filename_only" in row["flags"] for row in documents
        ),
        "kept_despite_filename_lacking_words": sum(
            "filename_lacks_request_words" in row["flags"] for row in documents
        ),
    }
    pattern["reappeared"] = bool(
        pattern["filename_rule_drops"]
        or pattern["file_date_rule_drops"]
        or pattern["selected_only_by_modified_time"]
        or pattern["selected_period_not_proven"]
        or pattern["selected_period_outside_window"]
        or pattern["selected_by_filename_only"]
    )
    search_done = bool(trace.search_pages) and trace.search_pages[-1]["state"] == "completed"
    package_done = bool((trace.package or {}).get("package"))
    pattern["search_checked"] = search_done
    pattern["selection_checked"] = package_done
    pattern["verdict"] = (
        "reappeared"
        if pattern["reappeared"]
        else "not_seen"
        if search_done and package_done
        else "not_determinable"
    )
    pattern["why"] = (
        None
        if pattern["verdict"] != "not_determinable"
        else "the search did not finish"
        if not search_done
        else "the run stopped before the package was assembled"
    )
    meter = session.meter.summary()
    steps = _steps(
        session, rows, documents, counts, review, plan_ms, search_ms, select_ms, drive_ms
    )
    engine = dict(session.runtime.engine)
    return {
        "ask_id": session.ask_id,
        "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "as_buyer": AS_BUYER,
        "owner": OWNER_LABEL,
        "prompt": session.ask.prompt,
        "as_of": session.ask.as_of.isoformat(timespec="seconds"),
        "outcome": outcome,
        "engine": {
            "entry_point": ENTRY_POINT,
            "continuations": list(CONTINUATIONS),
            "engine_sha": engine.get("engine_sha"),
            "deployed_sha": engine.get("deployed_sha"),
            "deployed_revision": engine.get("deployed_revision"),
            "match": bool(engine.get("match")),
            "differing_files": engine.get("differing_files", []),
            "dry_run": True,
            "mode": "deployed" if session.fence.mode == "deployed" else "what_if_index_frozen",
            "deviations": _deviations(session),
            "index_fence": session.fence.summary(),
            "authority_mode": checkpoint.get("authority_mode"),
            "environment_notes": list(session.runtime.environment_notes),
            "read_only": session.runtime.db.stats.public(),
            "drive_requests": sum(1 for _ in trace.calls),
        },
        "understood": _understood(session),
        "drive_api": {
            "calls": trace.calls[:5000],
            "calls_truncated": len(trace.calls) > 5000,
            "rows": rows,
            "summary": {
                "searches": len({(call.get("q"), call.get("corpus")) for call in list_calls}),
                "list_pages": len(list_calls),
                "rows_returned": counts["list_rows"],
                "unique_files": len(rows),
                "by_operation": dict(Counter(call["op"] for call in trace.calls)),
            },
        },
        "steps": steps,
        "documents": documents,
        "owner_review": review,
        "buyer_checks": buyer_checks(session),
        "matching_packets": packets,
        "counts": counts,
        "rejected_by_reason": dict(sorted(rejected.items())),
        "pattern_13oct": pattern,
        "logs": trace.logs[-2000:],
        "errors": trace.errors,
        "skipped": sorted(set(trace.skipped)),
        "timings_ms": {
            "plan": plan_ms,
            "drive": drive_ms,
            "filter": max(0, search_ms - drive_ms),
            "select": select_ms,
            "total": total,
        },
        "model_calls": meter["calls"],
        "est_cost_usd": meter["est_cost_usd"],
        "model": meter,
    }


def _deviations(session: AskSession) -> list[str]:
    """Where this dry run differs from UAT, in plain words."""
    items = [
        "State is kept in memory: no request row, search job, package, order or share is written.",
        "Chris is simulated: buyer checks are skipped.",
        "Model calls run one at a time and stop at the per-ask cap.",
    ]
    if session.fence.mode == "frozen":
        items.insert(
            0,
            "WHAT-IF: the owner's index is held at its first snapshot; UAT stops with "
            "source_changed when the index changes during a search.",
        )
    else:
        items.append(
            "A passing index check is reused for up to 20 seconds; UAT rescans on every store call."
        )
    if session.runtime.db.stats.timeouts_relaxed:
        items.append(
            f"Store transactions may run {RELAXED_STATEMENT_TIMEOUT} instead of UAT's 5 s: "
            "the local database link is slower than UAT's."
        )
    items.extend(session.runtime.environment_notes)
    return items


def _steps(session, rows, documents, counts, review, plan_ms, search_ms, select_ms, drive_ms):
    trace = session.trace
    checkpoint = trace.checkpoint or {}
    counters = checkpoint.get("coverage_counts") or {}
    kept_rows = sum(row["kept"] for row in rows)
    folders = sum(row["drop_stage"] == "folder" for row in rows)
    filtered = sum(not row["kept"] and row["drop_stage"] == "search_filter" for row in rows)
    evaluated = [row for row in documents if row["evaluated"]]
    readable = [row for row in evaluated if row["decision"] != "unreadable"]
    included = [row for row in documents if row["decision"] == "include"]
    route = checkpoint.get("evidence_route")
    return [
        {
            "name": "route_and_plan",
            "in": 1,
            "kept": 1 if checkpoint else 0,
            "dropped": 0 if checkpoint else 1,
            "ms": plan_ms,
            "notes": f"route={route}; planner calls={session.meter.summary()['by_stage'].get('plan', 0)}",
        },
        {
            "name": "drive_search",
            "in": len(rows),
            "kept": kept_rows,
            "dropped": filtered,
            "ms": search_ms,
            "notes": (
                f"{counts['list_calls']} list pages, {drive_ms} ms in Drive; "
                f"{folders} folders searched inside; filename rule dropped "
                f"{counters.get('excludedByFilenameCount', 0)}"
            ),
        },
        {
            "name": "candidates",
            "in": kept_rows + counts["from_index"],
            "kept": counts["candidates"],
            "dropped": trace.deduplicated + len(trace.pruned),
            "ms": 0,
            "notes": (
                f"{counts['from_index']} from the index, {counts['from_drive_search']} from Drive search;"
                f" {trace.deduplicated} duplicates, {len(trace.pruned)} beyond a requested count"
            ),
        },
        {
            "name": "read_documents",
            "in": counts["candidates"],
            "kept": len(readable),
            "dropped": len(evaluated) - len(readable),
            "ms": select_ms,
            "notes": f"{counts['candidates'] - len(evaluated)} not checked",
        },
        {
            "name": "assess_documents",
            "in": len(readable),
            "kept": len(included),
            "dropped": len(readable) - len(included),
            "ms": 0,
            "notes": f"model calls={session.meter.summary()['by_stage'].get('assess_documents', 0)}",
        },
        {
            "name": "assess_package",
            "in": len(included),
            "kept": counts["selected"],
            "dropped": max(0, len(included) - counts["selected"]),
            "ms": 0,
            "notes": f"decision={review.get('decision')}; with proven dates={counts['claimed']}",
        },
        {
            "name": "owner_review",
            "in": counts["selected"],
            "kept": counts["selected"] if review.get("would_allow_now") else 0,
            "dropped": 0 if review.get("would_allow_now") else counts["selected"],
            "ms": 0,
            "notes": "Allow is on"
            if review.get("would_allow_now")
            else f"Allow is off: {review.get('why_not')}",
        },
    ]


def ask_summary(result: dict) -> dict:
    """What the accuracy view needs from one ask (engine claim, by document)."""
    return {
        "ask_id": result["ask_id"],
        "source": "dry_run",
        "created_at": result.get("created_at"),
        "prompt": result.get("prompt"),
        "period_start": (result.get("understood") or {}).get("period_start"),
        "period_end": (result.get("understood") or {}).get("period_end"),
        "outcome": (result.get("outcome") or {}).get("status"),
        "selected": [
            row["document_id"] or f"position:{row['position']}"
            for row in result.get("documents", [])
            if row.get("selected")
        ],
        "claimed": [
            row["document_id"] or f"position:{row['position']}"
            for row in result.get("documents", [])
            if row.get("claimed")
        ],
        "pattern_13oct_reappeared": (result.get("pattern_13oct") or {}).get("reappeared"),
    }


def load_ask(private_dir: Path, ask_id: str) -> dict | None:
    """A saved ask's result, or None. The id is validated before any path is built."""
    if not isinstance(ask_id, str) or not ASK_ID.fullmatch(ask_id):
        return None
    path = Path(private_dir) / "asks" / f"{ask_id}.json"
    if not path.is_file():
        return None
    return json.loads(path.read_text()).get("result")


async def run_ask(
    runtime: EngineRuntime,
    prompt,
    period_start=None,
    period_end=None,
    *,
    as_of=None,
    max_model_calls: int | None = None,
    index_fence: str = "deployed",
    on_progress: Callable[[dict], None] | None = None,
) -> dict:
    """POST /api/ask: one dry run on the deployed engine, as Chris (simulated) asking Manish.

    ``index_fence="frozen"`` is the labelled what-if: the owner's index is held at the
    route's snapshot, so a still-indexing Drive does not stop the search.
    """
    if index_fence not in INDEX_FENCES:
        raise AskRefused("index_fence_invalid")
    ask = parse_ask(prompt, period_start, period_end, as_of=as_of)
    limits = runtime.limits.bounded(max_model_calls=max_model_calls)
    session = AskSession(runtime, ask, limits=limits, index_fence=index_fence)
    session.on_progress = on_progress
    return await session.run()


# --- Live runtime ---------------------------------------------------------------------
FLAG_KEYS = {
    "google_drive_live": "GOOGLE_DRIVE_LIVE",
    "drive_document_indexing": "DRIVE_DOCUMENT_INDEXING",
    "drive_document_sharing": "DRIVE_DOCUMENT_SHARING",
    "google_drive_chat_reads": "GOOGLE_DRIVE_CHAT_READS",
}


def resolve_owner_id(live_env: Path = LIVE_ENV_FILE) -> str:
    """Manish's id, exactly as the eval's run-batch gets it (DRIVE_PACKET_EVAL_OWNER).

    The eval's live-env.sh sets it from one founder file's ``identities.owner.user_id``;
    nothing else in that file is read.
    """
    value = os.environ.get("DRIVE_PACKET_EVAL_OWNER")
    if not value:
        text_value = live_env.read_text() if live_env.is_file() else ""
        match = re.search(
            r'DRIVE_PACKET_EVAL_OWNER="\$\(python3 -c .*?open\("([^"]+)"\)\)\["identities"\]\["owner"\]\["user_id"\]',
            text_value,
        )
        if not match:
            raise AskRefused("owner_configuration_missing")
        value = json.loads(Path(match.group(1)).read_text())["identities"]["owner"]["user_id"]
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{5,127}", value):
        raise AskRefused("owner_id_invalid")
    return value


@contextlib.contextmanager
def _temporary_environ(values: dict):
    saved = {name: os.environ.get(name) for name in values}
    try:
        for name, value in values.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        yield
    finally:
        for name, value in saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def deployed_admission(config: dict, owner_id: str) -> dict:
    """UAT's rollout decision for the owner: the production predicate on UAT's settings."""
    from hushh_mcp.services.connector_feature_admission import connector_feature_enabled

    values = {"ENVIRONMENT": "uat"}
    for key, env_name in {
        **FLAG_KEYS,
        "connector_internal_owner_cohort": "CONNECTOR_INTERNAL_OWNER_COHORT",
        "connector_uat_all_users": "CONNECTOR_UAT_ALL_USERS",
    }.items():
        value = config.get(key)
        values[env_name] = (
            None
            if value is None
            else str(value).strip().lower()
            if isinstance(value, bool)
            else str(value)
        )
    with _temporary_environ(values):
        return {feature: connector_feature_enabled(feature, owner_id) for feature in FLAG_KEYS}


def configure_engine_environment(
    *, owner_id: str, deployed_env: dict, flags: dict, admission: dict, secrets: dict
) -> None:
    """Make this process decide like UAT does for the owner, without its hosted side effects.

    ``ENVIRONMENT`` is ``local`` so drain wake-ups and hosted-only paths stay off; the
    rollout settings are reproduced for the owner alone. Call before any engine import.
    """
    for name in (
        "DRIVE_WORK_DRAIN_ENABLED",
        "CONNECTOR_UAT_ALL_USERS",
        "GOOGLE_APPLICATION_CREDENTIALS",
    ):
        os.environ.pop(name, None)
    for name in ("DB_HOST", "DB_UNIX_SOCKET", "DB_USER", "DB_PASSWORD"):
        os.environ.pop(name, None)
    os.environ["ENVIRONMENT"] = "local"
    for name in (
        "HUSSH_GEMINI_TEXT_MODEL",
        "GENAI_GOOGLE_CLOUD_PROJECT",
        "HUSHH_GENAI_AUTH_MODE",
        "GOOGLE_GENAI_USE_VERTEXAI",
    ):
        if deployed_env.get(name):
            os.environ[name] = deployed_env[name]
    os.environ["GOOGLE_CLOUD_LOCATION"] = deployed_env.get("GOOGLE_CLOUD_LOCATION") or "global"
    for feature, env_name in FLAG_KEYS.items():
        os.environ[env_name] = "true" if admission.get(feature) else "false"
    if any(admission.get(feature) for feature in FLAG_KEYS):
        os.environ["CONNECTOR_INTERNAL_OWNER_COHORT"] = owner_id
    else:
        os.environ.pop("CONNECTOR_INTERNAL_OWNER_COHORT", None)
    os.environ["DRIVE_AGENT_PACKAGES_ENABLED"] = (
        "true" if flags.get("drive_agent_packages_enabled") else "false"
    )
    for name in ("DRIVE_DOCUMENT_KEY_V1", "EXTERNAL_CONNECTOR_CREDENTIAL_KEY"):
        os.environ[name] = secrets[name]


def build_live_runtime(
    *,
    owner_id: str | None = None,
    db_port: int = 6657,
    private_dir: Path | None = DEFAULT_PRIVATE_DIR,
    limits: AskLimits | None = None,
    command=None,
) -> EngineRuntime:
    """Read UAT's serving revision and settings (describe and secret reads only)."""
    from hushh_eval.drive_packets import sources

    sources.require_live_opt_in()
    owner_id = owner_id or resolve_owner_id()
    run = command or sources._gcloud
    backend = sources.describe_service(sources.BACKEND_SERVICE, run)
    provenance = sources.service_provenance(backend)
    container = backend["spec"]["template"]["spec"]["containers"][0]
    deployed_env = {
        item["name"]: item["value"] for item in container.get("env", []) if "value" in item
    }
    names = (
        "DB_USER",
        "DB_PASSWORD",
        "GOOGLE_DRIVE_OAUTH_CLIENT_ID",
        "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET",
        "EXTERNAL_CONNECTOR_CREDENTIAL_KEY",
        "DRIVE_DOCUMENT_KEY_V1",
        "BACKEND_RUNTIME_CONFIG_JSON",
    )
    secrets = sources.resolve_env(backend, names, run)
    if set(names) - set(secrets):
        raise RuntimeError("uat_secret_missing")
    config = json.loads(secrets.pop("BACKEND_RUNTIME_CONFIG_JSON") or "{}")

    def truthy(value) -> bool:
        return str(value).strip().lower() == "true"

    flags = {key: truthy(config.get(key)) for key in (*FLAG_KEYS, "drive_agent_packages_enabled")}
    admission = deployed_admission(config, owner_id)
    deployed_env.setdefault(
        "GOOGLE_CLOUD_LOCATION", config.get("google_cloud_location") or "global"
    )
    db_name = str(config.get("db_name") or "postgres")
    del config
    configure_engine_environment(
        owner_id=owner_id,
        deployed_env=deployed_env,
        flags=flags,
        admission=admission,
        secrets=secrets,
    )
    from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

    model = resolve_fleet_model_name("gemini-default")
    if (
        deployed_env.get("HUSSH_GEMINI_TEXT_MODEL")
        and model != deployed_env["HUSSH_GEMINI_TEXT_MODEL"]
    ):
        raise RuntimeError("runtime_model_differs_from_deployed")
    engine = sources.read_only_engine(
        user=secrets["DB_USER"],
        password=secrets["DB_PASSWORD"],
        database=db_name,
        host="127.0.0.1",
        port=db_port,
    )
    db = ReadOnlyDb(engine, owner_id)
    credential = OwnerCredential(
        owner_id=owner_id,
        db=db,
        client_id=secrets["GOOGLE_DRIVE_OAUTH_CLIENT_ID"],
        client_secret=secrets["GOOGLE_DRIVE_OAUTH_CLIENT_SECRET"],
    )
    identity = engine_identity(
        deployed_revision=provenance["revision"], deployed_sha=provenance["deploy_sha"]
    )
    notes = []
    if shutil.which("tesseract") is None:
        notes.append("no_local_ocr: scanned pages read live here have no OCR; UAT's image has it")
    notes.append("index_signature_checked_at_start_only: UAT rechecks it on every search page")
    return EngineRuntime(
        owner_id=owner_id,
        db=db,
        credential=credential,
        interpreters=Interpreters.deployed(),
        engine=identity,
        model=model,
        agent_packages_enabled=flags["drive_agent_packages_enabled"],
        private_dir=Path(private_dir) if private_dir else None,
        limits=limits or AskLimits(),
        admission=admission,
        environment_notes=notes,
    )


# --- CLI (operator check; prints codes and counts only) -------------------------------
def _public_summary(result: dict) -> dict:
    return {
        "ask_id": result["ask_id"],
        "outcome": result["outcome"],
        "engine": {
            key: result["engine"][key]
            for key in (
                "deployed_revision",
                "deployed_sha",
                "engine_sha",
                "match",
                "authority_mode",
                "mode",
                "index_fence",
            )
        },
        "route": result["understood"].get("route"),
        "fallback_reason": result["understood"].get("fallback_reason"),
        "index": result["understood"].get("index"),
        "terms_count": len(result["understood"].get("terms") or []),
        "counts": result["counts"],
        "rejected_by_reason": result["rejected_by_reason"],
        "pattern_13oct": result["pattern_13oct"],
        "owner_review": {
            key: result["owner_review"].get(key)
            for key in (
                "status",
                "decision",
                "coverage_status",
                "would_allow_now",
                "why_not",
                "price_cents",
            )
        }
        | {"files": len(result["owner_review"].get("files") or [])},
        "matching_packets": len(result["matching_packets"]),
        "timings_ms": result["timings_ms"],
        "model_calls": result["model_calls"],
        "est_cost_usd": result["est_cost_usd"],
        "model_capped": result["model"].get("capped"),
        "drive_calls": result["drive_api"]["summary"]["by_operation"],
        "read_only": result["engine"]["read_only"],
        "errors": [item["code"] for item in result["errors"]][:20],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Dry-run one ask on the deployed engine (codes only)."
    )
    parser.add_argument("--preset", required=True, choices=[item["id"] for item in presets()])
    parser.add_argument("--max-model-calls", type=int, default=None)
    parser.add_argument("--index-fence", choices=INDEX_FENCES, default="deployed")
    parser.add_argument("--db-port", type=int, default=6657)
    args = parser.parse_args(argv)
    item = preset(args.preset)
    runtime = build_live_runtime(db_port=args.db_port)
    result = asyncio.run(
        run_ask(
            runtime,
            item["prompt"],
            item["period_start"],
            item["period_end"],
            as_of=item["as_of"],
            max_model_calls=args.max_model_calls,
            index_fence=args.index_fence,
            on_progress=lambda value: print(
                json.dumps({"progress": value}, sort_keys=True), file=sys.stderr, flush=True
            ),
        )
    )
    print(json.dumps(_public_summary(result), sort_keys=True, default=str), flush=True)
    return 0 if result["outcome"]["status"] in {"completed", "capped", "stopped"} else 1


if __name__ == "__main__":
    sys.exit(main())
