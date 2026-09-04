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

from hushh_mcp.services.fabric_catalogue import KNOWN_ROOTS, scope_meta

# A scope binds to the PWM dot-path of the SAME NAME. That is already true for
# every privacy.* scope and for the whole prefs/wants/favorites taxonomy, so the
# convention removes the hand-edited map that caused the drift: the server used
# to implement 8 of the 47 published scopes, and the other 39 resolved to zero
# fields, silently.
#
# Only the two legacy bindings that predate the convention need stating. They
# map onto the connect-the-dots section the PWM has shipped since day one.
_LEGACY_BINDINGS: dict[str, list[str]] = {
    "wants.money.advisor": ["connect.want", "connect.zip"],
    "wants.financial-services": ["connect.want", "connect.zip"],
}


def _binding(scope: str) -> list[str] | None:
    """The PWM dot-paths a granted scope authorizes, or None if unbindable.

    Fail-closed in two ways: a scope absent from the published catalogue binds to
    nothing, and a scope whose root we do not resolve binds to nothing. An
    un-modelled scope can therefore never leak an unintended field.
    """
    legacy = _LEGACY_BINDINGS.get(scope)
    if legacy:
        return legacy
    if scope_meta(scope) is None:
        return None
    root = scope.split(".", 1)[0]
    if root not in KNOWN_ROOTS:
        return None
    return [scope]


def resolve_fields(scopes: list[str]) -> tuple[list[str], list[str]]:
    """Return ``(fields, unmapped_scopes)`` for the requested scopes.

    ``fields`` is the de-duplicated, order-stable union of PWM dot-paths the
    scopes authorize. ``unmapped_scopes`` lists any scope with no binding
    (fail-closed: it contributes nothing).
    """
    fields: list[str] = []
    unmapped: list[str] = []
    for scope in scopes:
        bound = _binding(scope)
        if not bound:
            unmapped.append(scope)
            continue
        for path in bound:
            if path not in fields:
                fields.append(path)
    return fields, unmapped


# Distinct from None, which is a legitimate stored value meaning "explicitly
# cleared". Conflating the two would silently drop a preference the person set
# on purpose.
_MISSING = object()


def _get_path(doc: dict[str, Any], path: str) -> Any:
    """Traverse a dot-path in a nested dict; return _MISSING if any hop is absent."""
    current: Any = doc
    for key in path.split("."):
        if not isinstance(current, dict) or key not in current:
            return _MISSING
        current = current[key]
    return current


def project_fields(doc: dict[str, Any], fields: list[str]) -> dict[str, Any]:
    """Project the requested dot-paths out of ``doc``.

    Returns ``{dot_path: value}`` for every path that is present; paths absent
    from the current document are simply omitted (the subscriber receives only
    what exists now, at its current value). A path present with a null value IS
    returned - "I cleared this" is information, and different from "never set".
    """
    out: dict[str, Any] = {}
    for path in fields:
        value = _get_path(doc, path)
        if value is not _MISSING:
            out[path] = value
    return out
