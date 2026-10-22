"""Gene: the text start of a file, the first few hundred characters of its text.

Pure. The existing isolated parser extracts the text; this only bounds and
cleans it. The head is private document content: callers keep it in memory or
in encrypted storage and never log it.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable

HEAD_CHARS = 400
MIN_HEAD_CHARS = 200
MAX_HEAD_CHARS = 500
# Fewer letters and digits than this is a scan artefact or a near-empty page.
MIN_SIGNAL_CHARS = 12
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\ufeff]")
_SPACE = re.compile(r"\s+")


def capture_head(pages: Iterable[str], limit: int = HEAD_CHARS) -> str | None:
    """The first ``limit`` characters of the text, or None when it has no usable text.

    Compatibility characters (PDF ligatures) are folded, control marks are
    dropped and whitespace is collapsed. A word cut by the limit is dropped.
    """
    if type(limit) is not int or not MIN_HEAD_CHARS <= limit <= MAX_HEAD_CHARS:
        raise ValueError("head limit out of range")
    collected = ""
    for page in pages:
        if not isinstance(page, str):
            raise TypeError("pages must be text")
        cleaned = _SPACE.sub(" ", _CONTROL.sub("", unicodedata.normalize("NFKC", page))).strip()
        if cleaned:
            collected = f"{collected} {cleaned}" if collected else cleaned
        if len(collected) > limit:
            break
    if sum(char.isalnum() for char in collected) < MIN_SIGNAL_CHARS:
        return None
    if len(collected) <= limit:
        return collected
    head = collected[:limit]
    if not collected[limit].isspace() and " " in head[-40:]:
        head = head[: head.rindex(" ")]
    return head
