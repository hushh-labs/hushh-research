"""RIA nearby routes: coordinate hygiene, verified-RIA gating, and the migration.

An advisor's own position is treated as credential-grade here for the same
reason it is on the advisor directory: a location is not less sensitive than an
API key, and a GET would put it in the access log, browser history, and any
Referer header.
"""

from __future__ import annotations

import inspect
import json
from pathlib import Path

import pytest

from api.routes import ria as ria_routes

_REPO_ROOT = Path(__file__).resolve().parents[1]
_MIGRATION_NAME = "148_nws_nearby_marketplace_actions.sql"
_MIGRATION = _REPO_ROOT / "db" / "migrations" / _MIGRATION_NAME
_ROLLBACK = (
    _REPO_ROOT
    / "db"
    / "migrations"
    / "rollback"
    / "148_nws_nearby_marketplace_actions.rollback.sql"
)


def _routes() -> dict[str, set[str]]:
    """Methods by path, unioned — GET and POST shortlist share one path."""
    paths: dict[str, set[str]] = {}
    for route in ria_routes.router.routes:
        path = getattr(route, "path", "")
        if not path.startswith("/api/ria/nearby"):
            continue
        paths.setdefault(path, set()).update(route.methods or ())
    return paths


# ------------------------------------------------------------ route surface


def test_discover_is_a_post_so_no_position_reaches_the_request_line() -> None:
    paths = _routes()

    assert "POST" in paths["/api/ria/nearby/discover"]
    # A GET variant would defeat the whole point, so its absence is asserted
    # rather than assumed.
    assert "GET" not in paths["/api/ria/nearby/discover"]


def test_no_nearby_get_route_accepts_a_location_as_a_query_parameter() -> None:
    for route in ria_routes.router.routes:
        if not getattr(route, "path", "").startswith("/api/ria/nearby"):
            continue
        if "GET" not in (route.methods or ()):
            continue
        params = inspect.signature(route.endpoint).parameters
        for name in ("lat", "lng", "latitude", "longitude", "postal_code", "postalCode"):
            assert name not in params, f"{route.path} takes {name} on a GET"


def test_the_shortlist_reads_and_writes_are_both_present() -> None:
    paths = _routes()

    assert "POST" in paths["/api/ria/nearby/shortlist"]
    assert "GET" in paths["/api/ria/nearby/shortlist"]


@pytest.mark.parametrize(
    "path",
    ["/api/ria/nearby/discover", "/api/ria/nearby/shortlist"],
)
def test_every_nearby_route_is_behind_the_verified_ria_gate(path: str) -> None:
    """Prospecting data is advisor-only; an authenticated non-RIA must not read it."""
    matched = [route for route in ria_routes.router.routes if getattr(route, "path", "") == path]
    assert matched

    for route in matched:
        defaults = [
            parameter.default for parameter in inspect.signature(route.endpoint).parameters.values()
        ]
        dependencies = [
            getattr(default, "dependency", None)
            for default in defaults
            if default is not inspect.Parameter.empty
        ]
        assert ria_routes._require_ria_verified in dependencies, (
            f"{path} is not gated on a verified RIA"
        )


# ---------------------------------------------------------------- payloads


def test_discover_rejects_a_country_code_that_is_not_alpha_2() -> None:
    with pytest.raises(ValueError):
        ria_routes.RIANearbyDiscoverRequest(postal_code="98033", country_code="USA")


def test_discover_bounds_match_the_upstream_contract() -> None:
    """Out-of-range input is refused here so it cannot spend a shared quota."""
    for kwargs in (
        {"latitude": 91.0},
        {"longitude": 181.0},
        {"top_n": 401},
        {"initial_radius_km": 0},
        {"max_radius_km": 501},
    ):
        with pytest.raises(ValueError):
            ria_routes.RIANearbyDiscoverRequest(**kwargs)


def test_a_shortlist_snapshot_is_bounded() -> None:
    """It is caller-supplied and lands in a JSONB column (CWE-400)."""
    with pytest.raises(ValueError):
        ria_routes.RIANearbyShortlistRequest(
            person_id="p", snapshot={str(index): index for index in range(41)}
        )
    with pytest.raises(ValueError):
        ria_routes.RIANearbyShortlistRequest(person_id="p", snapshot={"blob": "x" * 9000})

    accepted = ria_routes.RIANearbyShortlistRequest(
        person_id="bootstrap_michael_hsing",
        snapshot={"displayName": "Michael R. Hsing", "lane": "BUILDER"},
    )
    assert accepted.action == "shortlist"


# --------------------------------------------------------------- migration


def test_the_migration_is_registered_and_reversible() -> None:
    assert _MIGRATION.exists()
    assert _ROLLBACK.exists()

    manifest = json.loads((_REPO_ROOT / "db" / "release_migration_manifest.json").read_text())
    assert _MIGRATION_NAME in manifest["ordered_migrations"]
    assert len(manifest["ordered_migrations"]) == len(set(manifest["ordered_migrations"]))
    # 058 created the table; the extension belongs in the same release group.
    assert _MIGRATION_NAME in manifest["groups"]["iam"]


def test_the_migration_widens_both_constraints_that_block_an_nws_row() -> None:
    """Either constraint alone still rejects the row, so both must move."""
    sql = _MIGRATION.read_text()

    assert "'nws_nearby'" in sql
    assert "marketplace_investor_actions_source_type_check" in sql
    assert "marketplace_investor_actions_target_check" in sql
    # An NWS person has no row in either local table to point at.
    assert "public_profile_id IS NULL AND target_user_id IS NULL" in sql


def test_the_rollback_clears_rows_the_narrower_constraint_would_reject() -> None:
    """Re-adding the original CHECK with nws_nearby rows present would fail."""
    sql = _ROLLBACK.read_text()

    assert "DELETE FROM marketplace_investor_actions WHERE source_type = 'nws_nearby'" in sql
    assert sql.index("DELETE FROM") < sql.index("ADD CONSTRAINT")


def test_account_deletion_already_covers_the_shortlist() -> None:
    """The reason this extends 058's table instead of adding one of its own.

    A new table would have needed the same three deletion sites and, missing
    them, would have left an advisor's shortlist behind after a deletion request.
    """
    account_service = (_REPO_ROOT / "hushh_mcp" / "services" / "account_service.py").read_text()

    assert "marketplace_investor_actions" in account_service
