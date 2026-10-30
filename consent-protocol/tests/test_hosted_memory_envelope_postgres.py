"""Disposable PostgreSQL proof for scoped ciphertext, CAS and erasure."""

# ruff: noqa: F811 -- imported fixture is also the test argument

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError

from hushh_mcp.services.hosted_memory_envelope_contract import (
    aad_sha256_hex,
    owner_source_aad,
)
from hushh_mcp.services.hosted_memory_envelope_service import (
    HostedMemoryEnvelopeConflict,
    HostedMemoryEnvelopeService,
)
from hushh_mcp.services.hosted_memory_pilot_service import HostedMemoryPilotService
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url,  # noqa: F401 -- disposable Postgres fixture
)

MIGRATIONS = [
    Path(__file__).resolve().parents[1] / "db/migrations/343_hosted_memory_pilot_review.sql",
    Path(__file__).resolve().parents[1]
    / "db/migrations/344_hosted_memory_scoped_source_envelope.sql",
]


def test_scoped_envelope_cas_and_revocation(connector_postgres_url):
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
                            '{"chat":"reviewed"}'::jsonb, TRUE),
                           ('notion', NULL, 'oauth', 'mcp',
                            '{"chat":"reviewed"}'::jsonb, TRUE)""")
        )
    for migration in MIGRATIONS:
        with engine.begin() as connection:
            connection.exec_driver_sql(
                migration.read_text(), execution_options={"no_parameters": True}
            )
    pilot = HostedMemoryPilotService(SimpleNamespace(engine=engine))
    store = HostedMemoryEnvelopeService(SimpleNamespace(engine=engine))

    def call(service, method: str, owner: str, **kwargs):
        return asyncio.run(getattr(service, method)(user_id=owner, **kwargs))

    grant = call(pilot, "request_pending", "owner-a", expected_generation=0, source_id="hubspot")
    assert call(store, "owner_readback", "owner-b") is None
    key = AESGCM.generate_key(bit_length=256)
    key_id = str(uuid4())

    def sealed(*, source_id: str, revision: int, nonce: bytes):
        aad = owner_source_aad(
            user_id="owner-a",
            grant_id=grant["grantId"],
            generation=int(grant["generation"]),
            source_id=source_id,
            revision=revision,
        )
        return AESGCM(key).encrypt(nonce, b'{"status":"connected"}', aad), aad_sha256_hex(aad)

    nonce1 = os.urandom(12)
    ciphertext1, aad1 = sealed(source_id="hubspot", revision=1, nonce=nonce1)
    staged = call(
        store,
        "stage_owner_envelope",
        "owner-a",
        grant_id=grant["grantId"],
        generation=1,
        source_id="hubspot",
        expected_revision=0,
        key_id=key_id,
        nonce=nonce1,
        ciphertext=ciphertext1,
        aad_sha256=aad1,
    )
    assert staged["revision"] == "1"
    assert staged["captureEnabled"] is False
    assert staged["workerPaired"] is False
    assert call(store, "owner_readback", "owner-a") == staged
    assert call(store, "owner_readback", "owner-b") is None
    with pytest.raises(HostedMemoryEnvelopeConflict):
        call(
            store,
            "stage_owner_envelope",
            "owner-b",
            grant_id=grant["grantId"],
            generation=1,
            source_id="hubspot",
            expected_revision=0,
            key_id=str(uuid4()),
            nonce=nonce1,
            ciphertext=ciphertext1,
            aad_sha256=aad_sha256_hex(
                owner_source_aad(
                    user_id="owner-b",
                    grant_id=grant["grantId"],
                    generation=1,
                    source_id="hubspot",
                    revision=1,
                )
            ),
        )
    with pytest.raises(HostedMemoryEnvelopeConflict):
        call(
            store,
            "stage_owner_envelope",
            "owner-a",
            grant_id=grant["grantId"],
            generation=1,
            source_id="notion",
            expected_revision=0,
            key_id=key_id,
            nonce=nonce1,
            ciphertext=ciphertext1,
            aad_sha256=aad_sha256_hex(
                owner_source_aad(
                    user_id="owner-a",
                    grant_id=grant["grantId"],
                    generation=1,
                    source_id="notion",
                    revision=1,
                )
            ),
        )
    with pytest.raises(ValueError, match="key and nonce pair"):
        call(
            store,
            "stage_owner_envelope",
            "owner-a",
            grant_id=grant["grantId"],
            generation=1,
            source_id="hubspot",
            expected_revision=1,
            key_id=key_id,
            nonce=nonce1,
            ciphertext=ciphertext1,
            aad_sha256=aad_sha256_hex(
                owner_source_aad(
                    user_id="owner-a",
                    grant_id=grant["grantId"],
                    generation=1,
                    source_id="hubspot",
                    revision=2,
                )
            ),
        )
    nonce2 = os.urandom(12)
    ciphertext2, aad2 = sealed(source_id="hubspot", revision=2, nonce=nonce2)
    staged2 = call(
        store,
        "stage_owner_envelope",
        "owner-a",
        grant_id=grant["grantId"],
        generation=1,
        source_id="hubspot",
        expected_revision=1,
        key_id=key_id,
        nonce=nonce2,
        ciphertext=ciphertext2,
        aad_sha256=aad2,
    )
    assert staged2["revision"] == "2"
    with pytest.raises(HostedMemoryEnvelopeConflict):
        call(
            store,
            "stage_owner_envelope",
            "owner-a",
            grant_id=grant["grantId"],
            generation=1,
            source_id="hubspot",
            expected_revision=1,
            key_id=str(uuid4()),
            nonce=os.urandom(12),
            ciphertext=ciphertext2,
            aad_sha256=aad2,
        )

    switched = call(pilot, "request_pending", "owner-a", expected_generation=1, source_id="notion")
    assert switched["generation"] == "2"
    assert switched["grantId"] != grant["grantId"]
    assert call(store, "owner_readback", "owner-a") is None
    switched_aad = owner_source_aad(
        user_id="owner-a",
        grant_id=switched["grantId"],
        generation=2,
        source_id="notion",
        revision=1,
    )
    switched_nonce = os.urandom(12)
    switched_envelope = call(
        store,
        "stage_owner_envelope",
        "owner-a",
        grant_id=switched["grantId"],
        generation=2,
        source_id="notion",
        expected_revision=0,
        key_id=str(uuid4()),
        nonce=switched_nonce,
        ciphertext=AESGCM(key).encrypt(switched_nonce, b'{"status":"needs_reauth"}', switched_aad),
        aad_sha256=aad_sha256_hex(switched_aad),
    )
    assert switched_envelope["sourceId"] == "notion"
    assert call(pilot, "revoke", "owner-a")["status"] == "revoked"
    assert call(store, "owner_readback", "owner-a") is None
    with engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM live_memory_hosted_source_envelopes")
            ).scalar_one()
            == 0
        )
    renewed = call(pilot, "request_pending", "owner-a", expected_generation=3, source_id="notion")
    renewed_aad = owner_source_aad(
        user_id="owner-a",
        grant_id=renewed["grantId"],
        generation=4,
        source_id="notion",
        revision=1,
    )
    renewed_nonce = os.urandom(12)
    call(
        store,
        "stage_owner_envelope",
        "owner-a",
        grant_id=renewed["grantId"],
        generation=4,
        source_id="notion",
        expected_revision=0,
        key_id=str(uuid4()),
        nonce=renewed_nonce,
        ciphertext=AESGCM(key).encrypt(renewed_nonce, b'{"status":"not_connected"}', renewed_aad),
        aad_sha256=aad_sha256_hex(renewed_aad),
    )
    with engine.begin() as connection:
        connection.execute(text("DELETE FROM vault_keys WHERE user_id='owner-a'"))
        assert (
            connection.execute(
                text("SELECT count(*) FROM live_memory_hosted_source_envelopes")
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                text("SELECT count(*) FROM live_memory_hosted_pilot_grants WHERE user_id='owner-a'")
            ).scalar_one()
            == 0
        )
    other = call(pilot, "request_pending", "owner-b", expected_generation=0, source_id="hubspot")
    other_aad = owner_source_aad(
        user_id="owner-b",
        grant_id=other["grantId"],
        generation=1,
        source_id="hubspot",
        revision=1,
    )
    other_nonce = os.urandom(12)
    other_ciphertext = AESGCM(key).encrypt(other_nonce, b'{"status":"error"}', other_aad)
    call(
        store,
        "stage_owner_envelope",
        "owner-b",
        grant_id=other["grantId"],
        generation=1,
        source_id="hubspot",
        expected_revision=0,
        key_id=str(uuid4()),
        nonce=other_nonce,
        ciphertext=other_ciphertext,
        aad_sha256=aad_sha256_hex(other_aad),
    )
    with engine.begin() as connection:
        connection.execute(
            text("""UPDATE live_memory_hosted_pilot_grants
                    SET reviewed_at=clock_timestamp()-interval '20 minutes',
                        expires_at=clock_timestamp()-interval '5 minutes'
                    WHERE user_id='owner-b'""")
        )
    with pytest.raises(HostedMemoryEnvelopeConflict):
        call(
            store,
            "stage_owner_envelope",
            "owner-b",
            grant_id=other["grantId"],
            generation=1,
            source_id="hubspot",
            expected_revision=1,
            key_id=str(uuid4()),
            nonce=os.urandom(12),
            ciphertext=other_ciphertext,
            aad_sha256=aad_sha256_hex(
                owner_source_aad(
                    user_id="owner-b",
                    grant_id=other["grantId"],
                    generation=1,
                    source_id="hubspot",
                    revision=2,
                )
            ),
        )
    assert call(store, "owner_readback", "owner-b") is None
    with engine.begin() as connection:
        count = connection.execute(
            text("SELECT count(*) FROM live_memory_hosted_source_envelopes")
        ).scalar_one()
        assert count == 1  # Expiry hides but does not erase staged ciphertext.
    assert (
        call(pilot, "request_pending", "owner-b", expected_generation=1, source_id="hubspot")[
            "generation"
        ]
        == "2"
    )
    with engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM live_memory_hosted_source_envelopes")
            ).scalar_one()
            == 0
        )

    # An existing same-name trigger on the wrong UPDATE column must not make
    # a migration replay appear healthy: it would miss revocation erasure.
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "DROP TRIGGER erase_hosted_source_envelope_on_grant_change "
            "ON public.live_memory_hosted_pilot_grants"
        )
        connection.exec_driver_sql(
            """CREATE TRIGGER erase_hosted_source_envelope_on_grant_change
               AFTER UPDATE OF expires_at ON public.live_memory_hosted_pilot_grants
               FOR EACH ROW EXECUTE FUNCTION
                 public.erase_hosted_source_envelope_on_grant_change()"""
        )
    with pytest.raises(SQLAlchemyError):
        with engine.begin() as connection:
            connection.exec_driver_sql(
                MIGRATIONS[-1].read_text(), execution_options={"no_parameters": True}
            )
