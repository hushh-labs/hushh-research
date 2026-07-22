#!/usr/bin/env python3
"""Create a read-only, value-free Postgres preservation manifest.

The report contains catalog metadata, counts, null distributions, orphan counts,
and one-way row/ciphertext aggregates. It never emits row values, credentials,
connection strings, or decrypted information. Output is restricted to the
repository's ignored ``tmp/`` directory because exact counts remain operational
evidence rather than source-controlled documentation.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

import asyncpg


_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_CIPHERTEXT_COLUMN = re.compile(r"(cipher|encrypted|wrapped|envelope|token_hash)", re.I)


def _quote(identifier: str) -> str:
    if not _IDENTIFIER.fullmatch(identifier):
        raise ValueError(f"unsafe catalog identifier: {identifier!r}")
    return f'"{identifier}"'


def _stable_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    return hashlib.sha256(encoded).hexdigest()


def _catalog_is_additive(reference: dict[str, Any], current: dict[str, Any]) -> bool:
    for key in (
        "tables", "columns", "constraints", "indexes", "triggers",
        "functions", "extensions", "grants",
    ):
        before = {_stable_hash(item) for item in reference.get(key, [])}
        after = {_stable_hash(item) for item in current.get(key, [])}
        if not before.issubset(after):
            return False
    return True


def _required_tmp_output(repo_root: Path, raw: str) -> Path:
    path = Path(raw).expanduser().resolve()
    tmp_root = (repo_root / "tmp").resolve()
    if path != tmp_root and tmp_root not in path.parents:
        raise ValueError("preservation reports must be written under the ignored tmp/ directory")
    return path


async def _catalog(conn: asyncpg.Connection) -> dict[str, Any]:
    tables = await conn.fetch(
        """
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        ORDER BY c.relname
        """
    )
    columns = await conn.fetch(
        """
        SELECT table_name, column_name, ordinal_position, data_type, udt_name,
               is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position
        """
    )
    constraints = await conn.fetch(
        """
        SELECT conrelid::regclass::text AS table_name, conname,
               contype, pg_get_constraintdef(oid, true) AS definition
        FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace
        ORDER BY conrelid::regclass::text, conname
        """
    )
    indexes = await conn.fetch(
        """
        SELECT tablename AS table_name, indexname, indexdef
        FROM pg_indexes WHERE schemaname = 'public'
        ORDER BY tablename, indexname
        """
    )
    triggers = await conn.fetch(
        """
        SELECT event_object_table AS table_name, trigger_name, action_timing,
               event_manipulation, action_statement
        FROM information_schema.triggers
        WHERE trigger_schema = 'public'
        ORDER BY event_object_table, trigger_name, event_manipulation
        """
    )
    functions = await conn.fetch(
        """
        SELECT p.proname AS function_name,
               pg_get_function_identity_arguments(p.oid) AS arguments,
               pg_get_function_result(p.oid) AS result_type
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
        ORDER BY p.proname, arguments
        """
    )
    extensions = await conn.fetch("SELECT extname, extversion FROM pg_extension ORDER BY extname")
    grants = await conn.fetch(
        """
        SELECT table_name, grantee, privilege_type
        FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
        ORDER BY table_name, grantee, privilege_type
        """
    )
    return {
        "tables": [dict(row) for row in tables],
        "columns": [dict(row) for row in columns],
        "constraints": [dict(row) for row in constraints],
        "indexes": [dict(row) for row in indexes],
        "triggers": [dict(row) for row in triggers],
        "functions": [dict(row) for row in functions],
        "extensions": [dict(row) for row in extensions],
        "grants": [dict(row) for row in grants],
    }


async def _primary_key_columns(conn: asyncpg.Connection, table: str) -> list[str]:
    rows = await conn.fetch(
        """
        SELECT a.attname AS column_name
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = to_regclass($1) AND i.indisprimary
        ORDER BY array_position(i.indkey, a.attnum)
        """,
        f"public.{table}",
    )
    return [str(row["column_name"]) for row in rows]


async def _table_manifest(
    conn: asyncpg.Connection,
    table: str,
    column_names: list[str],
) -> dict[str, Any]:
    quoted_table = _quote(table)
    primary_key = await _primary_key_columns(conn, table)
    order_clause = (
        ", ".join(f"source.{_quote(column)}" for column in primary_key)
        if primary_key
        else "md5(row_to_json(source)::text)"
    )
    projected_columns = ", ".join(f"source.{_quote(column)}" for column in column_names)
    digest = hashlib.sha256()
    row_count = 0
    async with conn.transaction(readonly=True):
        query = (
            "SELECT md5(row_to_json(projected)::text) AS row_hash FROM ("
            f"SELECT {projected_columns} FROM {quoted_table} source ORDER BY {order_clause}"
            ") projected"
        )
        async for record in conn.cursor(query, prefetch=500):
            digest.update(str(record["row_hash"]).encode("ascii"))
            digest.update(b"\n")
            row_count += 1

    null_expressions = [
        f'COUNT(*) FILTER (WHERE {_quote(column)} IS NULL) AS "n{index}"'
        for index, column in enumerate(column_names)
    ]
    null_row = await conn.fetchrow(
        f"SELECT {', '.join(null_expressions)} FROM {quoted_table}"
        if null_expressions
        else f"SELECT COUNT(*) AS count FROM {quoted_table}"
    )
    null_counts = {
        column: int(null_row[f"n{index}"])
        for index, column in enumerate(column_names)
    }

    ciphertext_columns = [column for column in column_names if _CIPHERTEXT_COLUMN.search(column)]
    ciphertext_bytes: dict[str, int] = {}
    for column in ciphertext_columns:
        value = await conn.fetchval(
            f"SELECT COALESCE(SUM(octet_length({_quote(column)}::text)), 0)::bigint "
            f"FROM {quoted_table}"
        )
        ciphertext_bytes[column] = int(value or 0)

    pk_range_digest = None
    if primary_key and row_count:
        pk_expression = ", ".join(_quote(column) for column in primary_key)
        pk_order = ", ".join(_quote(column) for column in primary_key)
        bounds = await conn.fetchrow(
            "SELECT md5("
            f"COALESCE((SELECT ROW({pk_expression})::text FROM {quoted_table} "
            f"ORDER BY {pk_order} LIMIT 1), '') || '|' || "
            f"COALESCE((SELECT ROW({pk_expression})::text FROM {quoted_table} "
            f"ORDER BY {pk_order} DESC LIMIT 1), '')"
            ") AS digest"
        )
        pk_range_digest = str(bounds["digest"] or "")

    return {
        "table": table,
        "row_count": row_count,
        "primary_key_columns": primary_key,
        "primary_key_range_digest": pk_range_digest,
        "deterministic_row_digest_sha256": digest.hexdigest(),
        "null_counts": null_counts,
        "ciphertext_byte_aggregates": ciphertext_bytes,
    }


async def _foreign_key_orphans(conn: asyncpg.Connection) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        """
        SELECT c.conname, child.relname AS child_table, parent.relname AS parent_table,
               ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                     ORDER BY k.ord) AS child_columns,
               ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
                     JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
                     ORDER BY k.ord) AS parent_columns
        FROM pg_constraint c
        JOIN pg_class child ON child.oid = c.conrelid
        JOIN pg_class parent ON parent.oid = c.confrelid
        WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
        ORDER BY child.relname, c.conname
        """
    )
    results = []
    for row in rows:
        child_columns = list(row["child_columns"])
        parent_columns = list(row["parent_columns"])
        join = " AND ".join(
            f"c.{_quote(child)} = p.{_quote(parent)}"
            for child, parent in zip(child_columns, parent_columns, strict=True)
        )
        present = " AND ".join(f"c.{_quote(column)} IS NOT NULL" for column in child_columns)
        missing = f"p.{_quote(parent_columns[0])} IS NULL"
        count = await conn.fetchval(
            f"SELECT COUNT(*) FROM {_quote(str(row['child_table']))} c "
            f"LEFT JOIN {_quote(str(row['parent_table']))} p ON {join} "
            f"WHERE ({present}) AND {missing}"
        )
        results.append({"constraint": row["conname"], "orphan_count": int(count or 0)})
    return results


async def run(args: argparse.Namespace) -> int:
    repo_root = Path(__file__).resolve().parents[2]
    output = _required_tmp_output(repo_root, args.output)
    if args.comparison_mode == "preservation" and not args.reference:
        raise RuntimeError("preservation comparison requires a source reference")
    database_url = str(args.database_url or "").strip()
    if not database_url:
        protocol_root = repo_root / "consent-protocol"
        sys.path.insert(0, str(protocol_root))
        from dotenv import load_dotenv

        load_dotenv(protocol_root / ".env")
        from db.connection import get_database_url

        database_url = get_database_url()
    started = time.time()
    conn = await asyncpg.connect(database_url, command_timeout=float(args.statement_timeout))
    try:
        await conn.execute("SET default_transaction_read_only = on")
        identity = await conn.fetchrow(
            "SELECT current_database() AS database_name, current_setting('server_version_num') AS version"
        )
        catalog = await _catalog(conn)
        reference = None
        if args.reference:
            reference = json.loads(Path(args.reference).read_text(encoding="utf-8"))
        columns_by_table: dict[str, list[str]] = {}
        for column in catalog["columns"]:
            columns_by_table.setdefault(str(column["table_name"]), []).append(
                str(column["column_name"])
            )
        projection_columns = columns_by_table
        if reference and args.comparison_mode == "preservation":
            projection_columns = {}
            for column in reference.get("catalog", {}).get("columns", []):
                projection_columns.setdefault(str(column["table_name"]), []).append(
                    str(column["column_name"])
                )
            for table, required_columns in projection_columns.items():
                if table not in columns_by_table or not set(required_columns).issubset(
                    columns_by_table[table]
                ):
                    raise RuntimeError("additive reconciliation removed a table or column")
        table_manifests = []
        for table in sorted(projection_columns):
            table_manifests.append(
                await _table_manifest(conn, table, projection_columns[table])
            )
        orphans = await _foreign_key_orphans(conn)
        catalog_sha256 = _stable_hash(catalog)
        database_identity_hash = "sha256:" + _stable_hash(dict(identity))
        body = {
            "schema_version": "db_preservation_manifest.v1",
            "created_at_epoch": int(time.time()),
            "database_identity_hash": database_identity_hash,
            "catalog_sha256": catalog_sha256,
            "catalog": catalog,
            "tables": table_manifests,
            "foreign_key_orphans": orphans,
        }
        manifest_id = "sha256:" + _stable_hash(body)
        violations = [item for item in orphans if item["orphan_count"]]
        comparison_projection = {
            "catalog_sha256": catalog_sha256,
            "tables": table_manifests,
            "foreign_key_orphans": orphans,
        }
        exact_matches = bool(
            reference and comparison_projection == {
                "catalog_sha256": reference.get("catalog_sha256"),
                "tables": reference.get("tables"),
                "foreign_key_orphans": reference.get("foreign_key_orphans"),
            }
        )
        reference_orphans = {
            (item.get("constraint"), item.get("orphan_count"))
            for item in (reference or {}).get("foreign_key_orphans", [])
        }
        current_orphans = {
            (item.get("constraint"), item.get("orphan_count")) for item in orphans
        }
        preservation_matches = bool(
            reference
            and table_manifests == reference.get("tables")
            and reference_orphans.issubset(current_orphans)
            and _catalog_is_additive(reference.get("catalog", {}), catalog)
        )
        comparison_ok = (
            exact_matches if args.comparison_mode == "exact" else preservation_matches
        )
        restore_evidence = None
        if args.restore_evidence:
            restore_evidence = json.loads(Path(args.restore_evidence).read_text(encoding="utf-8"))
        backup_checksum = str(args.backup_checksum_sha256 or "").strip().lower()
        valid_backup_checksum = bool(re.fullmatch(r"[0-9a-f]{64}", backup_checksum))
        restore_proven = bool(
            args.comparison_mode == "exact"
            or (
                restore_evidence
                and restore_evidence.get("status") == "ok"
                and restore_evidence.get("restore_status") == "ok"
                and restore_evidence.get("evidence_kind") == "clone_comparison"
                and restore_evidence.get("database_identity_hash")
                == reference.get("database_identity_hash")
                and restore_evidence.get("backup_checksum_sha256") == backup_checksum
                and valid_backup_checksum
            )
        )
        report = {
            **body,
            "database_identity_hash": (
                str(reference.get("database_identity_hash"))
                if reference
                else database_identity_hash
            ),
            "clone_database_identity_hash": database_identity_hash if reference else None,
            "preservation_manifest_id": manifest_id,
            "evidence_kind": (
                "baseline_authorization"
                if args.comparison_mode == "preservation" and restore_proven
                else "clone_comparison" if args.comparison_mode == "exact" else "capture"
            ),
            "schema_status": "ok",
            "preservation_status": "ok" if comparison_ok else "capture_only",
            "restore_status": "ok" if comparison_ok and restore_proven else "not_proven",
            "backup_checksum_sha256": backup_checksum if valid_backup_checksum else None,
            "status": (
                "ok"
                if comparison_ok and restore_proven and valid_backup_checksum
                else "capture_only"
            ),
            "duration_ms": round((time.time() - started) * 1000),
            "violation_count": len(violations),
        }
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
        print(json.dumps({key: report[key] for key in (
            "status", "schema_status", "preservation_status", "preservation_manifest_id",
            "catalog_sha256", "duration_ms", "violation_count"
        )}))
        return 0 if report["status"] in {"ok", "capture_only"} else 1
    finally:
        await conn.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", default=os.getenv("DATABASE_URL", ""))
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--reference",
        default="",
        help="Capture report from the source database; comparison proves clone parity.",
    )
    parser.add_argument(
        "--comparison-mode",
        choices=("exact", "preservation"),
        default="exact",
    )
    parser.add_argument(
        "--restore-evidence",
        default="",
        help="Successful exact clone-comparison report required for baseline authorization.",
    )
    parser.add_argument(
        "--backup-checksum-sha256",
        default="",
        help="Checksum independently verified for the backup restored into this database.",
    )
    parser.add_argument("--statement-timeout", type=float, default=300.0)
    return parser.parse_args()


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(run(parse_args())))
    except Exception as exc:
        print(json.dumps({"status": "error", "failure_class": type(exc).__name__}))
        raise SystemExit(1) from None
