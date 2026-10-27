# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Installed-schema qualification and bounded DDL for the recorded restoration.

No historical migration or application row is changed. The workflow owns the
SQL proxy and supplies its canonical production connection in process memory.
"""

from __future__ import annotations

import argparse
import json
import os
import runpy
from contextlib import closing, contextmanager
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
SOURCE = runpy.run_path(str(HERE / "compatibility_restoration.py"))
FENCE = runpy.run_path(str(HERE / "document_restoration_fence.py"))
require = SOURCE["require"]


def qualify(connection, *, sha: str, run_id: str, action: str) -> dict:
    record = SOURCE["qualify_source"](sha)
    connection.set_session(readonly=True, autocommit=True)
    schema = SOURCE["qualify_schema"](connection, record, require_empty_documents=True)
    barrier = None
    if action == "prepare":
        barrier = FENCE["install"](connection, source=sha, run_id=run_id)
        connection.set_session(readonly=True, autocommit=True)
    if action in {"prepare", "verify"}:
        FENCE["verify"](connection, source=sha, run_id=run_id)
        schema = SOURCE["qualify_schema"](
            connection, record, require_empty_documents=True
        )
    with connection.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM public.account_deletion_tombstones")
        count = cursor.fetchone()[0]
    return {
        "schemaVersion": 1,
        "status": "qualified",
        "mode": "restoration-no-migrations",
        "sourceSha": sha,
        "runId": run_id,
        "schema": schema,
        "migrationsExecuted": [],
        "documentFence": barrier
        or ("verified" if action == "verify" else "not-requested"),
        "tombstoneCount": count,
    }


def connect(values=None):
    import psycopg2

    values = os.environ if values is None else values
    require(
        values.get("PGHOST") == "127.0.0.1"
        and values.get("PGPORT") == "6544"
        and values.get("PGDATABASE") == "hushh_vault",
        "Canonical production proxy connection required",
    )
    return psycopg2.connect(
        host=values["PGHOST"],
        port=values["PGPORT"],
        dbname=values["PGDATABASE"],
        user=values["PGUSER"],
        password=values["PGPASSWORD"],
        connect_timeout=10,
    )


@contextmanager
def database_connection(owned_proxy: bool):
    if not owned_proxy:
        with closing(connect()) as connection:
            yield connection
        return
    activation = runpy.run_path(str(HERE / "activate_release.py"))
    target = SimpleNamespace(
        project="hushh-pda",
        db_name="hushh_vault",
        db_port=6544,
        cloudsql_instance="hushh-pda:us-central1:hushh-vault-db",
    )
    with activation["database"](target) as pg, closing(connect(pg)) as connection:
        yield connection


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("inspect", "prepare", "verify"))
    parser.add_argument("--sha", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--github-output", type=Path)
    parser.add_argument("--owned-proxy", action="store_true")
    args = parser.parse_args()
    try:
        with database_connection(args.owned_proxy) as connection:
            report = qualify(
                connection, sha=args.sha, run_id=args.run_id, action=args.action
            )
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        if args.github_output:
            require(
                args.action in {"prepare", "verify"},
                "A persistent writer barrier is required",
            )
            with args.github_output.open("a") as output:
                output.write("maintenance_required=false\n")
    except Exception:
        parser.exit(
            1, "Production restoration database compatibility could not be verified\n"
        )
    print("Production schema qualified without migration replay")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
