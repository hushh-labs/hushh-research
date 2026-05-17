#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fnmatch
import json
import re
import subprocess
import sys
from collections import OrderedDict, defaultdict
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACT_PATH = REPO_ROOT / "docs/reference/architecture/runtime-db-data-plane-contract.json"
MIGRATIONS_DIR = REPO_ROOT / "consent-protocol/db/migrations"
RUNTIME_SCAN_ROOTS = [
    REPO_ROOT / "consent-protocol/api",
    REPO_ROOT / "consent-protocol/hushh_mcp",
    REPO_ROOT / "hushh-webapp/app",
    REPO_ROOT / "hushh-webapp/lib",
]
CREATE_TABLE_RE = re.compile(
    r"\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-zA-Z_][\w]*)",
    re.IGNORECASE,
)
SQL_WRITE_TEMPLATE = r"\b(?:INSERT\s+INTO|UPDATE)\s+(?:public\.)?{table}\b"
SUPABASE_WRITE_TEMPLATE = r"\.table\(\s*['\"]{table}['\"]\s*\)\s*\.(?:insert|upsert|update)\b"


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _rel(path: Path) -> str:
    return str(path.relative_to(REPO_ROOT))


def _migration_tables() -> OrderedDict[str, list[str]]:
    tables: OrderedDict[str, list[str]] = OrderedDict()
    for migration in sorted(MIGRATIONS_DIR.glob("*.sql")):
        text = migration.read_text(encoding="utf-8", errors="ignore")
        for match in CREATE_TABLE_RE.finditer(text):
            table_name = match.group(1)
            tables.setdefault(table_name, []).append(migration.name)
    return tables


def _match_family(table_name: str, families: list[dict[str, Any]]) -> dict[str, Any] | None:
    for family in families:
        if table_name in family.get("exact_tables", []):
            return family
    for family in families:
        for pattern in family.get("glob_tables", []):
            if fnmatch.fnmatch(table_name, pattern):
                return family
    return None


def _table_classification(
    tables: OrderedDict[str, list[str]], contract: dict[str, Any]
) -> tuple[OrderedDict[str, dict[str, Any]], list[str]]:
    families = contract.get("table_families", [])
    classified: OrderedDict[str, dict[str, Any]] = OrderedDict()
    unclassified: list[str] = []
    for table_name in sorted(tables):
        family = _match_family(table_name, families)
        if family is None:
            unclassified.append(table_name)
            continue
        classified[table_name] = OrderedDict(
            table=table_name,
            family=family["id"],
            data_class=family["data_class"],
            owner=family["owner"],
            lifecycle_status=family["lifecycle_status"],
            migrations=tables[table_name],
        )
    return classified, unclassified


