"""Value objects and closed vocabularies of the Drive four-group organizing aid.

Standard library only; no network, model or environment read at import. A
placement puts one file on a virtual shelf. It grants no sharing, consent or
search authority, and it never touches the owner's Google Drive.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Final, Literal

GroupId = Literal[
    "financial_statements",
    "non_financial_statements",
    "insurance_statements",
    "personal_documents",
]
GROUP_IDS: Final[tuple[GroupId, ...]] = (
    "financial_statements",
    "non_financial_statements",
    "insurance_statements",
    "personal_documents",
)
# What a model scores: the four groups, then the files that fit none of them.
NONE_CLASS: Final = "none"
CLASSES: Final[tuple[str, ...]] = (*GROUP_IDS, NONE_CLASS)
# The id of the shelf for files the aid will not place. Storage and the page
# use this id; it is not a model class.
KEPT: Final = "kept"
SIGNALS: Final[tuple[str, ...]] = ("text", "embedding", "metadata")
EMBEDDING_DIMENSIONS: Final = 384

# Stored beside every placement so a later agent label can be told apart from
# this aid's, and so the aid's rate of disagreement with it stays readable.
GROUP_SOURCE: Final = "organizer_v1"

# Why a file was placed or kept. Closed, so a count by reason is safe to log.
REASONS: Final = frozenset(
    {"placed", "fits_none", "low_confidence", "low_margin", "disagreement", "no_evidence"}
)

# Global kill-switch, dark by default. Owner-bound runtime entrypoints also
# enforce connector_feature_admission; this leaf switch grants no authority.
FLAG: Final = "DRIVE_FOUR_GROUP_INDEX_ENABLED"


def four_group_index_enabled() -> bool:
    return os.getenv(FLAG, "").strip().lower() == "true"


class GroupIndexDisabled(RuntimeError):
    """The aid was asked to run while its flag is off."""


@dataclass(frozen=True, slots=True)
class SignalReading:
    """One signal's probabilities over CLASSES, or None when it had no evidence."""

    name: str
    probabilities: tuple[float, ...] | None

    @property
    def available(self) -> bool:
        return self.probabilities is not None

    @property
    def top(self) -> str | None:
        if self.probabilities is None:
            return None
        return CLASSES[max(range(len(CLASSES)), key=self.probabilities.__getitem__)]


@dataclass(frozen=True, slots=True)
class Placement:
    """The aid's decision for one file; ``group`` is None when the file is kept.

    ``candidate`` is the best of the four groups even for a kept file, so a
    review can offer it; ``best_class`` and ``confidence`` describe the most
    likely of all five classes, including the files that fit none.
    """

    group: GroupId | None
    candidate: GroupId | None
    best_class: str
    confidence: float
    margin: float
    reason: str
    readings: tuple[SignalReading, ...]
    version: str
    group_source: str = GROUP_SOURCE

    @property
    def shelf(self) -> str:
        return self.group if self.group is not None else KEPT


@dataclass(frozen=True, slots=True)
class FileEvidence:
    """What the aid may look at for one file; nothing here grants access to it.

    ``head`` is the first few hundred characters of the file's text, or None
    when the file has no extractable text. ``vector`` is its pinned embedding.
    """

    name: str
    mime_type: str
    owned_by_me: bool | None = None
    shared_with_me: bool | None = None
    head: str | None = None
    vector: tuple[float, ...] | None = None
