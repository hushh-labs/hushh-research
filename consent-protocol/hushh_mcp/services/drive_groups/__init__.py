"""Drive four-group organizing aid: sorts a person's Drive files onto virtual shelves.

A non-generative aid, declared in ``docs/reference/backend-semantic-boundary.md``.
It uses no model that writes text. Three signals (the text start, its pinned
embedding and Drive metadata) are fused into one calibrated confidence; below
the threshold a file is kept, with its text start and embedding, never dropped.
Dark by default behind ``DRIVE_FOUR_GROUP_INDEX_ENABLED``. See ``indexer.py``.
"""

from hushh_mcp.services.drive_groups.contract import (
    CLASSES,
    GROUP_IDS,
    GROUP_SOURCE,
    KEPT,
    FileEvidence,
    GroupIndexDisabled,
    Placement,
    SignalReading,
    four_group_index_enabled,
)
from hushh_mcp.services.drive_groups.indexer import IndexedFile, IndexRun, index_files
from hushh_mcp.services.drive_groups.models import ModelBundle, load_bundle
from hushh_mcp.services.drive_groups.placement import place
from hushh_mcp.services.drive_groups.text_head import capture_head

__all__ = [
    "CLASSES",
    "GROUP_IDS",
    "GROUP_SOURCE",
    "KEPT",
    "FileEvidence",
    "GroupIndexDisabled",
    "IndexRun",
    "IndexedFile",
    "ModelBundle",
    "Placement",
    "SignalReading",
    "capture_head",
    "four_group_index_enabled",
    "index_files",
    "load_bundle",
    "place",
]