def _validate_contract(contract: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    allowed = set(contract.get("allowed_data_classes", []))
    required_family_fields = [
        "id",
        "owner",
        "data_class",
        "lifecycle_status",
        "primary_access_path",
        "retention_policy",
        "deletion_behavior",
        "trust_boundary",
        "plaintext_posture",
        "expected_row_growth",
    ]
    seen_ids: set[str] = set()
    for index, family in enumerate(contract.get("table_families", []), start=1):
        family_id = str(family.get("id") or f"family[{index}]")
        if family_id in seen_ids:
            errors.append(f"duplicate_family_id:{family_id}")
        seen_ids.add(family_id)
        for field in required_family_fields:
            if not str(family.get(field) or "").strip():
                errors.append(f"{family_id}:missing_{field}")
        if family.get("data_class") not in allowed:
            errors.append(f"{family_id}:invalid_data_class:{family.get('data_class')}")
        if not family.get("exact_tables") and not family.get("glob_tables"):
            errors.append(f"{family_id}:missing_table_matcher")
    return errors


def _legacy_tables(contract: dict[str, Any]) -> list[str]:
    tables: list[str] = []
    for family in contract.get("table_families", []):
        if str(family.get("lifecycle_status") or "").startswith("legacy"):
            tables.extend(family.get("exact_tables", []))
    return sorted(set(tables))


def _scan_legacy_writes(legacy_tables: list[str]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    candidates: list[Path] = []
    for root in RUNTIME_SCAN_ROOTS:
        if root.exists():
            candidates.extend(path for path in root.rglob("*") if path.suffix in {".py", ".ts", ".tsx", ".js", ".mjs"})
    for path in sorted(candidates):
        if "__pycache__" in path.parts or ".next" in path.parts or "node_modules" in path.parts:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        lines = text.splitlines()
        for table in legacy_tables:
            sql_write = re.compile(SQL_WRITE_TEMPLATE.format(table=re.escape(table)), re.IGNORECASE)
            supabase_write = re.compile(
                SUPABASE_WRITE_TEMPLATE.format(table=re.escape(table)),
                re.IGNORECASE | re.DOTALL,
            )
            for line_no, line in enumerate(lines, start=1):
                if sql_write.search(line):
                    findings.append(
                        {
                            "table": table,
                            "path": _rel(path),
                            "line": line_no,
                            "kind": "sql_insert_or_update",
                            "snippet": line.strip()[:180],
                        }
                    )
            for match in supabase_write.finditer(text):
                line_no = text.count("\n", 0, match.start()) + 1
                snippet = " ".join(text[match.start() : match.end()].split())[:180]
                findings.append(
                    {
                        "table": table,
                        "path": _rel(path),
                        "line": line_no,
                        "kind": "supabase_insert_upsert_or_update",
                        "snippet": snippet,
                    }
                )
    return findings


def _family_summary(classified: OrderedDict[str, dict[str, Any]]) -> OrderedDict[str, dict[str, Any]]:
    summary: OrderedDict[str, dict[str, Any]] = OrderedDict()
    grouped: dict[str, list[str]] = defaultdict(list)
    for table, item in classified.items():
        grouped[item["family"]].append(table)
    for family_id in sorted(grouped):
        data_classes = sorted({classified[table]["data_class"] for table in grouped[family_id]})
        summary[family_id] = {
            "tables": sorted(grouped[family_id]),
            "table_count": len(grouped[family_id]),
            "data_classes": data_classes,
        }
    return summary


def _live_stats(database_url: str | None) -> list[dict[str, Any]]:
    if not database_url:
        return []
    query = """
SELECT relname AS table_name,
       n_live_tup::bigint AS estimated_rows,
       pg_total_relation_size(relid)::bigint AS total_bytes
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 25;
"""
    try:
        result = subprocess.run(
            ["psql", database_url, "-v", "ON_ERROR_STOP=1", "-At", "-F", "\t", "-c", query],
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return []
    rows: list[dict[str, Any]] = []
    for raw in result.stdout.splitlines():
        parts = raw.split("\t")
        if len(parts) != 3:
            continue
        rows.append(
            {
                "table": parts[0],
                "estimated_rows": int(parts[1]),
                "total_bytes": int(parts[2]),
            }
        )
    return rows


def build_report(database_url: str | None = None) -> tuple[dict[str, Any], int]:
    contract = _load_json(CONTRACT_PATH)
    tables = _migration_tables()
    classified, unclassified = _table_classification(tables, contract)
    contract_errors = _validate_contract(contract)
    legacy_write_findings = _scan_legacy_writes(_legacy_tables(contract))
    duplicate_creates = {
        table: migrations for table, migrations in tables.items() if len(migrations) > 1
    }
    failures = []
    failures.extend(contract_errors)
    failures.extend(f"unclassified_table:{table}" for table in unclassified)
    failures.extend(
        f"legacy_write:{item['table']}:{item['path']}:{item['line']}" for item in legacy_write_findings
    )
    report = OrderedDict(
        schema_version=1,
        contract_path=_rel(CONTRACT_PATH),
        migrations_dir=_rel(MIGRATIONS_DIR),
        migration_table_count=len(tables),
        classified_table_count=len(classified),
        unclassified_tables=unclassified,
        family_summary=_family_summary(classified),
        duplicate_create_table_occurrences=duplicate_creates,
        growth_watch_tables=contract.get("growth_watch_tables", []),
        legacy_write_findings=legacy_write_findings,
        live_stats=_live_stats(database_url),
        failures=failures,
    )
    return report, 1 if failures else 0


def _print_text(report: dict[str, Any]) -> None:
    print("Data Model Audit")
    print(f"- contract: {report['contract_path']}")
    print(f"- migration tables: {report['migration_table_count']}")
    print(f"- classified tables: {report['classified_table_count']}")
    print(f"- unclassified tables: {len(report['unclassified_tables'])}")
    print(f"- legacy write findings: {len(report['legacy_write_findings'])}")
    print(f"- failures: {len(report['failures'])}")
    print("")
    print("Families")
    for family_id, payload in report["family_summary"].items():
        classes = ", ".join(payload["data_classes"])
        print(f"- {family_id}: {payload['table_count']} table(s), {classes}")
    if report["unclassified_tables"]:
        print("")
        print("Unclassified Tables")
        for table in report["unclassified_tables"]:
            print(f"- {table}")
    if report["legacy_write_findings"]:
        print("")
        print("Legacy Write Findings")
        for item in report["legacy_write_findings"]:
            print(f"- {item['table']} {item['path']}:{item['line']} {item['kind']}")
    if report["live_stats"]:
        print("")
        print("Live Table Stats")
        for row in report["live_stats"]:
            print(f"- {row['table']}: rows~{row['estimated_rows']} bytes={row['total_bytes']}")
    if report["failures"]:
        print("")
        print("Blocking Failures")
        for failure in report["failures"]:
            print(f"- {failure}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit runtime DB data-plane contract coverage.")
    parser.add_argument("--json", action="store_true", help="Print JSON output.")
    parser.add_argument("--text", action="store_true", help="Print text output.")
    parser.add_argument(
        "--database-url",
        default=None,
        help="Optional Postgres URL for read-only live table size/row estimates via psql.",
    )
    args = parser.parse_args()
    report, code = build_report(database_url=args.database_url)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        _print_text(report)
    return code


if __name__ == "__main__":
    sys.exit(main())
