#!/usr/bin/env python3
"""Verify, activate, or deactivate the fixed Instagram Login registry row.

Run after migrations 283 through 285. The default is read-only verification. ``--activate``
requires the deployed Instagram app credentials and an exact Meta-registered
web callback; it never prints or persists credential values. The command only
accepts the reviewed UAT and production origins and attests the connected DB.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import text

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from db.db_client import get_db  # noqa: E402
from hushh_mcp.services.external_connector_instagram_oauth import (  # noqa: E402
    AUTHORIZE_URL,
    CONNECTOR_ID,
    GRAPH_BASE,
    POLICY,
    RETURN_PATH,
    SCOPES,
    TOKEN_URL,
)
from hushh_mcp.services.hushh_prod_database_attestation import (  # noqa: E402
    PROD_DATABASE_ATTESTATION_SQL,
    PROD_INSTANCE,
    is_attested_hushh_prod_database,
)
from hushh_mcp.services.hushh_prod_database_attestation import (  # noqa: E402
    parse_connected_database_identity as parse_prod_identity,
)
from hushh_mcp.services.hushh_tech_uat_database_attestation import (  # noqa: E402
    UAT_DATABASE_ATTESTATION_SQL,
    UAT_INSTANCE,
    is_attested_hushh_tech_uat_database,
)
from hushh_mcp.services.hushh_tech_uat_database_attestation import (  # noqa: E402
    parse_connected_database_identity as parse_uat_identity,
)

TARGETS = {
    "uat": ("hushh-pda-uat", UAT_INSTANCE, "https://uat.one.hushh.ai"),
    "production": ("hushh-pda", PROD_INSTANCE, "https://one.hushh.ai"),
}
PROVISIONED_BY = "ops_instagram_registry"
FIELDS = (
    "connector_id",
    "display_name",
    "description",
    "mcp_endpoint",
    "auth_style",
    "oauth_authorize_url",
    "oauth_token_url",
    "oauth_scopes",
    "oauth_client_id_env",
    "oauth_client_secret_env",
    "api_key_header_name",
    "transport_kind",
    "created_by",
)


class InstagramRegistryError(ValueError):
    """Safe provisioning failure; never contains DB details or credentials."""


def _target(environment: str) -> dict[str, Any]:
    project, instance, origin = TARGETS[environment]
    for key, expected in (
        ("ENVIRONMENT", environment),
        ("HUSSH_RELEASE_ENVIRONMENT", environment),
        ("GCP_PROJECT_ID", project),
        ("GOOGLE_CLOUD_PROJECT", project),
        ("CLOUDSQL_INSTANCE_CONNECTION_NAME", instance),
        ("APP_FRONTEND_ORIGIN", origin),
    ):
        actual = os.getenv(key)
        if actual is not None and actual.strip() != expected:
            raise InstagramRegistryError("target_marker_mismatch")
    if not any(
        os.getenv(key) == environment for key in ("ENVIRONMENT", "HUSSH_RELEASE_ENVIRONMENT")
    ):
        raise InstagramRegistryError("target_environment_missing")
    if not any(os.getenv(key) == project for key in ("GCP_PROJECT_ID", "GOOGLE_CLOUD_PROJECT")):
        raise InstagramRegistryError("target_project_missing")
    if os.getenv("CLOUDSQL_INSTANCE_CONNECTION_NAME") != instance:
        raise InstagramRegistryError("target_instance_missing")
    if os.getenv("APP_FRONTEND_ORIGIN") != origin:
        raise InstagramRegistryError("frontend_origin_missing")
    redirect = f"{origin}{RETURN_PATH}"
    parts = urlsplit(redirect)
    if parts.scheme != "https" or not parts.hostname or parts.query or parts.fragment:
        raise InstagramRegistryError("redirect_invalid")
    return {"environment": environment, "redirect": redirect}


def _attest(connection: Any, environment: str) -> None:
    if environment == "production":
        sql = PROD_DATABASE_ATTESTATION_SQL
        parse = parse_prod_identity
        matches = is_attested_hushh_prod_database
    else:
        sql = UAT_DATABASE_ATTESTATION_SQL
        parse = parse_uat_identity
        matches = is_attested_hushh_tech_uat_database
    try:
        row = connection.execute(text(sql)).mappings().first()
        if row is None or not matches(parse(row)):
            raise InstagramRegistryError("database_identity_mismatch")
    except InstagramRegistryError:
        raise
    except Exception as exc:
        raise InstagramRegistryError("database_attestation_failed") from exc


def _expected(redirect: str) -> dict[str, Any]:
    return {
        "connector_id": CONNECTOR_ID,
        "display_name": "Instagram",
        "description": "Connect a professional Instagram account for posts, public links, insights, comments, and messages.",
        "mcp_endpoint": GRAPH_BASE,
        "auth_style": "oauth",
        "oauth_authorize_url": AUTHORIZE_URL,
        "oauth_token_url": TOKEN_URL,
        "oauth_scopes": " ".join(SCOPES),
        "oauth_client_id_env": "INSTAGRAM_APP_ID",
        "oauth_client_secret_env": "INSTAGRAM_APP_SECRET",
        "api_key_header_name": None,
        "transport_kind": "instagram_graph_rest",
        "capability_policy": POLICY,
        "registered_redirect_uris": [redirect],
        "created_by": PROVISIONED_BY,
        "user_id": None,
    }


def _json(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return None
    return value


def _matches(row: dict[str, Any], expected: dict[str, Any]) -> bool:
    return (
        all(row.get(field) == expected[field] for field in FIELDS)
        and row.get("user_id") is None
        and _json(row.get("capability_policy")) == expected["capability_policy"]
        and _json(row.get("registered_redirect_uris")) == expected["registered_redirect_uris"]
    )


def _load(connection: Any, *, lock: bool) -> dict[str, Any] | None:
    query = "SELECT * FROM external_mcp_connectors WHERE connector_id = :connector_id"
    if lock:
        query += " FOR UPDATE"
    row = connection.execute(text(query), {"connector_id": CONNECTOR_ID}).mappings().first()
    return dict(row) if row is not None else None


def _insert(connection: Any, expected: dict[str, Any]) -> None:
    connection.execute(
        text("""INSERT INTO external_mcp_connectors (
            connector_id, display_name, description, mcp_endpoint, auth_style,
            oauth_authorize_url, oauth_token_url, oauth_scopes, oauth_client_id_env,
            oauth_client_secret_env, api_key_header_name, transport_kind,
            capability_policy, registered_redirect_uris, created_by, is_active
        ) VALUES (
            :connector_id, :display_name, :description, :mcp_endpoint, :auth_style,
            :oauth_authorize_url, :oauth_token_url, :oauth_scopes, :oauth_client_id_env,
            :oauth_client_secret_env, :api_key_header_name, :transport_kind,
            CAST(:capability_policy AS JSONB), CAST(:registered_redirect_uris AS JSONB),
            :created_by, TRUE
        ) ON CONFLICT (connector_id) DO NOTHING"""),
        {
            **expected,
            "capability_policy": json.dumps(expected["capability_policy"], sort_keys=True),
            "registered_redirect_uris": json.dumps(expected["registered_redirect_uris"]),
        },
    )


def _run(environment: str, action: str) -> dict[str, str]:
    target = _target(environment)
    expected = _expected(target["redirect"])
    if action == "activate" and (
        not os.getenv("INSTAGRAM_APP_ID", "").strip()
        or not os.getenv("INSTAGRAM_APP_SECRET", "").strip()
    ):
        raise InstagramRegistryError("instagram_app_credentials_missing")
    db = get_db()
    context = db.engine.begin() if action != "verify" else db.engine.connect()
    with context as connection:
        # This is deliberately the first database query.
        _attest(connection, environment)
        if action != "verify":
            connection.execute(
                text("SELECT pg_advisory_xact_lock(hashtext(:key))"),
                {"key": f"external-connector:instagram:{environment}"},
            )
        row = _load(connection, lock=action != "verify")
        inserted = False
        if action == "activate" and row is None:
            _insert(connection, expected)
            row = _load(connection, lock=True)
            inserted = True
        if row is None:
            raise InstagramRegistryError("registry_row_missing")
        if not _matches(row, expected):
            raise InstagramRegistryError("registry_policy_drift")
        if action == "verify":
            if row.get("is_active") is not True:
                raise InstagramRegistryError("registry_row_inactive")
            status = "verified"
        elif action == "activate":
            status = "activated" if inserted or row.get("is_active") is not True else "verified"
            if row.get("is_active") is not True:
                connection.execute(
                    text(
                        "UPDATE external_mcp_connectors SET is_active = TRUE, updated_at = NOW() "
                        "WHERE connector_id = :connector_id AND user_id IS NULL"
                    ),
                    {"connector_id": CONNECTOR_ID},
                )
        else:
            status = "deactivated"
            connection.execute(
                text(
                    "UPDATE external_mcp_connectors SET is_active = FALSE, updated_at = NOW() "
                    "WHERE connector_id = :connector_id AND user_id IS NULL"
                ),
                {"connector_id": CONNECTOR_ID},
            )
    return {
        "connectorId": CONNECTOR_ID,
        "status": status,
        "environment": environment,
        "registeredRedirectUri": target["redirect"],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", required=True, choices=tuple(TARGETS))
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--activate", action="store_true")
    actions.add_argument("--deactivate", action="store_true")
    args = parser.parse_args(argv)
    action = "activate" if args.activate else "deactivate" if args.deactivate else "verify"
    try:
        print(json.dumps(_run(args.env, action), sort_keys=True))
    except InstagramRegistryError as exc:
        print(json.dumps({"status": "error", "code": str(exc)}), file=sys.stderr)
        return 1
    except Exception:
        print(
            json.dumps({"status": "error", "code": "instagram_registry_unavailable"}),
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
