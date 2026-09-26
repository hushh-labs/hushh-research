#!/usr/bin/env python3
"""Create only dedicated local fixture databases. Never reads cloud env profiles."""

import getpass
import pathlib
import os
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
ONE = ROOT.parent / "HusshOne"


def sql(database, value):
    subprocess.run(
        [
            "psql",
            "-X",
            "-h",
            "127.0.0.1",
            "-d",
            database,
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            value,
        ],
        check=True,
        stdout=subprocess.DEVNULL,
    )


APP_DATABASE = os.getenv("PROFILE_FIXTURE_DB_NAME", "hushh_profile_fixture_app")
if (
    not APP_DATABASE.startswith("hushh_profile_fixture_")
    or not APP_DATABASE.replace("_", "").isalnum()
):
    raise SystemExit("Refusing a non-fixture database")
for database in (
    "hushh_profile_fixture_one",
    "hushh_profile_fixture_root",
    APP_DATABASE,
):
    present = subprocess.check_output(
        [
            "psql",
            "-X",
            "-h",
            "127.0.0.1",
            "-d",
            "postgres",
            "-Atc",
            f"SELECT 1 FROM pg_database WHERE datname='{database}'",
        ],
        text=True,
    ).strip()
    if not present:
        subprocess.run(["createdb", "-h", "127.0.0.1", database], check=True)

# This is the narrow bridge integration schema. Full application/browser rehearsal
# also needs the normal governed root schema, identity, Feed and PKM foundations.
# Do not describe these tables as a complete application bootstrap.
sql(
    "hushh_profile_fixture_root",
    "CREATE TABLE IF NOT EXISTS feed_events(event_id UUID PRIMARY KEY, source_domain TEXT);",
)
for database, path in (
    (
        "hushh_profile_fixture_one",
        ONE / "prisma/migrations/20260924090000_public_profile_tasks/migration.sql",
    ),
    (
        "hushh_profile_fixture_root",
        ROOT / "consent-protocol/db/migrations/240_public_profile_discovery.sql",
    ),
):
    sentinel = (
        "public_profile_tasks"
        if database.endswith("one")
        else "one_profile_discovery_jobs"
    )
    present = subprocess.check_output(
        [
            "psql",
            "-X",
            "-h",
            "127.0.0.1",
            "-d",
            database,
            "-Atc",
            f"SELECT to_regclass('public.{sentinel}') IS NOT NULL",
        ],
        text=True,
    ).strip()
    if present != "t":
        subprocess.run(
            [
                "psql",
                "-X",
                "-h",
                "127.0.0.1",
                "-d",
                database,
                "-v",
                "ON_ERROR_STOP=1",
                "-f",
                str(path),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
        )
# The legacy base supplies Gmail foundations required by the ordered migrations.
# It is applied only to a new empty fixture database, never over an existing app.
present = subprocess.check_output(
    [
        "psql",
        "-X",
        "-h",
        "127.0.0.1",
        "-d",
        APP_DATABASE,
        "-Atc",
        "SELECT count(*) FROM pg_tables WHERE schemaname='public'",
    ],
    text=True,
).strip()
if present == "0":
    subprocess.run(
        [
            "psql",
            "-X",
            "-h",
            "127.0.0.1",
            "-d",
            APP_DATABASE,
            "-v",
            "ON_ERROR_STOP=1",
            "-f",
            str(ROOT / "consent-protocol/db/legacy/init_legacy_schema.sql"),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
    )
fixture_env = {
    **os.environ,
    "ENVIRONMENT": "development",
    "DB_HOST": "127.0.0.1",
    "DB_PORT": "5432",
    "DB_NAME": APP_DATABASE,
    "DB_USER": getpass.getuser(),
    "DB_PASSWORD": "local-fixture-unused",
    "DB_UNIX_SOCKET": "",
    "CLOUDSQL_INSTANCE_CONNECTION_NAME": "",
}
subprocess.run(
    [str(ROOT / "consent-protocol/.venv/bin/python"), "db/migrate.py", "--init"],
    cwd=ROOT / "consent-protocol",
    env=fixture_env,
    check=True,
)
print("Isolated fixture databases and full application schema are ready.")
print(f"Local database user: {getpass.getuser()}")
