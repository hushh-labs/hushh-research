"""Guards against the drift that made 39 published scopes silently useless.

/pchp/scopes.json is served publicly and calls itself the canonical scope
registry. The server used to restate it in a hand-edited dict of 8 entries, so
the other 39 resolved to zero fields with no error - a subscriber could hold a
grant for favorites.brands and receive nothing, forever, and nobody would know.

These tests exist so that cannot happen again.
"""

from __future__ import annotations

import hashlib

from hushh_mcp.services import fabric_catalogue as cat
from hushh_mcp.services.fabric_scope_registry import project_fields, resolve_fields


def test_vendored_catalogue_matches_its_pinned_digest():
    # If this fails the vendored copy has been hand-edited or has drifted from
    # the published file. Fix the copy; do not update the constant to match.
    raw = cat._CATALOGUE_PATH.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == cat.EXPECTED_SHA256


def test_every_published_scope_resolves_to_at_least_one_field():
    """The direct inverse of the bug: nothing published may resolve to nothing."""
    scopes = cat.all_scopes()
    assert len(scopes) >= 58, "catalogue looks truncated"
    fields, unmapped = resolve_fields(scopes)
    assert unmapped == []
    assert len(fields) >= len(scopes) - 2  # the two legacy connect.* aliases collapse


def test_the_free_first_handshake_bundle_resolves():
    """The handshake promises these three by name. If they stop resolving, the
    first handshake would disclose a field nobody can grant."""
    from hushh_mcp.services.fabric_handshake_economics import FIRST_HANDSHAKE_FREE_SCOPES

    fields, unmapped = resolve_fields(list(FIRST_HANDSHAKE_FREE_SCOPES))
    assert unmapped == []
    assert sorted(fields) == sorted(FIRST_HANDSHAKE_FREE_SCOPES)


def test_the_free_bundle_is_not_marked_sensitive():
    """It is disclosed as a bundle, and `sensitive` means `never bundled`.

    The two rules would contradict. Coarseness is what makes bundling safe here,
    not a sensitivity flag.
    """
    from hushh_mcp.services.fabric_handshake_economics import FIRST_HANDSHAKE_FREE_SCOPES

    for scope in FIRST_HANDSHAKE_FREE_SCOPES:
        assert cat.is_sensitive(scope) is False, scope


def test_unknown_scope_resolves_to_nothing_and_is_reported():
    fields, unmapped = resolve_fields(["not.a.real.scope"])
    assert fields == []
    assert unmapped == ["not.a.real.scope"]


def test_scope_outside_a_known_root_is_refused_even_if_published():
    # Defence in depth: a catalogue entry under an unexpected root must not
    # become a readable path just because someone published it.
    fields, unmapped = resolve_fields(["billing.card.number"])
    assert fields == []
    assert unmapped == ["billing.card.number"]


def test_legacy_connect_bindings_still_work():
    fields, unmapped = resolve_fields(["wants.money.advisor"])
    assert unmapped == []
    assert fields == ["connect.want", "connect.zip"]


def test_unknown_scopes_are_treated_as_sensitive():
    """Fail-closed: a scope we cannot classify does not get the relaxed rule."""
    assert cat.is_sensitive("not.a.real.scope") is True


def test_health_and_legal_wants_are_sensitive():
    for scope in cat.all_scopes():
        if scope.startswith(("wants.health.", "wants.legal.")):
            assert cat.is_sensitive(scope), scope


def test_explicit_null_is_returned_but_absent_is_omitted():
    """"I cleared this" is information; "never set" is not."""
    assert project_fields({"privacy": {"ads": None}}, ["privacy.ads"]) == {"privacy.ads": None}
    assert project_fields({}, ["privacy.ads"]) == {}
    assert project_fields({"privacy": {"ads": False}}, ["privacy.ads"]) == {"privacy.ads": False}


def test_favorites_family_resolves_so_the_archetypes_are_not_vapour():
    # advertising / targeting / shopping / personalization / publishing all
    # depend on these. Before this change every one of them resolved to nothing.
    #
    # This asserted `== 6` and broke when the registry grew to v0.5.0, which was
    # the assertion's fault rather than the registry's: the property that matters
    # is that the six the archetypes name still resolve, not that nobody ever
    # publishes a seventh. Pinned by name, with a floor so the family cannot
    # shrink back.
    ARCHETYPE_REQUIRED = [
        "favorites.brands",
        "favorites.artists",
        "favorites.teams",
        "favorites.creators",
        "favorites.places",
        "favorites.things",
    ]
    favorites = [s for s in cat.all_scopes() if s.startswith("favorites.")]
    assert len(favorites) >= len(ARCHETYPE_REQUIRED)
    for scope in ARCHETYPE_REQUIRED:
        assert scope in favorites, scope

    fields, unmapped = resolve_fields(favorites)
    assert unmapped == []
    assert sorted(fields) == sorted(favorites)
