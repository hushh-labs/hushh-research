"""Read-only admission for the reviewed, production-only pre-pod restoration.

This main-owned record is separate from the historical migration manifest.
It proves an exact backport; it does not authorize migrations or traffic changes.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path

RECORD = Path(__file__).with_name("production-restoration.json")
POLICY = "consent-protocol/config/account-deletion-authority.json"
PHONE_RELATIONS = (
    "account_phone_transfers",
    "account_phone_auth_fences",
    "account_phone_recovery_continuations",
    "account_device_actions",
)
PHONE_PRODUCER_PATHS = (
    "consent-protocol/api",
    "consent-protocol/hushh_mcp",
    "consent-protocol/db",
    "consent-protocol/server.py",
    "consent-protocol/server_drive_worker.py",
)


class Refused(ValueError):
    """Redacted qualification failure; provider data never enters diagnostics."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Refused(message)


def git(*arguments: str) -> str:
    result = subprocess.run(  # noqa: S603 -- fixed Git executable, no shell.
        ["git", *arguments], capture_output=True, text=True, timeout=30
    )
    require(result.returncode == 0, "Restoration source could not be verified")
    return result.stdout


def qualify_source(sha: str) -> dict:
    require(bool(re.fullmatch(r"[0-9a-f]{40}", sha)), "Exact restoration SHA required")
    record = json.loads(RECORD.read_text())
    require(
        record.get("schemaVersion") == 1
        and record.get("sourceSha") == sha
        and record.get("project") == "hushh-pda"
        and record.get("region") == "us-central1"
        and record.get("providerContractVersion") == 2
        and record.get("migrations") == "none"
        and record.get("services") == ["consent-protocol", "hushh-webapp"]
        and record.get("replacementAccounts") == 0,
        "Source is not the reviewed production restoration",
    )
    for key in ("baselineSha", "previousSha"):
        require(
            bool(re.fullmatch(r"[0-9a-f]{40}", record.get(key, ""))),
            "Invalid source boundary",
        )
    git("merge-base", "--is-ancestor", record["baselineSha"], sha)
    policy = git("show", f"{sha}:{POLICY}")
    require(
        hashlib.sha256(policy.encode()).hexdigest() == record.get("authorityPolicySha256")
        and json.loads(policy).get("version") == 1,
        "Restoration authority policy changed",
    )
    return record


def qualify_recorded_source() -> dict:
    """Resolve only the current canonical record, never a caller's history pin."""
    return qualify_source(json.loads(RECORD.read_text())["sourceSha"])


def qualify_phone_history_source(sha: str, *, project: str) -> dict:
    """Admit the exact audited non-producer as history, never as a phone reader."""
    require(project == "hushh-pda", "Phone history restoration requires production")
    record = qualify_recorded_source()
    require(
        record.get("requiredAbsentTables") == list(PHONE_RELATIONS)
        and (
            sha == record["sourceSha"]
            or (
                sha
                == record["previousSha"]
                == record.get("previousServices", {}).get("consent-protocol", {}).get("sha")
            )
        ),
        "Phone history source boundary changed",
    )
    # The immutable reviewed source must also retain its audited absence of the
    # new authority. A manifest or an empty live database alone cannot prove it.
    result = subprocess.run(  # noqa: S603 -- fixed Git read and qualified immutable SHA.
        [
            "git",
            "grep",
            "-IlE",
            "|".join((*PHONE_RELATIONS, "phone_unlink")),
            sha,
            "--",
            *PHONE_PRODUCER_PATHS,
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    require(
        result.returncode == 1 and not result.stdout and not result.stderr,
        "Restoration phone producer absence could not be verified",
    )
    return record


def qualify_deployment(
    sha: str,
    *,
    scope: str,
    image_source: str,
    drive_mode: str,
    cadence_origin: str,
    phone_rollback_sha: str,
    enable_email_kyc: str,
) -> dict:
    """Bound the exceptional receipt to the paired, manually requested restore."""
    record = qualify_source(sha)
    require(
        scope == "all"
        and image_source == "build-from-source"
        and drive_mode == "disable"
        and cadence_origin == ""
        and phone_rollback_sha == ""
        and enable_email_kyc == "false",
        "Restoration requires paired source builds, disabled Drive intake and no new capabilities or cadence",
    )
    return record


def qualify_schema(connection, record: dict, *, require_empty_documents: bool) -> dict:
    """Inspect the installed production contract without DDL or data writes."""
    from psycopg2 import sql

    with connection.cursor() as cursor:
        cursor.execute("SHOW transaction_read_only")
        require(cursor.fetchone()[0] == "on", "Read-only schema connection required")
        cursor.execute("SELECT current_database()")
        require(cursor.fetchone()[0] == "hushh_vault", "Production database required")
        cursor.execute(
            "SELECT public.account_provider_cleanup_contract_version(), EXISTS("
            "SELECT 1 FROM pg_trigger WHERE tgrelid='public.account_deletion_tombstones'::regclass "
            "AND tgname='account_shared_provider_authority' AND tgenabled='O' AND NOT tgisinternal)"
        )
        version, trigger = cursor.fetchone()
        require(
            version == record["providerContractVersion"] and trigger is True,
            "Cleanup authority changed",
        )
        require(
            record.get("requiredAbsentTables") == list(PHONE_RELATIONS),
            "Phone compatibility boundary changed",
        )
        for table in record["requiredAbsentTables"]:
            cursor.execute("SELECT to_regclass(%s)", ("public." + table,))
            require(
                cursor.fetchone()[0] is None,
                "Installed phone contract requires a newer reader",
            )
        cursor.execute(
            "SELECT EXISTS(SELECT 1 FROM public.account_generations WHERE generation<>0)"
        )
        require(
            cursor.fetchone()[0] is False,
            "Replacement accounts require newer admission",
        )
        documents = (
            "document_delivery_contracts",
            "document_delivery_financial_bindings",
            "document_delivery_cleanup",
        )
        require(
            record.get("requiredEmptyTables") == list(documents),
            "Document inventory boundary changed",
        )
        if require_empty_documents:
            for table in documents:
                cursor.execute(
                    sql.SQL("SELECT EXISTS(SELECT 1 FROM public.{})").format(sql.Identifier(table))
                )
                require(
                    cursor.fetchone()[0] is False,
                    "Retained documents require their current reader",
                )
    return {
        "providerContractVersion": version,
        "replacementAccounts": 0,
        "documentsChecked": require_empty_documents,
    }
