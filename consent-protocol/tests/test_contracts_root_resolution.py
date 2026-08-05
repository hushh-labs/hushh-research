"""The generated contracts tree must resolve in a checkout AND inside the image.

THE BUG THIS GUARDS. Three loaders anchored on
``Path(__file__).resolve().parents[3] / "contracts"``. In a repo checkout that is
the repo root and it works. Inside the image it is ``/`` -- because both images
build with context ``consent-protocol/`` and ``COPY . .`` into ``/app`` -- and the
repo-root tree was never copied in at all.

All three degrade SILENTLY: ``load_action_gateway()`` returns ``{"actions": []}``,
``load_route_orchestration_index()`` returns ``{}``, and One's persona catalogue
returns ``""``. Nothing raised and nothing logged, so the deployed hub ran with an
empty action gateway, an empty delegate-admission index, and no persona grounding --
and ``agent_tree.py`` builds that grounding at MODULE level, so it was baked in for
the life of the process.

That is the failure mode this repo argues against everywhere else: a surface that
reports success while carrying nothing. A test that only asserted "the loader
returns a dict" would have passed throughout.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from hushh_mcp import contracts_root as contracts_root_module
from hushh_mcp.contracts_root import CONTRACTS_DIR_ENV, contracts_path, contracts_root

REPO_ROOT = Path(__file__).resolve().parents[2]

# Every generated contract a runtime loader reads, and the loader that reads it.
REQUIRED_CONTRACTS = [
    ("agents/product-agent-registry.v2.json", "one_persona"),
    ("kai/kai-action-gateway.vnext.json", "action_gateway"),
    ("kai/one-route-orchestration-index.v1.json", "route_orchestration_index"),
]


@pytest.fixture(autouse=True)
def _clear_cache():
    contracts_root.cache_clear()
    yield
    contracts_root.cache_clear()


def test_the_contracts_tree_resolves_at_all():
    root = contracts_root()
    assert root is not None, (
        "contracts_root() found no tree. Every consumer degrades to empty data "
        "SILENTLY, so this is the only place the absence is visible."
    )
    assert root.is_dir()


@pytest.mark.parametrize("relative,consumer", REQUIRED_CONTRACTS)
def test_every_runtime_contract_resolves_and_parses(relative: str, consumer: str):
    resolved = contracts_path(*relative.split("/"))
    assert resolved is not None and resolved.exists(), (
        f"{consumer} cannot find {relative}; it will run with empty contract data"
    )
    payload = json.loads(resolved.read_text(encoding="utf-8"))
    assert payload, f"{relative} parsed to an empty document"


def test_loaders_return_real_content_not_an_empty_shape():
    """The assertion the original tests were missing.

    Each loader has a legitimate empty-on-missing fallback, so type-checking the
    return value passes even when nothing was found. Assert CONTENT.
    """
    from hushh_mcp.services.action_gateway import load_action_gateway
    from hushh_mcp.services.route_orchestration_index import load_route_orchestration_index

    gateway = load_action_gateway()
    assert gateway.get("source") == "file", (
        f"action gateway resolved to {gateway.get('source')!r} -- it is running empty"
    )
    assert gateway.get("actions"), "action gateway loaded zero actions"

    assert load_route_orchestration_index(), "route orchestration index loaded zero routes"


def test_an_env_override_wins():
    """A deployment that mounts the tree elsewhere must be able to say so."""
    import os

    os.environ[CONTRACTS_DIR_ENV] = str(REPO_ROOT / "contracts")
    try:
        contracts_root.cache_clear()
        assert contracts_root() == REPO_ROOT / "contracts"
    finally:
        os.environ.pop(CONTRACTS_DIR_ENV, None)
        contracts_root.cache_clear()


def test_the_image_layout_is_a_candidate_not_just_the_checkout_layout():
    """The regression itself: only the checkout layout was ever considered.

    Inside the image `/app` is the package root, so the tree sits at
    `parents[2]/contracts`. If that candidate is ever dropped, the image silently
    goes back to empty contracts while every local test stays green -- which is
    exactly how this shipped.
    """
    candidates = [str(path) for path in contracts_root_module._candidates()]
    package_root = Path(contracts_root_module.__file__).resolve().parents[1]

    assert str(package_root / "contracts") in candidates, (
        "the image layout (package-root/contracts) is not searched; a build that "
        "stages contracts into the context would still resolve nothing"
    )


def test_the_build_stages_contracts_into_the_docker_context():
    """The code fix alone is not enough -- the file has to be IN the image.

    The build context is `consent-protocol/`, so repo-root `contracts/` must be
    copied in before `docker buildx build` or `COPY . .` cannot see it. Both image
    steps need it: a pod runs the same agent code.
    """
    cloudbuild = (REPO_ROOT / "deploy" / "backend.cloudbuild.yaml").read_text(encoding="utf-8")
    staged = cloudbuild.count("cp -R contracts consent-protocol/contracts")
    assert staged >= 2, (
        f"found {staged} contracts staging step(s); both the hub and pod image "
        f"builds need one or that image ships with no contracts tree"
    )
