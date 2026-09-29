"""Every generated contract the backend reads must ship inside its Docker image.

Regression guard for a silent packaging bug: ``deploy/backend.cloudbuild.yaml``
builds with Docker context ``consent-protocol``, so ``/app`` in the image is
``consent-protocol/`` and the repo root is not present at all. The loaders
resolved ``parents[3] / "contracts"`` — repo root in a checkout, ``/`` in the
image — so every deployed backend served an empty action gateway while localhost
worked. One answered ``status=unknown_action`` for every id and nothing else
showed a symptom.

The load-bearing assertion is that the resolved path is *under the build
context*. Merely asserting the gateway loads would pass in CI through the
repo-root fallback and let the bug straight back in.

MERGED 2026-08-12. The pod branch found the same bug independently and fixed it in a
second resolver (``hushh_mcp/contracts_root.py``) with a second guard. Both were
correct; two of them is the ambiguity, so the resolvers were merged into
``generated_contracts`` and the two assertions that had no equivalent here came with
them: the ``HUSHH_CONTRACTS_DIR`` override (BYOC pods may mount the tree elsewhere),
and the cloudbuild staging step (the committed mirror alone does not prove the image
got a FRESH copy).

This file was itself registered in ``scripts/test-ci.manifest.txt`` in that merge. It
was in neither branch's manifest before, so an unregistered test never ran -- the same
never-executed shape as the bug it guards.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from hushh_mcp.one_adk.one_persona import _load_registry_agents
from hushh_mcp.services.action_gateway import load_action_gateway
from hushh_mcp.services.generated_contracts import (
    BACKEND_ROOT,
    CONTRACTS_DIR_ENV,
    REPO_ROOT,
    generated_contract_path,
)
from hushh_mcp.services.route_orchestration_index import load_route_orchestration_index

# Read at runtime by action_gateway, route_orchestration_index and one_persona.
RUNTIME_CONTRACTS = (
    ("kai", "kai-action-gateway.vnext.json"),
    ("kai", "one-route-orchestration-index.v1.json"),
    ("agents", "product-agent-registry.v2.json"),
    # internal_path_keys.py hit this exact bug: get_available_scope_entries
    # crashed with FileNotFoundError for any person with a non-empty
    # pkm_manifests.externalizable_paths, 500ing /api/one/people/{person_ref}
    # in UAT while every local checkout worked.
    ("pkm", "internal-path-keys.v1.json"),
    # Field-level sensitivity and human field names (2026-09-29): read by the
    # continuation strip and the Shared with you card on every request.
    ("consent", "field-sensitivity.v1.json"),
    ("consent", "field-labels.v1.json"),
)


def test_backend_root_is_the_docker_build_context() -> None:
    """BACKEND_ROOT must be the directory the image is built from."""
    assert (BACKEND_ROOT / "Dockerfile").is_file()
    assert BACKEND_ROOT.name == "consent-protocol"
    assert REPO_ROOT == BACKEND_ROOT.parent


@pytest.mark.parametrize("parts", RUNTIME_CONTRACTS)
def test_runtime_contract_ships_inside_the_build_context(parts: tuple[str, ...]) -> None:
    in_context = BACKEND_ROOT / "contracts" / parts[0] / parts[1]
    assert in_context.is_file(), (
        f"{in_context} is missing, so the image will not contain it. "
        "Regenerate the contract chain from hushh-webapp."
    )
    # The resolver must actually pick the in-context copy, not silently fall
    # back to the repo root that does not exist in the image.
    assert generated_contract_path(*parts) == in_context


@pytest.mark.parametrize("parts", RUNTIME_CONTRACTS)
def test_in_context_copy_matches_the_repo_root_original(parts: tuple[str, ...]) -> None:
    def content(path) -> str:
        # Compare content, not line endings. On a Windows checkout git may hand
        # back CRLF for one copy and LF for the other depending on how each
        # arrived, and a byte comparison would then fail over something that
        # does not exist by the time the file is parsed as JSON.
        return path.read_text(encoding="utf-8").replace("\r\n", "\n")

    in_context = content(BACKEND_ROOT / "contracts" / parts[0] / parts[1])
    canonical = content(REPO_ROOT / "contracts" / parts[0] / parts[1])
    assert in_context == canonical, (
        "The backend copy has drifted from the canonical contract. "
        "Regenerate rather than hand-editing either copy."
    )


def test_action_gateway_loads_actions_from_inside_the_build_context() -> None:
    gateway = load_action_gateway()
    assert gateway["source"] == "file"
    assert gateway["actions"], "an empty gateway makes every action id unknown_action"
    assert BACKEND_ROOT in type(BACKEND_ROOT)(gateway["path"]).parents


def test_route_orchestration_index_and_registry_load() -> None:
    assert load_route_orchestration_index()
    assert _load_registry_agents()


def test_an_env_override_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    """A deployment that mounts the tree elsewhere must be able to say so.

    Carried over from the pod branch's resolver. A pod running in a user's own GCP
    project does not necessarily have the tree at either default location, and
    needing a code change to say where it is would make BYOC un-deployable.
    """
    monkeypatch.setenv(CONTRACTS_DIR_ENV, str(REPO_ROOT / "contracts"))
    assert generated_contract_path("agents", "product-agent-registry.v2.json") == (
        REPO_ROOT / "contracts" / "agents" / "product-agent-registry.v2.json"
    )


def test_a_blank_env_override_is_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    """An empty or whitespace value must not shadow the real defaults.

    Deploy lanes render unset substitutions as empty strings, so `HUSHH_CONTRACTS_DIR=""`
    is the *normal* case in every environment that does not set it -- and honouring it
    would resolve every contract under `/`, reproducing the original bug exactly.
    """
    monkeypatch.setenv(CONTRACTS_DIR_ENV, "   ")
    assert generated_contract_path("agents", "product-agent-registry.v2.json") == (
        BACKEND_ROOT / "contracts" / "agents" / "product-agent-registry.v2.json"
    )


def test_the_build_stages_contracts_into_the_docker_context() -> None:
    """The committed mirror is not on its own proof the IMAGE has a fresh copy.

    Carried over from the pod branch. The mirror could be stale, and
    `test_in_context_copy_matches_the_repo_root_original` only catches that if it
    runs before the build. `deploy/backend.cloudbuild.yaml` re-stages the tree from
    the repo-root original for BOTH images -- a pod runs the same agent code and
    reads the same generated contracts -- so staleness cannot reach either one.
    """
    cloudbuild = (REPO_ROOT / "deploy" / "backend.cloudbuild.yaml").read_text(encoding="utf-8")
    staged = cloudbuild.count("cp -R contracts consent-protocol/contracts")
    assert staged >= 2, (
        f"found {staged} contracts staging step(s); both the hub and pod image "
        "builds need one or that image ships whatever the mirror happened to hold"
    )


def test_the_mirror_is_tracked_and_not_gitignored() -> None:
    """The mirror only ships if git actually carries it.

    The two branches disagreed here: one committed the mirror, the other treated it
    as a pure build artifact and added `consent-protocol/contracts/` to `.gitignore`.
    Both merged cleanly and the combination is the trap -- already-tracked files keep
    working, so nothing fails today, while any NEWLY generated contract is silently
    ignored and never committed. That is a stale mirror with a green diff.
    """
    gitignore = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8")
    offending = [
        line
        for line in gitignore.splitlines()
        if line.strip()
        and not line.lstrip().startswith("#")
        # A bare `contracts/` pattern matches at any depth, so it catches the mirror
        # too; both spellings have to be absent.
        and line.strip().rstrip("/") in {"consent-protocol/contracts", "contracts"}
    ]
    assert not offending, (
        f".gitignore ignores the committed mirror ({offending}). Tracked files survive, "
        "so this fails nothing today -- and the next generated contract is dropped."
    )
    for parts in RUNTIME_CONTRACTS:
        assert (BACKEND_ROOT / "contracts" / Path(*parts)).is_file()


def test_gateway_copy_is_valid_json_with_the_expected_shape() -> None:
    payload = json.loads(
        (BACKEND_ROOT / "contracts" / "kai" / "kai-action-gateway.vnext.json").read_text(
            encoding="utf-8"
        )
    )
    assert payload["schema_version"] == "kai.action_gateway.vnext"
    assert isinstance(payload["actions"], list) and payload["actions"]


SHARED_CONFIGS = (("pkm", "kyc-identity-profile.v1.json"),)


@pytest.mark.parametrize("parts", SHARED_CONFIGS)
def test_shared_config_ships_inside_the_build_context(parts: tuple[str, ...]) -> None:
    """The KYC identity contract lived only at the repo root, so the image lacked it.

    Production memory capture logged ``pkm.kyc_identity_contract_unavailable
    error=FileNotFoundError`` and returned zero cards for identity content
    (2026-09-27). The in-context copy is what ships.
    """
    from hushh_mcp.services.generated_contracts import shared_config_path

    in_context = BACKEND_ROOT / "config" / parts[0] / parts[1]
    assert in_context.is_file()
    assert shared_config_path(*parts) == in_context
    canonical = (REPO_ROOT / "config" / parts[0] / parts[1]).read_text(encoding="utf-8")
    assert in_context.read_text(encoding="utf-8").replace("\r\n", "\n") == canonical.replace(
        "\r\n", "\n"
    ), "The backend copy has drifted from config/pkm; copy the canonical file over it."


def test_kyc_identity_fields_load_from_inside_the_build_context() -> None:
    from hushh_mcp.services import gmail_personal_information_request_service as gmail_pir
    from hushh_mcp.services import pkm_agent_lab_service as lab

    for path in (
        lab._KYC_IDENTITY_PROFILE_CONTRACT_PATH,
        gmail_pir._KYC_IDENTITY_PROFILE_CONTRACT_PATH,
    ):
        assert BACKEND_ROOT in path.parents
    assert lab.PKMAgentLabService._kyc_identity_fields()
