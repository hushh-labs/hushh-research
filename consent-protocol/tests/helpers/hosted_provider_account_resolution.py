"""Install migration 983's account resolver in legacy disposable fixtures."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

_MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "db/migrations/parked/983_hosted_provider_account_resolution.sql"
)
_FUNCTION = re.compile(
    r"CREATE OR REPLACE FUNCTION public\.hosted_provider_effective_billing_account\(p_row jsonb\)"
    r".*?\$\$;",
    re.DOTALL,
)


def _migration_function() -> str:
    sql = _MIGRATION.read_text(encoding="utf-8")
    matches = _FUNCTION.findall(sql)
    if len(matches) != 1:
        raise RuntimeError("Migration 983 must define exactly one provider account resolver")
    return matches[0]


def install_hosted_provider_account_resolver(pg: Any) -> None:
    """Install the exact resolver DDL for older schemas used by focused lifecycle fixtures."""
    previous = str(pg.execute("SHOW check_function_bodies")[0][0]).lower()
    if previous not in {"on", "off"}:
        raise RuntimeError("Unexpected check_function_bodies setting")
    pg.execute("SET check_function_bodies=off")
    try:
        pg.execute(_migration_function())
    finally:
        pg.execute(f"SET check_function_bodies={previous}")
