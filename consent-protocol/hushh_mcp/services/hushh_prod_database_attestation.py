"""Server-derived identity proof for production Drive registry operations."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

PROD_INSTANCE = "hushh-pda:us-central1:hushh-vault-db"
PROD_DATABASE_NAME = "hushh_vault"
PROD_DATABASE_ROLE = "hushh_app"
# Captured read-only from the production PostgreSQL cluster. A restore or
# cutover must receive a reviewed attestation update before registry writes.
PROD_POSTGRES_SYSTEM_IDENTIFIER = "7583196663345094671"
PROD_POSTGRES_MAJOR_VERSION = 15

PROD_DATABASE_ATTESTATION_SQL = """
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


def is_attested_hushh_prod_database(identity: ConnectedDatabaseIdentity) -> bool:
    return (
        identity.database_name == PROD_DATABASE_NAME
        and identity.database_role == PROD_DATABASE_ROLE
        and identity.server_major == PROD_POSTGRES_MAJOR_VERSION
        and identity.system_identifier == PROD_POSTGRES_SYSTEM_IDENTIFIER
    )


__all__ = [
    "PROD_INSTANCE",
    "PROD_DATABASE_ATTESTATION_SQL",
    "is_attested_hushh_prod_database",
    "parse_connected_database_identity",
]
