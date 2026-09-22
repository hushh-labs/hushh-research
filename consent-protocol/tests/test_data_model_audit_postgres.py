"""Execute the audit SQL against synthetic records in a new, socket-only cluster."""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import psycopg2
import pytest
from psycopg2 import sql
from psycopg2.extensions import make_dsn

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "data_model_audit_pg", ROOT / "scripts/ops/data_model_audit.py"
)
assert SPEC and SPEC.loader
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


@pytest.fixture
def isolated_postgres():
    if os.geteuid() == 0 or not shutil.which("pg_config"):
        pytest.skip("Disposable PostgreSQL requires server binaries and a non-root test user")
    bindir = Path(subprocess.check_output(["pg_config", "--bindir"], text=True, timeout=5).strip())
    if not all((bindir / command).is_file() for command in ("initdb", "pg_ctl")):
        pytest.skip("PostgreSQL client-only installation; run this rehearsal with server binaries")
    # A private short path fits PostgreSQL's Unix socket limit. There is no TCP
    # listener, existing cluster, supplied connection string, or personal record.
    directory = Path(tempfile.mkdtemp(prefix="hussh-pkm-audit-", dir="/tmp"))
    data = directory / "data"
    started = False

    def run(command, *arguments, check=True):
        return subprocess.run(  # noqa: S603 - discovered server toolchain, authored fixture arguments
            [str(bindir / command), *map(str, arguments)],
            capture_output=True,
            text=True,
            check=check,
            timeout=30,
        )

    try:
        run(
            "initdb",
            "-D",
            data,
            "-A",
            "trust",
            "-U",
            "audit_fixture_owner",
            "--no-locale",
            "--encoding=UTF8",
        )
        run(
            "pg_ctl",
            "-D",
            data,
            "-l",
            directory / "server.log",
            "-o",
            f"-k {directory} -h '' -p 16579",
            "-w",
            "-t",
            "20",
            "start",
        )
        started = True
        yield make_dsn(
            host=str(directory), port=16579, dbname="postgres", user="audit_fixture_owner"
        )
    finally:
        if started:
            run("pg_ctl", "-D", data, "-m", "immediate", "-w", "-t", "20", "stop")
            assert run("pg_ctl", "-D", data, "status", check=False).returncode == 3
        elif (data / "postmaster.pid").exists():
            # A timed-out startup may have created compute before acknowledging.
            run("pg_ctl", "-D", data, "-m", "immediate", "-w", "-t", "20", "stop")
        shutil.rmtree(directory)
        assert not directory.exists()


def test_real_pkm_aggregates_find_synthetic_defects_and_refuse_rls_filtering(isolated_postgres):
    connection = psycopg2.connect(isolated_postgres)
    try:
        with connection.cursor() as cursor:
            for table, columns in audit.PKM_PROBE_COLUMNS.items():
                cursor.execute(
                    sql.SQL("CREATE TABLE public.{} ({})").format(
                        sql.Identifier(table),
                        sql.SQL(", ").join(
                            sql.SQL("{} {}").format(sql.Identifier(column), sql.SQL(kind))
                            for column, kind in columns.items()
                        ),
                    )
                )
            cursor.execute("""
INSERT INTO public.pkm_blobs VALUES
 ('owner-a', 'travel', 'sealed', 'iv', 'tag', 1, 1),
 ('owner-a', '', 'sealed', 'iv', ' ', -1, 1);
INSERT INTO public.pkm_manifests VALUES ('owner-b', 'travel'), (' ', 'travel');
INSERT INTO public.pkm_domain_revisions VALUES
 ('00000000-0000-0000-0000-000000000001', 'owner-a', 'travel'),
 ('00000000-0000-0000-0000-000000000002', 'owner-b', 'travel'),
 ('00000000-0000-0000-0000-000000000003', 'owner-a', 'work');
INSERT INTO public.pkm_domain_revision_segments VALUES
 ('00000000-0000-0000-0000-000000000001', 'sealed', ' ', 'tag'),
 ('00000000-0000-0000-0000-000000000099', 'sealed', 'iv', 'tag');
INSERT INTO public.pkm_domain_commits VALUES
 ('owner-a', 'travel', '00000000-0000-0000-0000-000000000001'),
 ('owner-a', 'travel', NULL),
 ('owner-a', 'travel', '00000000-0000-0000-0000-000000000099'),
 ('owner-a', 'travel', '00000000-0000-0000-0000-000000000002'),
 ('owner-a', 'travel', '00000000-0000-0000-0000-000000000003');
""")
        connection.commit()
        observation = audit._live_stats(isolated_postgres, pkm_aggregates=True)
        assert observation["status"] == "verified"
        counts = {
            check["check"]: check["counts"] for check in observation["pkm_structure"]["checks"]
        }
        assert counts == {
            "current_envelopes": {"total": 2, "incomplete_envelopes": 1, "negative_revisions": 1},
            "scope_keys": {"total": 12, "incomplete_scope_keys": 2},
            "blob_manifests": {"total": 2, "missing_manifest": 2},
            "archived_segments": {"total": 2, "missing_parent": 1, "incomplete_envelopes": 1},
            "commit_references": {"total": 5, "missing_parent": 1, "cross_scope_reference": 2},
        }
        assert "owner-a" not in str(observation)
        # Deliberately unconstrained fixture tables characterize corruption that
        # a healthy FK would prevent. Never disable a live database constraint.
        with connection.cursor() as cursor:
            cursor.execute("""
CREATE ROLE audit_fixture_reader LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO audit_fixture_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO audit_fixture_reader;
ALTER TABLE public.pkm_blobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY partial_fixture ON public.pkm_blobs USING (user_id = 'owner-b');
""")
        connection.commit()
        filtered_dsn = make_dsn(isolated_postgres, user="audit_fixture_reader")
        filtered = audit._live_stats(filtered_dsn, pkm_aggregates=True)
        assert filtered["status"] == "unavailable"
        assert filtered["reason"] == "pkm_query_unavailable"
        assert filtered["rows"] == []
        assert filtered["pkm_structure"] == {"status": "unavailable"}
        assert "owner" not in str(filtered)
    finally:
        connection.close()
