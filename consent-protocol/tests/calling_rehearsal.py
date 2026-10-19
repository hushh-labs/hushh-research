"""Disposable HTTP attach point for real browser media rehearsal.

Production routers, Firebase verification and device enrollment remain intact.
Only synthetic owners and the existing isolated PostgreSQL fixture are used.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from uuid import uuid4

import firebase_admin
import uvicorn
from firebase_admin import auth, credentials
from google.auth.credentials import AnonymousCredentials
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from test_direct_calls_postgres import prepare_call_schema


class EmulatorCredential(credentials.Base):
    def get_credential(self):
        return AnonymousCredentials()


def isolated_engine():
    url = make_url(os.environ["ONE_COMMAND_TEST_DATABASE_URL"])
    if (
        url.host not in {"127.0.0.1", "localhost"}
        or url.database != "command_test"
        or url.username != "command_test"
        or url.query
        or url.drivername != "postgresql+psycopg2"
    ):
        raise ValueError("Requires the canonical loopback command_test database")
    name = os.environ.get("CALLING_REHEARSAL_DATABASE") or "calling_rehearsal_" + uuid4().hex
    if not re.fullmatch(r"calling_rehearsal_[a-f0-9]{32}", name):
        raise ValueError("Invalid disposable database name")
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql(f'CREATE DATABASE "{name}"')
    engine = create_engine(url.set(database=name), pool_size=5, max_overflow=0)
    return admin, engine, name, url


def prepare_enrollment(engine):
    prepare_call_schema(engine)
    with engine.begin() as conn:
        conn.exec_driver_sql("""
          ALTER TABLE trusted_devices ADD COLUMN device_name TEXT;
          ALTER TABLE trusted_devices ADD COLUMN created_at BIGINT;
          ALTER TABLE trusted_devices ADD COLUMN last_used_at BIGINT;
          ALTER TABLE trusted_devices ADD COLUMN revoked_at BIGINT;
          CREATE TABLE trusted_device_audit_events(
            user_id TEXT,device_id TEXT,event_type TEXT,created_at BIGINT,metadata JSONB);
          CREATE TABLE account_deletion_tombstones(user_id_hash TEXT PRIMARY KEY);
        """)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int)
    parser.add_argument("--run-marker")
    parser.add_argument("--cleanup", action="store_true")
    parser.add_argument("--inspect", action="store_true")
    args = parser.parse_args()
    if args.cleanup or args.inspect:
        maintenance(inspect=args.inspect)
        return
    if not args.port:
        raise ValueError("A loopback backend port is required")
    emulator = os.environ.get("FIREBASE_AUTH_EMULATOR_HOST", "")
    if not emulator.startswith("127.0.0.1:"):
        raise ValueError("Requires an isolated loopback Firebase Auth emulator")
    if os.environ.get("GCLOUD_PROJECT") != "demo-hushh-calling":
        raise ValueError("Requires the synthetic demo project")
    admin, engine, name, url = isolated_engine()
    try:
        prepare_enrollment(engine)
        # The production DB client resolves these process-local settings.
        os.environ.update(
            DB_HOST=url.host,
            DB_PORT=str(url.port or 5432),
            DB_NAME=name,
            DB_USER=url.username or "",
            DB_PASSWORD=url.password or "rehearsal",
            DB_UNIX_SOCKET="",
        )
        from db.db_client import get_db_engine

        runtime = get_db_engine()
        if runtime.url != url.set(database=name, password=url.password or "rehearsal"):
            raise ValueError("Runtime database escaped the disposable fixture")
        with runtime.connect() as conn:
            if conn.execute(text("SELECT current_database(), current_user")).one() != (
                name,
                "command_test",
            ):
                raise ValueError("Runtime database identity mismatch")
        application = authenticated_app()
        print(json.dumps({"backendReady": True}), flush=True)
        uvicorn.run(
            application, host="127.0.0.1", port=args.port, access_log=False, log_level="warning"
        )
    finally:
        from db.db_client import close_db_engine

        close_db_engine()
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(
                text("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=:name"),
                {"name": name},
            )
            conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{name}"')
        admin.dispose()


def authenticated_app():
    app = firebase_admin.initialize_app(
        EmulatorCredential(), options={"projectId": "demo-hushh-calling"}
    )
    for owner in ("alice", "bob"):
        auth.create_user(
            uid=owner,
            email=f"{owner}@calling.invalid",
            email_verified=True,
            password=os.environ["CALLING_REHEARSAL_PASSWORD"],
            app=app,
        )
    from fastapi import FastAPI
    from slowapi import _rate_limit_exceeded_handler
    from slowapi.errors import RateLimitExceeded

    from api.middlewares.rate_limit import limiter
    from api.routes.account import router as account_router
    from api.routes.one.calls import router as calling_router

    application = FastAPI()
    application.state.limiter = limiter
    application.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    application.include_router(account_router)
    application.include_router(calling_router)

    @application.get("/rehearsal-health")
    def health():
        return {"ready": True, "scope": "disposable-calling-rehearsal"}

    return application


def maintenance(*, inspect: bool):
    url = make_url(os.environ["ONE_COMMAND_TEST_DATABASE_URL"])
    name = os.environ["CALLING_REHEARSAL_DATABASE"]
    if (
        url.host not in {"localhost", "127.0.0.1"}
        or url.database != "command_test"
        or url.username != "command_test"
        or url.query
        or url.drivername != "postgresql+psycopg2"
    ):
        raise ValueError("Requires the canonical disposable database")
    if not re.fullmatch(r"calling_rehearsal_[a-f0-9]{32}", name):
        raise ValueError("Invalid disposable database name")
    engine = create_engine(url.set(database=name) if inspect else url, isolation_level="AUTOCOMMIT")
    try:
        with engine.connect() as conn:
            if inspect:
                counts = (
                    conn.execute(
                        text("""SELECT
                  (SELECT count(*) FROM direct_calls) AS calls,
                  (SELECT count(*) FROM direct_call_slots) AS slots,
                  (SELECT count(*) FROM direct_call_signals) AS signals,
                  (SELECT count(*) FROM direct_calls WHERE state IN ('preparing','ringing','connecting','active')) AS live,
                  (SELECT count(*) FROM direct_calls WHERE offers <> '[]'::jsonb) AS retained_offers""")
                    )
                    .mappings()
                    .one()
                )
                if not counts["calls"] or any(
                    counts[key] for key in ("slots", "signals", "live", "retained_offers")
                ):
                    raise ValueError("Call cleanup verification failed")
                print(json.dumps(dict(counts)), flush=True)
            else:
                conn.execute(
                    text(
                        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=:name"
                    ),
                    {"name": name},
                )
                conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{name}"')
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
