"""Admission for the explicitly disposable PostgreSQL CI test service."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from contextlib import closing
from pathlib import Path

import asyncpg
import psycopg2
from sqlalchemy.engine import URL, make_url

_PG_TARGET_ENV = (
    "PGHOST",
    "PGHOSTADDR",
    "PGPORT",
    "PGSERVICE",
    "PGSERVICEFILE",
    "PGOPTIONS",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
)
_OTHER_TEST_DATABASES = (
    "ACCOUNT_DELETION_POSTGRES_URL",
    "AUDIT_TEST_DSN",
    "CHAT_CUTOVER_TEST_DATABASE_URL",
    "CONTACT_SYNC_POSTGRES_TEST_URL",
    "EMAIL_AUTH_POLICY_DATABASE_URL",
    "FEED_IDENTITY_POSTGRES_TEST_URL",
    "GOOGLE_OAUTH_TEST_DATABASE_URL",
    "PROFILE_BRIDGE_TEST_DSN",
    "PROFILE_PROJECTION_TEST_DSN",
    "REFERRAL_TEST_DATABASE_URL",
    "SCOPE_COMMERCE_TEST_DSN",
)
_SERVER_IDENTITY = (
    "SELECT current_setting('data_directory'), current_setting('port')::int, "
    "(SELECT system_identifier::text FROM pg_catalog.pg_control_system()), current_user"
)


def _owned_cluster_matches(url: URL) -> bool:
    """Attest a nonstandard local test port against its private server socket.

    This prevents an accidental connection to another local listener. It does
    not defend against a malicious process running as the same operating-system
    user, who can already modify the test checkout and its temporary files.
    """
    manifest_name = os.getenv("ONE_COMMAND_TEST_PG_MANIFEST", "")
    if (
        not manifest_name
        or url.host != "127.0.0.1"
        or not url.port
        or any(os.getenv(name) for name in _PG_TARGET_ENV)
    ):
        return False
    try:
        manifest = Path(manifest_name)
        root = manifest.parent.resolve(strict=True)
        if (
            manifest.is_symlink()
            or manifest.name != "identity.json"
            or not root.name.startswith("hussh-ci-test-pg.")
            or root.parent != Path("/tmp").resolve()  # noqa: S108 -- validate an owned directory; no file is created here.
            or root.stat().st_uid != os.getuid()
            or root.stat().st_mode & 0o077
            or manifest.stat().st_uid != os.getuid()
            or manifest.stat().st_mode & 0o077
            or manifest.stat().st_size > 4096
        ):
            return False
        identity = json.loads(manifest.read_text(encoding="utf-8"))
        data_path, socket_path = root / "data", root / "socket"
        if data_path.is_symlink() or socket_path.is_symlink():
            return False
        data = data_path.resolve(strict=True)
        socket = socket_path.resolve(strict=True)
        pid_lines = (data / "postmaster.pid").read_text(encoding="utf-8").splitlines()
        pid = int(pid_lines[0])
        if (
            identity.get("data_directory") != str(data)
            or identity.get("socket_directory") != str(socket)
            or identity.get("port") != url.port
            or identity.get("pid") != pid
            or pid_lines[1] != str(data)
            or int(pid_lines[3]) != url.port
            or pid_lines[4] != str(socket)
        ):
            return False
        os.kill(pid, 0)
        kwargs = {
            "dbname": "command_test",
            "user": "command_test",
            "password": url.password,
            "port": url.port,
            "connect_timeout": 3,
        }
        observed = []
        for host in (str(socket), "127.0.0.1"):
            with closing(psycopg2.connect(host=host, **kwargs)) as connection:
                with connection.cursor() as cursor:
                    cursor.execute(_SERVER_IDENTITY)
                    observed.append(cursor.fetchone())
        return (
            observed
            == [(str(data), url.port, identity.get("system_identifier"), "command_test")] * 2
        )
    except (OSError, ValueError, KeyError, TypeError, IndexError, psycopg2.Error):
        return False


def is_isolated_command_url(url: URL) -> bool:
    """Accept the standard CI service or an independently attested local test server."""
    if (
        url.drivername not in {"postgresql", "postgresql+psycopg2"}
        or url.host not in {"localhost", "127.0.0.1"}
        or url.database != "command_test"
        or url.username != "command_test"
        or url.query
        or any(os.getenv(name) for name in _PG_TARGET_ENV)
    ):
        return False
    if (
        os.getenv("GITHUB_ACTIONS") == "true"
        and os.getenv("CI") == "true"
        and not os.getenv("ONE_COMMAND_TEST_PG_MANIFEST")
        and url.host == "127.0.0.1"
        and url.port == 5432
    ):
        # GitHub provides a separate test-only database service for this job.
        return True
    return _owned_cluster_matches(url)


async def _async_server_identity(url: URL) -> tuple:
    connection = await asyncpg.connect(
        url.set(drivername="postgresql").render_as_string(hide_password=False), timeout=3
    )
    try:
        return tuple(await connection.fetchrow(_SERVER_IDENTITY))
    finally:
        await connection.close()


def preflight() -> None:
    """Refuse before pytest if drivers select different PostgreSQL servers."""
    if os.getenv("ONE_COMMAND_TEST_PG_MANIFEST") and any(
        os.getenv(name) for name in _OTHER_TEST_DATABASES
    ):
        raise ValueError("Separate database overrides are not admitted in the local core mirror")
    url = make_url(os.environ["ONE_COMMAND_TEST_DATABASE_URL"])
    if not is_isolated_command_url(url):
        raise ValueError("PostgreSQL test target is not an admitted disposable service")
    with closing(
        psycopg2.connect(
            host=url.host,
            port=url.port,
            dbname=url.database,
            user=url.username,
            password=url.password,
            connect_timeout=3,
        )
    ) as connection:
        with connection.cursor() as cursor:
            cursor.execute(_SERVER_IDENTITY)
            sync_identity = cursor.fetchone()
    if sync_identity != asyncio.run(_async_server_identity(url)):
        raise ValueError("PostgreSQL drivers selected different test servers")


if __name__ == "__main__":
    try:
        preflight()
        print("PostgreSQL test service and driver identity verified.")
    except Exception:  # noqa: BLE001 -- do not leak a malformed URL or credentials on refusal.
        print("PostgreSQL test service preflight refused the configured target.", file=sys.stderr)
        sys.exit(1)
