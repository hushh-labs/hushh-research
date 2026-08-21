"""Server-derived identity proof for destructive Hushh Tech UAT operations."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

UAT_INSTANCE = "hushh-pda-uat:us-central1:hushh-uat-pg"
UAT_DATABASE_NAME = "postgres"
UAT_DATABASE_ROLE = "hushh_uat_app"
# Captured read-only from the canonical UAT PostgreSQL cluster. A deliberate
# rebuild or disaster-recovery cutover changes it and requires code review.
UAT_POSTGRES_SYSTEM_IDENTIFIER = "7612942862467162128"
UAT_POSTGRES_MAJOR_VERSION = 15

UAT_DATABASE_ATTESTATION_SQL = """
SELECT current_database() AS database_name,
       current_user AS database_role,
       current_setting('server_version_num')::BIGINT AS server_version_num,
       system_identifier::TEXT AS system_identifier
FROM pg_control_system()
"""


@dataclass(frozen=True)
class ConnectedDatabaseIdentity:
    database_name: str
    database_role: str
    server_major: int
    system_identifier: str


def parse_connected_database_identity(row: Mapping[str, Any]) -> ConnectedDatabaseIdentity:
    try:
        return ConnectedDatabaseIdentity(
            database_name=str(row["database_name"]),
            database_role=str(row["database_role"]),
            server_major=int(row["server_version_num"]) // 10_000,
            system_identifier=str(row["system_identifier"]),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("connected database identity is malformed") from exc


def is_attested_hushh_tech_uat_database(identity: ConnectedDatabaseIdentity) -> bool:
    return (
        identity.database_name == UAT_DATABASE_NAME
        and identity.database_role == UAT_DATABASE_ROLE
        and identity.server_major == UAT_POSTGRES_MAJOR_VERSION
        and identity.system_identifier == UAT_POSTGRES_SYSTEM_IDENTIFIER
    )
