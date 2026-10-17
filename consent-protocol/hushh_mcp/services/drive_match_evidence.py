"""How a Drive request match was found, and whether it may share itself.

Autoshare (#8177, search v2) sends a file only when the target's own title
names what the requester typed: the typed words, their plurals and reviewed
exact synonyms. Every other match is discovery. It is a "possible match"
(product decision D3): the owner sees it in an owner-only list on the
request's Feed card and it is shared only after the owner taps Send.

Contract for search gears (walk, content reading, Hindi/codes):

* A gear that keeps a result WITHOUT title evidence adds
  ``possible_match_fields(kind)`` to the result metadata before the result is
  sealed. ``kind`` is one of ``POSSIBLE_KINDS``.
* A result with title evidence carries no tag, or ``evidenceKind: "title"``.
  A walk or content hit whose own title also names the request is a title
  match: tag the evidence, not the gear that found it.
* ``_filename_candidate`` and ``_note_candidate`` in
  ``drive_owner_search_service`` stay the autoshare title gate. Do not widen
  them to keep discovery results; tag those results instead.

Claims never trust a tag alone. ``awaiting_owner`` also rechecks the title
gate on the frozen target title, so an untagged result without title evidence
still waits for the owner, and any tag value other than ``title`` (including a
malformed one) fails closed as a possible match.

The tag and the owner's Send marker live only inside the AES-GCM result
envelope; nothing here is stored or logged in plaintext.
"""

from __future__ import annotations

from collections.abc import Mapping

EVIDENCE_KIND_FIELD = "evidenceKind"

TITLE = "title"
# Words found in the file's text (Drive fullText or our own content index).
CONTENT = "content"
# The title matched only a spelling fix toward the owner's own vocabulary.
CORRECTED = "corrected"
# The title matched only a loose synonym or discovery clue.
SYNONYM = "synonym"
# Found by walking a folder shared with the owner, without title evidence.
WALK = "walk"

POSSIBLE_KINDS = frozenset({CONTENT, CORRECTED, SYNONYM, WALK})

# The owner's explicit Send. Its presence is the only authority that lets a
# possible match into a batch; payment and every live recheck still apply.
OWNER_SENT_FIELD = "possibleMatchSent"
OWNER_SENT_VERSION = 1


def possible_match_fields(kind: str) -> dict[str, str]:
    """The metadata a search gear adds to a result kept as a possible match."""
    if kind not in POSSIBLE_KINDS:
        raise ValueError("unknown possible-match evidence kind")
    return {EVIDENCE_KIND_FIELD: kind}


def title_evidence_fields() -> dict[str, str]:
    """Optional explicit tag for a result whose own title names the request."""
    return {EVIDENCE_KIND_FIELD: TITLE}


def tagged_possible(metadata: Mapping) -> bool:
    """A gear marked this result as discovery. Unknown values fail closed."""
    return metadata.get(EVIDENCE_KIND_FIELD, TITLE) != TITLE


def possible_kind(metadata: Mapping) -> str:
    """The kind to show the owner; an unknown or missing tag reads as content."""
    value = metadata.get(EVIDENCE_KIND_FIELD)
    return value if isinstance(value, str) and value in POSSIBLE_KINDS else CONTENT


def owner_sent(metadata: Mapping) -> bool:
    marker = metadata.get(OWNER_SENT_FIELD)
    return isinstance(marker, Mapping) and marker.get("version") == OWNER_SENT_VERSION


def owner_sent_fields() -> dict[str, dict[str, int]]:
    return {OWNER_SENT_FIELD: {"version": OWNER_SENT_VERSION}}


def automatic_claims(checkpoint: object) -> bool:
    """A request search whose results are claimed without the owner's file review."""
    return bool(
        isinstance(checkpoint, Mapping)
        and checkpoint.get("authority_mode") == "trusted_auto"
        and checkpoint.get("agent_package_required") is not True
        and checkpoint.get("request_owner_review_required") is False
    )


def title_gate(checkpoint: Mapping, metadata: Mapping) -> bool:
    """Recheck the autoshare title rule on the frozen target title.

    The same predicates the search applied before committing the result: the
    v2 brain's typed-word evidence (or the legacy subject terms), the exact
    title, and the meeting-notes title rule. A shortcut never lends its alias:
    ``name`` is the target's own title.
    """
    from hushh_mcp.services.drive_owner_search_service import _note_candidate

    name = metadata.get("name")
    if not isinstance(name, str) or not name:
        return False
    alias = metadata.get("shortcutName")
    match = {"name": name, "shortcut_name": alias if isinstance(alias, str) else ""}
    return _note_candidate(dict(checkpoint), match, folder_scoped=False)


def lacks_title_evidence(checkpoint: Mapping, metadata: Mapping) -> bool:
    """Discovery only: tagged by a gear, or failing the title gate at claim time."""
    return tagged_possible(metadata) or not title_gate(checkpoint, metadata)


def awaiting_owner(checkpoint: object, metadata: Mapping) -> bool:
    """A result of an automatic search that no automatic step may claim.

    True for every result without title evidence until the owner sends it,
    whatever its shareability. Owner-reviewed and package searches are never
    classified here: their owner already decides each exact file.
    """
    return bool(
        automatic_claims(checkpoint)
        and isinstance(metadata, Mapping)
        and not owner_sent(metadata)
        and lacks_title_evidence(checkpoint, metadata)
    )


def is_possible_match(checkpoint: object, metadata: Mapping) -> bool:
    """Listed for the owner: shareable, no title evidence, sent or not yet."""
    return bool(
        automatic_claims(checkpoint)
        and isinstance(metadata, Mapping)
        and metadata.get("shareable") is True
        and lacks_title_evidence(checkpoint, metadata)
    )
