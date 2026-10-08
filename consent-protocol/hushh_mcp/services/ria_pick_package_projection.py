"""Pure RIA pick-package projections; authority and persistence remain in RIAIAMService."""

from __future__ import annotations

from typing import Any, Callable


def coerce_package_rows(rows: Any) -> list[dict[str, Any]]:
    if not isinstance(rows, list):
        return []
    return [dict(row) for row in rows if isinstance(row, dict)]


def normalize_ria_pick_thesis_text(value: Any, *, max_length: int) -> str | None:
    text = str(value or "").strip()
    return text[:max_length] if text else None


def count_screening_rows(screening_sections: list[dict[str, Any]] | None) -> int:
    if not isinstance(screening_sections, list):
        return 0
    total = 0
    for section in screening_sections:
        if not isinstance(section, dict):
            continue
        rows = section.get("rows")
        if isinstance(rows, list):
            total += len(rows)
    return total


def build_pick_package_summary(
    *,
    package: dict[str, Any],
    storage_source: str,
    revision: int | None,
    updated_at: str | None,
    active_share_count: int,
    has_package: bool,
    pkm_path: str,
    count_rows: Callable[[list[dict[str, Any]] | None], int],
) -> dict[str, Any]:
    top_picks = package.get("top_picks") if isinstance(package, dict) else []
    avoid_rows = package.get("avoid_rows") if isinstance(package, dict) else []
    screening_sections = package.get("screening_sections") if isinstance(package, dict) else []
    return {
        "has_package": bool(has_package),
        "storage_source": storage_source,
        "package_revision": int(revision or 0),
        "top_pick_count": len(top_picks) if isinstance(top_picks, list) else 0,
        "avoid_count": len(avoid_rows) if isinstance(avoid_rows, list) else 0,
        "screening_row_count": count_rows(screening_sections),
        "last_updated": updated_at,
        "active_share_count": max(0, int(active_share_count or 0)),
        "path": pkm_path,
    }
