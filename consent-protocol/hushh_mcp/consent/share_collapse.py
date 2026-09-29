"""One listed item per thing shared: collapse covered grants, order them stably.

Measured on UAT through localhost acceptance run 4 (2026-09-29, S3): one
request asked for ``attr.legal_entity.*`` AND ``attr.legal_entity.entity.*``,
another for ``attr.professional.*`` AND six of its own branches. Each item is
its own grant, so "Legal entity information" and "Entity" (the same 15 values),
"Work preferences" twice and "Professional profile" twice were listed side by
side, and Profile and the person page listed them in different orders.

A grant whose scope is covered by another live, openable grant from the same
person adds nothing the broader one does not already show, so it is not listed
separately. Nothing is revoked or hidden from the ledger: this is presentation
of what is currently shared, and the broader grant's export holds the same
values. If the broader grant ends, the narrower one is listed again on the next
read, because it is still live.

Pure: no database, no network, no model.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any, TypeVar

from hushh_mcp.consent.scope_sensitivity import covers

T = TypeVar("T")


def _scope_parts(scope: str) -> list[str]:
    return [part for part in str(scope or "").lower().split(".") if part and part != "*"]


def collapse_covered_shares(
    shares: Iterable[T],
    *,
    scope_of: Callable[[T], str],
    person_of: Callable[[T], str],
    openable_of: Callable[[T], bool] = lambda _share: True,
) -> list[T]:
    """Drop each share whose scope a broader (or identical) openable share covers.

    Among shares with the same scope for the same person, the first openable
    one is kept. A share is only ever absorbed by an openable one, so an item
    the device can open is never replaced by one it cannot. Input order is
    preserved for what is kept.
    """
    items = list(shares)
    kept: list[T] = []
    for index, share in enumerate(items):
        scope = scope_of(share)
        person = person_of(share)
        parts = _scope_parts(scope)
        absorbed = False
        for other_index, other in enumerate(items):
            if other_index == index or person_of(other) != person or not openable_of(other):
                continue
            other_scope = scope_of(other)
            other_parts = _scope_parts(other_scope)
            if not other_parts or not covers(other_scope, scope):
                continue
            broader = len(other_parts) < len(parts)
            # Same scope twice: the earlier openable one stays.
            same_and_earlier = other_parts == parts and (
                other_index < index or not openable_of(share)
            )
            if broader or same_and_earlier:
                absorbed = True
                break
        if not absorbed:
            kept.append(share)
    return kept


def share_order_key(label: Any, shared_at: Any, tiebreak: Any = "") -> tuple[str, str, str]:
    """Label (case-insensitive), then when it was shared, then a stable id.

    Profile, the person page and the chat card sort by this one key, so the
    same items read in the same order on every surface.
    """
    return (
        " ".join(str(label or "").split()).casefold(),
        str(shared_at or ""),
        str(tiebreak or ""),
    )


__all__ = ["collapse_covered_shares", "share_order_key"]
