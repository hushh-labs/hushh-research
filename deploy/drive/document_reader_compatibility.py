# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Source capability and retained inventory for document reader versions."""

from __future__ import annotations

import re
import subprocess

READER_FILES = (
    "consent-protocol/api/routes/document_delivery.py",
    "hushh-webapp/app/one/documents/open/page.tsx",
)
# First published v2 implementation: mounted API, background URL dispatcher and
# unattended worker. A v1 ancestor alone does not establish these capabilities.
BACKGROUND_READER_ANCESTOR = "230cc57ea12226f8fd7d548e372512d79f694ab9"
BACKGROUND_READER_FILES = (
    "consent-protocol/api/routes/document_delivery_background.py",
    "consent-protocol/api/routes/connector_routes.py",
    "consent-protocol/hushh_mcp/services/document_delivery/background_service.py",
    "consent-protocol/hushh_mcp/services/document_delivery/lifecycle.py",
    "hushh-webapp/components/consent/hosted-documents-page.tsx",
    "hushh-webapp/components/consent/background-document-files.tsx",
)


def reader_supported(
    sha: str, ancestor: str, *, required_files: tuple[str, ...] = READER_FILES
) -> bool:
    if not all(
        isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value) for value in (sha, ancestor)
    ):
        return False
    commands = [
        ["git", "merge-base", "--is-ancestor", ancestor, sha],
        *(["git", "cat-file", "-e", f"{sha}:{path}"] for path in required_files),
    ]
    return all(
        subprocess.run(command, capture_output=True, check=False).returncode == 0  # noqa: S603 -- Fixed git operations, validated SHA arguments, no shell.
        for command in commands
    )


def inventory_empty(connection, *, schema: str = "public", background_only: bool = False) -> bool:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", schema):
        raise ValueError("Invalid document inventory schema")
    from psycopg2 import sql

    with connection.cursor() as cursor:
        tables: tuple[str, ...] = ("document_delivery_background_requests",)
        if not background_only:
            tables += (
                "document_delivery_contracts",
                "document_delivery_financial_bindings",
            )
        for table in (*tables, "document_delivery_cleanup"):
            cursor.execute("SELECT to_regclass(%s)", (schema + "." + table,))
            if cursor.fetchone()[0] is not None:
                predicate = (
                    sql.SQL(" WHERE object_key LIKE 'background-v2/%'")
                    if background_only and table == "document_delivery_cleanup"
                    else sql.SQL("")
                )
                cursor.execute(
                    sql.SQL("SELECT EXISTS(SELECT 1 FROM {}.{}{})").format(
                        sql.Identifier(schema), sql.Identifier(table), predicate
                    )
                )
                if cursor.fetchone()[0] is True:
                    return False
    return True
