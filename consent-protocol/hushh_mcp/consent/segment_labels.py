"""One readable name for one path segment, on the server side.

The mirror of ``hushh-webapp/lib/pkm/humanize-segment.ts``. Both exist because a
label written by this service and a label written by the browser end up side by
side on the same screen, so they have to agree word for word. The shared truth
table lives at ``contracts/pkm/segment-humanization.v1.json`` and both test
suites read it; that file is the reason these two can be kept in step at all.

The rule this module cannot enforce is the one that matters: call it while the
original key is still in hand. Scope-path normalization lowercases, deliberately
and correctly, because the path is a canonical authorization string.
``addressDetails`` becomes ``addressdetails`` and no function can put that space
back afterwards.
"""

from __future__ import annotations

import re

# An acronym followed by a word: ``SSNNumber`` -> ``SSN Number``. Must run before
# the ordinary boundary below, which cannot see it.
_ACRONYM_BOUNDARY = re.compile(r"([A-Z]+)([A-Z][a-z])")
# The ordinary camelCase boundary: ``addressDetails`` -> ``address Details``.
_CAMEL_BOUNDARY = re.compile(r"([a-z0-9])([A-Z])")
# A word running straight into digits reads as a machine name. Only split when
# the word is long enough to be a word, so short codes (w2, k1) stay intact.
_DIGIT_BOUNDARY = re.compile(r"([a-z]{3,})(\d+)", re.IGNORECASE)
_ARRAY_INDEX = re.compile(r"\[\d+\]")
_SEPARATORS = re.compile(r"[_-]+")
_WHITESPACE = re.compile(r"\s+")
_WORD_START = re.compile(r"\b\w")

_OPAQUE_ID_PATTERNS = (
    re.compile(
        r"^(mem|ent|entity|item|entry|rec|record|obj|node|evt|event)[_-][a-z0-9][a-z0-9_-]{2,}$",
        re.IGNORECASE,
    ),
    # Any ``<prefix>_<uuid>`` segment, whatever the prefix. A uuid is opaque no
    # matter what precedes it.
    re.compile(
        r"^[a-z][a-z0-9]*[_-][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        re.IGNORECASE,
    ),
    re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-", re.IGNORECASE),
    re.compile(r"^[0-9a-f]{16,}$", re.IGNORECASE),
)


def humanize_segment(segment: str | None) -> str:
    """A readable name for one segment, spelled as it was originally written."""
    text = str(segment or "")
    text = _ARRAY_INDEX.sub(" ", text)
    text = _SEPARATORS.sub(" ", text)
    text = _ACRONYM_BOUNDARY.sub(r"\1 \2", text)
    text = _CAMEL_BOUNDARY.sub(r"\1 \2", text)
    text = _DIGIT_BOUNDARY.sub(r"\1 \2", text)
    text = _WHITESPACE.sub(" ", text)
    # Not ``str.title()``: that lowercases the rest of each word and would turn
    # ``SSN Number`` into ``Ssn Number``, diverging from the TypeScript side,
    # which only uppercases the first character. The two must agree exactly.
    text = _WORD_START.sub(lambda match: match.group().upper(), text)
    return text.strip()


def humanize_path(path: str | None) -> str:
    """A readable name for a dotted path, humanizing each segment."""
    parts = [humanize_segment(part) for part in str(path or "").split(".")]
    return " ".join(part for part in parts if part).strip()


def looks_like_opaque_id(segment: str | None) -> bool:
    """True when a key is an opaque identifier rather than a readable name."""
    text = str(segment or "")
    return any(pattern.match(text) for pattern in _OPAQUE_ID_PATTERNS)
