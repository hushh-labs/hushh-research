"""Seeded synthetic Drive fixture rows; no inference or private information.

Both the original template families and added training-only records use this
renderer so independent generation preserves the original evaluation corpus.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING

from hushh_mcp.services.drive_groups.text_head import HEAD_CHARS, capture_head

if TYPE_CHECKING:
    from build_drive_group_fixtures import Family, Maker

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


PEOPLE = [
    "Alex Morgan",
    "Priya Rao",
    "Jordan Ellis",
    "Sana Khan",
    "Marco Ruiz",
    "Mei Tan",
    "Omar Haddad",
]


PDF, DOC, DOCX, SHEET, TXT = (
    "application/pdf",
    "application/vnd.google-apps.document",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.google-apps.spreadsheet",
    "text/plain",
)


UNINFORMATIVE = [
    "scan_{n:04d}",
    "IMG_{n:04d}",
    "Document ({n})",
    "Untitled document",
    "file{n}",
    "New doc {n}",
]


def tag(m: Maker) -> str:
    return m.rng.choice(
        [
            f"{m.rng.choice(MONTHS)}{m.rng.randint(2024, 2026)}",
            f"{m.rng.randint(2024, 2026)}-{m.rng.randint(1, 12):02d}",
            f"{m.rng.choice(MONTHS)} {m.rng.randint(2024, 2026)}",
            f"Q{m.rng.randint(1, 4)} FY{m.rng.randint(24, 27)}",
            f"({m.rng.randint(1, 9)})",
        ]
    )


def build_row(m: Maker, split: str, label: str, family: Family, serial: int) -> dict:
    head_text, stems = family(m)
    mime = m.rng.choices([PDF, DOC, DOCX, SHEET, TXT], weights=[60, 14, 12, 9, 5])[0]
    scanned = m.rng.random() < 0.12
    informative = m.rng.random() > 0.25
    stem = (
        m.pick(stems).replace("{tag}", tag(m))
        if informative
        else m.pick(UNINFORMATIVE).format(n=serial)
    )
    extension = {PDF: ".pdf", DOCX: ".docx", TXT: ".txt"}.get(mime, "")
    if scanned:
        mime, extension = PDF, ".pdf"
    head = None if scanned else capture_head((m.noisy(head_text),), HEAD_CHARS)
    return {
        "id": f"{split[0]}{serial:04d}",
        "split": split,
        "family": family.__name__,
        "label": label,
        "name": f"{stem}{extension}",
        "mime": mime,
        "shared_with_me": m.rng.random() < (0.08 if label != "none" else 0.3),
        "owned_by_me": m.rng.random() < (0.92 if label != "none" else 0.7),
        "head": head,
    }


def append_training_records(rows: list[dict], maker: Maker, output: Path, count: int) -> None:
    records = json.loads(output.with_name("training_records.json").read_text())
    serial = len(rows)
    for record in records["families"]:

        def family(m, record=record):
            return record["head"].format(
                person=m.pick(PEOPLE), date=m.date(), number=m.digits(8), amount=m.amount()
            ), [record["name"]]

        family.__name__ = record["family"]
        for _ in range(count):
            serial += 1
            rows.append(build_row(maker, "train", record["group"], family, serial))
