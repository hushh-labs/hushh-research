"""Server-side scope -> PWM-field resolver for the subscription fabric.

A subscription grant is expressed in PCHP scope labels (``wants.money.advisor``,
``privacy.marketing-email``, ...). The subscriber read API must turn those labels
into concrete values from the owner's Personal World Model document. This module
is the single server-side authority for that mapping.

Design:
- The public scope catalogue lives in the frontend (``/pchp/scopes.json``); this
  is the *field binding* -- which PWM document paths a granted scope authorizes.
- It is **fail-closed**: a scope with no registered field binding resolves to no
  fields and is reported as unmapped, so an un-modelled scope can never leak an
  un-intended field.
- Bindings are seeded with the fields the PWM actually holds today (the shipped
  connect-the-dots flow) and grow as the PWM schema grows -- add the binding here
  when a new PWM section becomes subscribable.
"""

from __future__ import annotations

from typing import Any

# scope label -> ordered list of dot-paths into the PWM document.
# Seeded from the live PWM shape: the connect-the-dots section stores
# `connect = { want, zip, updatedAt }` (see hushh-search-console pwm-local /
# /api/pwm). A subscriber granted the "advisor want" receives the want + ZIP so
# it can make the local match -- and nothing else.
_SCOPE_FIELD_MAP: dict[str, list[str]] = {
    "wants.money.advisor": ["connect.want", "connect.zip"],
    "wants.financial-services": ["connect.want", "connect.zip"],
}


def resolve_fields(scopes: list[str]) -> tuple[list[str], list[str]]:
    """Return ``(fields, unmapped_scopes)`` for the requested scopes.

    ``fields`` is the de-duplicated, order-stable union of PWM dot-paths the
    scopes authorize. ``unmapped_scopes`` lists any scope with no binding
    (fail-closed: it contributes nothing).
    """
    fields: list[str] = []
    unmapped: list[str] = []
    for scope in scopes:
        bound = _SCOPE_FIELD_MAP.get(scope)
        if not bound:
            unmapped.append(scope)
            continue
        for path in bound:
            if path not in fields:
                fields.append(path)
    return fields, unmapped


def _get_path(doc: dict[str, Any], path: str) -> Any:
    """Traverse a dot-path in a nested dict; return None if any hop is absent."""
    current: Any = doc
    for key in path.split("."):
        if not isinstance(current, dict) or key not in current:
            return None
        current = current[key]
    return current


def project_fields(doc: dict[str, Any], fields: list[str]) -> dict[str, Any]:
    """Project the requested dot-paths out of ``doc``.

    Returns ``{dot_path: value}`` for every path that is present; paths absent
    from the current document are simply omitted (the subscriber receives only
    what exists now, at its current value).
    """
    out: dict[str, Any] = {}
    for path in fields:
        value = _get_path(doc, path)
        if value is not None:
            out[path] = value
    return out
