"""A throwaway PostgreSQL cluster carrying the REAL PKM engine.

This is what makes the conformance oracle an oracle rather than a wish list: the
suite runs first against the genuine stored procedures on a real Postgres 16,
proving the ASSERTIONS before any port exists. A suite that has never passed
against the known-good implementation proves nothing about a new one.

The cluster is process-local and disposable: ``initdb`` into a temp dir, unix
socket only (no TCP listener), torn down after the run. Schema = ``prelude.sql``
(the minimum neighbours, see that file) + ``MIGRATIONS`` (the real migration
files, applied verbatim, in the order proven by running
``db/verify/pkm_v7_zero_loss_rehearsal.sql`` to completion).

Root note: ``initdb`` refuses to run as root, and CI containers often are. When
euid==0 and a ``postgres`` system user exists, the harness runs the server as
that user in a world-writable scratch dir; otherwise it runs directly.
"""

from __future__ import annotations

import atexit
import glob
import hashlib
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable, Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
PRELUDE = Path(__file__).with_name("prelude.sql")
REHEARSAL = REPO_ROOT / "db" / "verify" / "pkm_v7_zero_loss_rehearsal.sql"

# The proven recipe. Order is load-bearing (later files ALTER earlier tables and
# CREATE OR REPLACE earlier functions). 066 is deliberately absent: it needs the
# marketplace profile tables and nothing in the PKM chain reads what it adds.
MIGRATIONS = [
    "030_pkm_cutover.sql",
    "034_pkm_upgrade_engine.sql",
    "048_merge_pkm_domain_summary_rpc.sql",
    "063_pkm_default_available_visibility.sql",
    "074_pkm_scope_registry_owner_consent_override.sql",
    "089_atomic_pkm_mutation_v2.sql",
    "090_public_profile_projection_foundation.sql",
    "091_public_profile_projection_cutover.sql",
    "096_atomic_pkm_mutation_v3_scope_posture.sql",
    "098_pkm_v7_recovery_foundation.sql",
    "123_pkm_device_sync.sql",
]

_PG_BIN_ENV = "HUSHH_TEST_PG_BIN"
_DISABLE_TEMPLATE_CACHE_ENV = "HUSHH_DISABLE_PG_TEMPLATE_CACHE"
_TEMPLATE_CACHE_ROOT: Optional[Path] = None
_TEMPLATE_CACHE_PID: Optional[int] = None
_TEMPLATE_DATA_DIRS: dict[str, Path] = {}


def template_cache_enabled() -> bool:
    return (os.getenv(_DISABLE_TEMPLATE_CACHE_ENV) or "").strip() != "1"


def _ensure_template_cache_root() -> Path:
    global _TEMPLATE_CACHE_PID, _TEMPLATE_CACHE_ROOT
    pid = os.getpid()
    if (
        _TEMPLATE_CACHE_ROOT is None
        or _TEMPLATE_CACHE_PID != pid
        or not _TEMPLATE_CACHE_ROOT.exists()
    ):
        _TEMPLATE_DATA_DIRS.clear()
        root = Path(tempfile.mkdtemp(prefix=f"hushh-pg-tpl-{pid}-"))
        os.chmod(root, 0o777)  # noqa: S103 - disposable local test fixture cache
        _TEMPLATE_CACHE_ROOT = root
        _TEMPLATE_CACHE_PID = pid

        def _cleanup(target: Path = root, owner_pid: int = pid) -> None:
            if os.getpid() == owner_pid:
                shutil.rmtree(target, ignore_errors=True)

        atexit.register(_cleanup)
    return _TEMPLATE_CACHE_ROOT


def clone_cluster_data_dir(src: Path, dst: Path) -> None:
    """Clone a cleanly stopped PGDATA directory using CoW/reflink when supported."""
    if sys.platform == "darwin":
        copied = subprocess.run(  # noqa: S603
            ["cp", "-Rc", str(src), str(dst)],
            capture_output=True,
            text=True,
            check=False,
        )
    else:
        copied = subprocess.run(  # noqa: S603
            ["cp", "-a", "--reflink=auto", str(src), str(dst)],
            capture_output=True,
            text=True,
            check=False,
        )
    if copied.returncode != 0:
        shutil.rmtree(dst, ignore_errors=True)
        shutil.copytree(src, dst)
    os.chmod(dst, 0o700)


def find_pg_bin() -> Optional[str]:
    override = (os.getenv(_PG_BIN_ENV) or "").strip()
    if override and (Path(override) / "initdb").exists():
        return override
    for candidate in sorted(glob.glob("/usr/lib/postgresql/*/bin"), reverse=True):
        if (Path(candidate) / "initdb").exists():
            return candidate
    if shutil.which("initdb"):
        return str(Path(shutil.which("initdb")).parent)
    return None


