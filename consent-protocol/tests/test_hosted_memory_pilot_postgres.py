"""Real Postgres proof of owner isolation, revoke fencing and full erasure."""

# ruff: noqa: F811 -- imported pytest fixture has the test argument's name

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, text

from hushh_mcp.services.hosted_memory_pilot_service import (
    HostedMemoryPilotConflict,
    HostedMemoryPilotService,
)
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url,  # noqa: F401 -- shared disposable Postgres fixture
)

MIGRATIONS = [
    Path(__file__).resolve().parents[1] / "db/migrations/343_hosted_memory_pilot_review.sql",
    Path(__file__).resolve().parents[1]
    / "db/migrations/344_hosted_memory_scoped_source_envelope.sql",
]


def test_pending_review_cannot_capture_and_revocation_fences_reenrollment(connector_postgres_url):
    engine = create_engine(connector_postgres_url)
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE vault_keys (user_id TEXT PRIMARY KEY)")
        connection.exec_driver_sql(
            """CREATE TABLE external_mcp_connectors (
                connector_id TEXT PRIMARY KEY, user_id TEXT, auth_style TEXT,
                transport_kind TEXT, capability_policy JSONB, is_active BOOLEAN)"""
        )
        connection.execute(text("INSERT INTO vault_keys (user_id) VALUES ('owner-a'), ('owner-b')"))
        connection.execute(
            text("""INSERT INTO external_mcp_connectors
                    (connector_id, user_id, auth_style, transport_kind,
                     capability_policy, is_active)
                    VALUES ('hubspot', NULL, 'oauth', 'mcp',
                            '{"chat":"reviewed"}'::jsonb, TRUE)""")
        )
    for _ in range(2):  # Migration replay must be safe.
        for migration in MIGRATIONS:
            with engine.begin() as connection:
                connection.exec_driver_sql(
                    migration.read_text(), execution_options={"no_parameters": True}
                )
    service = HostedMemoryPilotService(SimpleNamespace(engine=engine))

    def call(method: str, owner: str, **kwargs) -> dict:
        return asyncio.run(getattr(service, method)(user_id=owner, **kwargs))

    assert call("current", "owner-a")["status"] == "off"
    first = call("request_pending", "owner-a", expected_generation=0, source_id="hubspot")
    assert first["status"] == "pending"
    assert first["generation"] == "1"
    assert first["captureEnabled"] is False
    assert first["workerPaired"] is False
    assert (
        call("request_pending", "owner-a", expected_generation=0, source_id="hubspot")["grantId"]
        == first["grantId"]
    )
    assert call("current", "owner-b")["status"] == "off"
    pre_review_revoke = call("revoke", "owner-b")
    assert pre_review_revoke["status"] == "revoked"
    assert pre_review_revoke["generation"] == "1"
    with pytest.raises(HostedMemoryPilotConflict):
        call("request_pending", "owner-b", expected_generation=0, source_id="hubspot")
    assert (
        call("request_pending", "owner-b", expected_generation=1, source_id="hubspot")["generation"]
        == "2"
    )

    revoked = call("revoke", "owner-a")
    assert revoked["status"] == "revoked"
    assert revoked["generation"] == "2"
    assert call("revoke", "owner-a")["generation"] == "2"
    with pytest.raises(HostedMemoryPilotConflict):
        call("request_pending", "owner-a", expected_generation=1, source_id="hubspot")
    renewed = call("request_pending", "owner-a", expected_generation=2, source_id="hubspot")
    assert renewed["status"] == "pending"
    assert renewed["generation"] == "3"
    assert renewed["grantId"] != first["grantId"]

    with engine.begin() as connection:
        columns = {
            row[0]
            for row in connection.execute(
                text("""SELECT column_name FROM information_schema.columns
                        WHERE table_schema='public'
                          AND table_name='live_memory_hosted_pilot_grants'""")
            )
        }
        assert not columns.intersection(
            {"vault_key", "owner_token", "wrapped_key", "source_value", "attestation"}
        )
        assert (
            connection.execute(
                text("""SELECT relrowsecurity FROM pg_class
                    WHERE oid='public.live_memory_hosted_pilot_grants'::regclass""")
            ).scalar_one()
            is True
        )
        connection.execute(text("DELETE FROM vault_keys WHERE user_id IN ('owner-a', 'owner-b')"))
    assert call("current", "owner-a")["status"] == "off"
    assert call("current", "owner-b")["status"] == "off"
