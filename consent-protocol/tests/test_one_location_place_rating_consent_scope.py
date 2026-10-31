"""Every Location capability scope must actually resolve.

`resolve_scope_to_enum` raises `ValueError` for any `cap.*` string absent from
its map. The three `cap.location.nearby.*` scopes were declared in
`ConsentScope` and listed in `capability_scopes()` since nearby check-in
shipped, but never added there -- so they read as supported everywhere they
appeared and blew up the moment anything resolved one. Declared-but-
unresolvable is worse than absent, and nothing failed until you tried it.
"""

from __future__ import annotations

import pytest

from hushh_mcp.consent.scope_helpers import (
    get_scope_display_metadata,
    resolve_scope_to_enum,
)
from hushh_mcp.constants import ConsentScope
from hushh_mcp.operons.location.policy import LOCATION_CAPABILITY_SCOPES

LOCATION_SCOPES = (
    "cap.location.nearby.publish",
    "cap.location.nearby.discover",
    "cap.location.nearby.revoke",
    "cap.location.place_rating.publish",
    "cap.location.place_rating.discover",
    "cap.location.place_rating.revoke",
)


@pytest.mark.parametrize("scope", LOCATION_SCOPES)
def test_every_location_capability_scope_resolves(scope: str):
    assert resolve_scope_to_enum(scope).value == scope


@pytest.mark.parametrize("scope", LOCATION_SCOPES)
def test_every_location_capability_scope_has_a_sentence_not_a_title_cased_handle(
    scope: str,
):
    meta = get_scope_display_metadata(scope)

    # The fallback renders "Cap Location Nearby Publish" and a description that
    # is just the scope string. Either one means the consent surface is showing
    # a person a handle where an explanation belongs.
    assert meta["label"] != scope.replace(".", " ").replace("_", " ").title()
    assert scope not in meta["description"]
    assert len(meta["description"]) > 20


@pytest.mark.parametrize("scope", LOCATION_SCOPES)
def test_every_location_capability_scope_is_declared_and_listed(scope: str):
    assert scope in {member.value for member in ConsentScope.capability_scopes()}
    assert scope in LOCATION_CAPABILITY_SCOPES


def test_rating_scopes_are_never_externally_requestable():
    # A third-party app must not be able to ask for the authority to publish a
    # durable record that somebody was at a place.
    external = {member.value for member in ConsentScope.external_scopes()}

    for scope in LOCATION_SCOPES:
        assert scope not in external
