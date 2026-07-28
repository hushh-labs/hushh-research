"""The published PCHP scope catalogue, loaded once, as the server sees it.

``/pchp/scopes.json`` is served publicly from the frontend and calls itself the
canonical scope registry for the Preference Subscription Fabric. Agents fetch it
to learn what a human can offer. It is therefore the *authored source*, and this
module vendors a byte-identical copy so the server honours exactly what the world
was told.

Why vendored rather than fetched at runtime:
- The resolver is on the fail-closed read path. A network dependency there fails
  either open (unacceptable) or into an outage on a CDN blip.
- A vendored file is testable offline and pinned per deploy.

The cost is that the two copies can drift, so ``EXPECTED_SHA256`` pins the exact
bytes. Changing the registry means updating the digest in both repositories in
the same change - deliberate friction on a published standard.
"""

from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path
from typing import Any

_CATALOGUE_PATH = Path(__file__).resolve().parent.parent / "data" / "pchp_scopes.json"

# Pin the exact bytes of the vendored catalogue. If this fails, the copy has been
# hand-edited or has drifted from the published file - fix the copy, do not
# update the constant to match a mystery.
EXPECTED_SHA256 = "dbab75e651323ed5b2ea51a325a4f75ab73021cdbba5935aad07394272e36a60"

# Roots the fabric will resolve. `profile` is the coarse qualifying bundle
# disclosed free on a first handshake; `connect` predates the catalogue and is
# kept because the shipped connect-the-dots flow writes it.
KNOWN_ROOTS = frozenset({"profile", "privacy", "prefs", "wants", "favorites", "connect"})


@lru_cache(maxsize=1)
def _load() -> dict[str, Any]:
    raw = _CATALOGUE_PATH.read_bytes()
    return {"digest": hashlib.sha256(raw).hexdigest(), **json.loads(raw)}


def digest() -> str:
    """SHA-256 of the vendored catalogue bytes."""
    return str(_load()["digest"])


def version() -> str:
    return str(_load().get("version", "unknown"))


@lru_cache(maxsize=1)
def _by_scope() -> dict[str, dict[str, Any]]:
    return {s["scope"]: s for s in _load().get("scopes", []) if s.get("scope")}


def scope_meta(scope: str) -> dict[str, Any] | None:
    """The published entry for a scope - type, label, sensitive - or None."""
    return _by_scope().get(scope)


def is_sensitive(scope: str) -> bool:
    """Whether the catalogue marks this scope sensitive.

    The registry states sensitive scopes must be requested individually and
    never bundled. Unknown scopes are treated as sensitive: fail-closed, because
    a scope we cannot classify is not one to relax the rule for.
    """
    meta = _by_scope().get(scope)
    return True if meta is None else bool(meta.get("sensitive"))


def all_scopes() -> list[str]:
    return list(_by_scope().keys())
