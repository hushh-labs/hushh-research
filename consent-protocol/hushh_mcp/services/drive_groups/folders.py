"""Gene: folder names and the count of files in each group and fiscal quarter.

Pure apart from reading one small data file. A folder is a group plus a fiscal
quarter, written "Financial Assets (FY 26 Q1)"; files kept by the aid sit in one
folder with no quarter. The names and the fiscal year start are data, so product
copy changes without touching code or the placement model's version.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date, datetime
from functools import lru_cache
from importlib import resources
from zoneinfo import ZoneInfo

from hushh_mcp.services.drive_groups.contract import GROUP_IDS, KEPT
from hushh_mcp.services.drive_groups.period import FiscalQuarter, deciding_day, fiscal_quarter


@dataclass(frozen=True, slots=True)
class FolderNames:
    names: Mapping[str, str]
    kept: str
    fiscal_year_start_month: int

    @classmethod
    def from_payload(cls, payload: object) -> FolderNames:
        if not isinstance(payload, dict) or payload.get("kind") != "folders_v1":
            raise ValueError("invalid folders file")
        names, kept, month = (
            payload.get("names"),
            payload.get("kept"),
            payload.get("fiscal_year_start_month"),
        )
        if (
            not isinstance(names, dict)
            or set(names) != set(GROUP_IDS)
            or any(not _name(value) for value in names.values())
            or not _name(kept)
            or type(month) is not int
            or not 1 <= month <= 12
        ):
            raise ValueError("invalid folders file")
        return cls(dict(names), str(kept), month)

    def folder(self, shelf: str, quarter: FiscalQuarter | None) -> str:
        """The display name of the folder a file sits in."""
        if shelf == KEPT:
            return self.kept
        base = self.names[shelf]
        return f"{base} ({quarter.label})" if quarter is not None else base


def _name(value: object) -> bool:
    return (
        isinstance(value, str)
        and 1 <= len(value) <= 60
        and value == value.strip()
        and all(char.isprintable() for char in value)
    )


@lru_cache(maxsize=1)
def load_folders() -> FolderNames:
    raw = resources.files(__package__).joinpath("data", "folders.json").read_bytes()
    return FolderNames.from_payload(json.loads(raw))


@dataclass(frozen=True, slots=True)
class FolderSummary:
    shelf: str
    year: int | None
    quarter: int | None
    name: str
    count: int

    @property
    def period(self) -> str | None:
        """ "FY26-Q1" for a quarter folder, "undated" for a group's files with no date, None when kept."""
        if self.shelf == KEPT:
            return None
        return f"FY{self.year:02d}-Q{self.quarter}" if self.year is not None else "undated"


_PERIOD = re.compile(r"FY(\d{2})-Q([1-4])\Z")


def parse_period(value: str) -> tuple[int, int] | None:
    """The (year, quarter) a period key names; None for any other string."""
    match = _PERIOD.fullmatch(value) if isinstance(value, str) else None
    return (int(match[1]), int(match[2])) if match else None


def summarize_folders(
    rows: Iterable[tuple[str, date | None, datetime | None, datetime | None]],
    *,
    zone: ZoneInfo,
    names: FolderNames,
) -> list[FolderSummary]:
    """Count files per folder from (shelf, title date, created, modified) rows.

    Order: the four groups as listed, newest quarter first within each, a group's
    undated files last, then the kept folder.
    """
    counts: Counter[tuple[str, int | None, int | None]] = Counter()
    for shelf, title, created, modified in rows:
        day, _ = deciding_day(title=title, created=created, modified=modified, zone=zone)
        quarter = (
            fiscal_quarter(day, names.fiscal_year_start_month)
            if day is not None and shelf != KEPT
            else None
        )
        counts[
            (shelf, quarter.year if quarter else None, quarter.quarter if quarter else None)
        ] += 1
    order = {shelf: position for position, shelf in enumerate((*GROUP_IDS, KEPT))}
    ranked = sorted(
        counts,
        key=lambda key: (
            order[key[0]],
            key[1] is None,
            -(key[1] if key[1] is not None else 0),
            -(key[2] if key[2] is not None else 0),
        ),
    )
    return [
        FolderSummary(
            shelf,
            year,
            quarter,
            names.folder(
                shelf, FiscalQuarter(year, quarter) if year is not None and quarter else None
            ),
            counts[(shelf, year, quarter)],
        )
        for shelf, year, quarter in ranked
    ]
