"""Local CSV projection of placements. Never exports text starts or vectors."""

from __future__ import annotations

import csv
import io
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from hushh_mcp.services.drive_groups.contract import KEPT
from hushh_mcp.services.drive_groups.folders import load_folders
from hushh_mcp.services.drive_groups.indexer import IndexedFile
from hushh_mcp.services.drive_groups.period import deciding_day, fiscal_quarter, title_day

COLUMNS = (
    "file_name",
    "group",
    "folder",
    "fiscal_quarter",
    "date",
    "date_basis",
    "confidence",
    "model_top_class",
    "candidate_group",
    "reason",
    "mime_type",
    "drive_link",
    "group_source",
    "model_version",
    "index_status",
)


def _moment(value: object) -> datetime | None:
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else None


def _literal(value: object) -> object:
    # CSV quoting alone does not stop Excel/Sheets from executing a formula.
    if isinstance(value, str) and (
        value.lstrip().startswith(("=", "+", "-", "@")) or value.startswith(("\t", "\r", "\n"))
    ):
        return "'" + value
    return value


def placement_rows(
    rows: Sequence[Mapping[str, Any]], files: Sequence[IndexedFile], *, zone: ZoneInfo
) -> list[dict[str, object]]:
    names = load_folders()
    sources = {str(row["id"]): row for row in rows}
    result = []
    for indexed in files:
        row, placement = sources[indexed.file_id], indexed.placement
        name = str(row.get("title", row.get("name", "")))
        created, modified = _moment(row.get("createdTime")), _moment(row.get("modifiedTime"))
        reference, _ = deciding_day(title=None, created=created, modified=modified, zone=zone)
        day, basis = deciding_day(
            title=title_day(name, zone=zone, reference=reference),
            created=created,
            modified=modified,
            zone=zone,
        )
        quarter = (
            fiscal_quarter(day, names.fiscal_year_start_month)
            if day is not None and placement.shelf != KEPT
            else None
        )
        result.append(
            dict(
                zip(
                    COLUMNS,
                    (
                        name,
                        names.names.get(placement.shelf, names.kept),
                        names.folder(placement.shelf, quarter),
                        quarter.label if quarter else "",
                        day.isoformat() if day else "",
                        basis,
                        round(placement.confidence, 6),
                        placement.best_class,
                        names.names.get(placement.candidate, ""),
                        placement.reason,
                        row["mimeType"],
                        row.get("viewUrl") or "",
                        placement.group_source,
                        placement.version,
                        "indexed",
                    ),
                    strict=True,
                )
            )
        )
    return result


def pending_rows(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, object]]:
    """Inventory facts only; blank scores distinguish pending work from a decision."""
    return [
        {
            **dict.fromkeys(COLUMNS, ""),
            "file_name": row.get("title", row.get("name", "")),
            "mime_type": row["mimeType"],
            "drive_link": row.get("viewUrl") or "",
            "reason": "pending",
            "index_status": "pending",
        }
        for row in rows
    ]


def csv_text(rows: Sequence[Mapping[str, object]]) -> str:
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=COLUMNS, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows({key: _literal(row.get(key, "")) for key in COLUMNS} for row in rows)
    return output.getvalue()