def _postgres_user_exists() -> bool:
    try:
        import pwd

        pwd.getpwnam("postgres")
        return True
    except KeyError:
        return False


class TempPostgres:
    """initdb + pg_ctl + real migrations, unix-socket only, disposable."""

    def __init__(self) -> None:
        self.bin = find_pg_bin()
        if self.bin is None:
            raise RuntimeError("no PostgreSQL binaries found")
        self.dir = tempfile.mkdtemp(prefix="hushh-pkm-oracle-")
        # World-writable ON PURPOSE, and only for this throwaway dir: when the
        # suite runs as root the server itself must run as the unprivileged
        # `postgres` user (initdb refuses root), which then needs to create the
        # data dir and socket here. The dir holds disposable test fixtures only
        # and is removed in stop().
        os.chmod(self.dir, 0o777)  # noqa: S103
        self.port = self._free_port()
        self._as_postgres = os.geteuid() == 0 and _postgres_user_exists()
        self._conn: Any = None

    @staticmethod
    def _free_port() -> int:
        import socket

        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    def _run(self, command: str) -> subprocess.CompletedProcess:
        env = os.environ.copy()
        env.setdefault("LC_ALL", "C")
        if self._as_postgres:
            argv = ["su", "postgres", "-s", "/bin/bash", "-c", command]
        else:
            argv = ["bash", "-c", command]
        return subprocess.run(argv, capture_output=True, text=True, check=False, env=env)  # noqa: S603

    def _init_and_boot_fresh(self, data: str) -> None:
        boot = self._run(
            f"{self.bin}/initdb -D {shlex.quote(data)} -U hushh --no-sync --no-locale --encoding=UTF8 -A trust >/dev/null 2>&1 && "
            f'{self.bin}/pg_ctl -D {shlex.quote(data)} -o "-k {self.dir} -p {self.port} '
            f"-c listen_addresses='' -c fsync=off\" -l {shlex.quote(f'{self.dir}/log')} -w start"
        )
        if boot.returncode != 0:
            raise RuntimeError(f"postgres failed to start: {boot.stdout} {boot.stderr}")

    def _boot_existing(self, data: str) -> None:
        boot = self._run(
            f'{self.bin}/pg_ctl -D {shlex.quote(data)} -o "-k {self.dir} -p {self.port} '
            f"-c listen_addresses='' -c fsync=off\" -l {shlex.quote(f'{self.dir}/log')} -w start"
        )
        if boot.returncode != 0:
            raise RuntimeError(
                f"postgres failed to start from template: {boot.stdout} {boot.stderr}"
            )

    def _connect_default(self) -> None:
        import psycopg2

        self._conn = psycopg2.connect(
            host=self.dir, port=self.port, user="hushh", dbname="postgres"
        )
        self._conn.autocommit = True

    def _clone_from_template(self, template_data: Path, target_data: Path) -> None:
        if self._as_postgres:
            copied = self._run(
                f"cp -a --reflink=auto {shlex.quote(str(template_data))} {shlex.quote(str(target_data))} "
                f"|| cp -a {shlex.quote(str(template_data))} {shlex.quote(str(target_data))}"
            )
            if copied.returncode != 0:
                raise RuntimeError(
                    f"failed to clone postgres template dir: {copied.stdout} {copied.stderr}"
                )
            return
        clone_cluster_data_dir(template_data, target_data)

    def _ensure_template_data_dir(
        self,
        cache_key: str,
        populate: Optional[Callable[["TempPostgres"], None]],
    ) -> Path:
        cache_root = _ensure_template_cache_root()
        cached = _TEMPLATE_DATA_DIRS.get(cache_key)
        if cached is not None and cached.exists():
            return cached

        digest = hashlib.sha256(cache_key.encode("utf-8")).hexdigest()[:24]
        template_data = cache_root / f"tpl-{digest}"
        if template_data.exists():
            shutil.rmtree(template_data, ignore_errors=True)

        builder = TempPostgres()
        builder_data = f"{builder.dir}/data"
        try:
            builder._init_and_boot_fresh(builder_data)
            builder._connect_default()
            if populate is not None:
                populate(builder)
            if builder._conn is not None:
                builder._conn.close()
                builder._conn = None
            stopped = builder._run(
                f"{builder.bin}/pg_ctl -D {shlex.quote(builder_data)} -m fast -w stop >/dev/null 2>&1"
            )
            if stopped.returncode != 0:
                raise RuntimeError(
                    f"postgres template failed clean shutdown: {stopped.stdout} {stopped.stderr}"
                )
            builder._run(
                f"rm -f {shlex.quote(f'{builder_data}/postmaster.opts')} "
                f"{shlex.quote(f'{builder_data}/postmaster.pid')}"
            )
            moved = builder._run(
                f"mv {shlex.quote(builder_data)} {shlex.quote(str(template_data))}"
            )
            if moved.returncode != 0:
                raise RuntimeError(
                    f"failed to store postgres template dir: {moved.stdout} {moved.stderr}"
                )
        finally:
            if builder._conn is not None:
                builder._conn.close()
                builder._conn = None
            if Path(builder_data).exists():
                builder._run(
                    f"{builder.bin}/pg_ctl -D {shlex.quote(builder_data)} -m immediate stop >/dev/null 2>&1"
                )
            shutil.rmtree(builder.dir, ignore_errors=True)

        _TEMPLATE_DATA_DIRS[cache_key] = template_data
        return template_data

    def start_with_recipe(
        self,
        recipe_key: str,
        populate: Optional[Callable[["TempPostgres"], None]] = None,
    ) -> None:
        data = f"{self.dir}/data"
        if not template_cache_enabled():
            self._init_and_boot_fresh(data)
            self._connect_default()
            if populate is not None:
                populate(self)
            return

        cache_key = f"{self.bin}|as_pg={int(self._as_postgres)}|{recipe_key}"
        template_data = self._ensure_template_data_dir(cache_key, populate)
        self._clone_from_template(template_data, Path(data))
        self._boot_existing(data)
        self._connect_default()

    def start(self) -> None:
        migrations_snapshot = tuple(MIGRATIONS)
        prelude_path = PRELUDE
        digest = hashlib.sha256()
        digest.update(prelude_path.read_bytes())
        digest.update(b"\0")
        for name in migrations_snapshot:
            migration_path = REPO_ROOT / "db" / "migrations" / name
            digest.update(name.encode("utf-8"))
            digest.update(b"\0")
            digest.update(migration_path.read_bytes())
            digest.update(b"\0")

        def _populate_default(cluster: "TempPostgres") -> None:
            cluster.apply_file(prelude_path)
            for name in migrations_snapshot:
                cluster.apply_file(REPO_ROOT / "db" / "migrations" / name)

        self.start_with_recipe(f"default:{digest.hexdigest()}", _populate_default)

    def apply_file(self, path: Path) -> None:
        sql = path.read_text(encoding="utf-8")
        with self._conn.cursor() as cur:
            cur.execute(sql)

    def execute(self, sql: str, params: Any = None) -> list[tuple]:
        with self._conn.cursor() as cur:
            cur.execute(sql, params)
            if cur.description is None:
                return []
            return cur.fetchall()

    # -- the engine transport ---------------------------------------------------------

    def make_run_rpc(self):
        """A ``run_rpc(fn, params)`` bound to this cluster, mirroring production.

        Argument names AND types come from ``pg_proc`` introspection, so the call
        is built exactly as the database declares it -- a drifted param name or
        type is an immediate error here, never a silent mismatch.
        Returns ``[{fn: value}]``, the direct-SQL client's envelope, so the
        service-side unwrap semantics apply unchanged.
        """
        from psycopg2.extras import Json

        signature_cache: dict[str, list[tuple[str, str]]] = {}

        def _signature(fn: str) -> list[tuple[str, str]]:
            if fn not in signature_cache:
                rows = self.execute(
                    "SELECT pg_get_function_identity_arguments(oid) FROM pg_proc "
                    "WHERE proname = %s",
                    (fn,),
                )
                if not rows:
                    raise RuntimeError(f"function {fn} not installed in the oracle cluster")
                parsed: list[tuple[str, str]] = []
                for piece in rows[0][0].split(", "):
                    name, _, type_name = piece.partition(" ")
                    parsed.append((name, type_name))
                signature_cache[fn] = parsed
            return signature_cache[fn]

        async def run_rpc(fn: str, params: Optional[dict] = None) -> Any:
            params = dict(params or {})
            pieces: list[str] = []
            values: dict[str, Any] = {}
            for name, type_name in _signature(fn):
                if name not in params:
                    continue
                value = params[name]
                if type_name == "jsonb":
                    value = Json(getattr(value, "value", value))
                pieces.append(f"{name} := %({name})s::{type_name}")
                values[name] = value
            rows = self.execute(f"SELECT {fn}({', '.join(pieces)}) AS result", values)
            return [{fn: rows[0][0]}] if rows else []

        return run_rpc

    def stop(self) -> None:
        try:
            if self._conn is not None:
                self._conn.close()
        finally:
            self._run(f"{self.bin}/pg_ctl -D {self.dir}/data -m immediate stop >/dev/null 2>&1")
            shutil.rmtree(self.dir, ignore_errors=True)
