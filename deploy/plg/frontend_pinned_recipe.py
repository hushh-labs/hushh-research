"""Derive proposed numerically pinned frontend inputs, without cloud authority.

Inputs are untrusted. A hosted producer must authenticate the snapshot, bind it
to a reviewed workflow and prove consumption before using these bytes. This
module does not submit builds or establish that an optional secret is absent.
"""

from __future__ import annotations

import hashlib
import json

import frontend_release as release
import frontend_secret_pins as pins
import yaml


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _wrapper(environment, versions):
    """Use only the fixed project and catalog; never interpolate secret values."""
    project = release.TARGETS[environment]
    cases = []
    for name, resource in sorted(versions.items()):
        if resource is None:
            action = 'printf "NOT_FOUND: proposed absent secret\\n" >&2; return 1'
        else:
            version = resource.rsplit("/", 1)[1]
            action = f'gcloud secrets versions access {version} --secret="$secret" --project="$project"'
        cases.append(f"    {name}) {action} ;;")
    return "\n".join(
        [
            "plg_pinned_secret_access() {",
            '  local secret="" project="" arg',
            '  for arg in "$@"; do',
            '    case "$arg" in',
            '      --secret=*) [[ -z "$secret" ]] || return 1; secret="${arg#--secret=}" ;;',
            '      --project=*) [[ -z "$project" ]] || return 1; project="${arg#--project=}" ;;',
            "      *) return 1 ;;",
            "    esac",
            "  done",
            f'  [[ "$project" == "{project}" ]] || return 1',
            '  case "$secret" in',
            *cases,
            "    *) return 1 ;;",
            "  esac",
            "}",
            "export -f plg_pinned_secret_access",
            "",
        ]
    )


def derive(
    environment, recipe, overlays, inventory, expected_hashes, *, fixture_backend=False
):
    """Return deterministic local recipe/overlay proposals and their hashes."""
    snapshot = pins.validate_inventory(
        environment, inventory, fixture_backend=fixture_backend
    )
    release.require(
        isinstance(recipe, bytes)
        and isinstance(overlays, dict)
        and set(overlays) == set(release.OVERLAYS)
        and isinstance(expected_hashes, dict)
        and set(expected_hashes)
        == {"deploy/frontend-image.cloudbuild.yaml", *release.OVERLAYS}
        and all(isinstance(value, bytes) for value in overlays.values()),
        "Frontend pin inputs invalid",
    )
    originals = {"deploy/frontend-image.cloudbuild.yaml": recipe, **overlays}
    release.require(
        all(_sha(value) == expected_hashes[name] for name, value in originals.items()),
        "Frontend pin inputs changed",
    )
    config = yaml.safe_load(
        release.isolated_recipe(
            recipe, expected_hashes["deploy/frontend-image.cloudbuild.yaml"]
        )
    )
    _pin_bindings(config, snapshot, fixture_backend)
    step = config["steps"][0]
    script = step["args"][1]
    token = "gcloud secrets versions access latest"
    release.require(script.count(token) == 3, "Frontend dynamic secret reads changed")
    script = script.replace(token, "plg_pinned_secret_access")
    marker = "set -euo pipefail\n"
    release.require(script.count(marker) == 1, "Frontend resolver structure changed")
    wrapper = _wrapper(environment, snapshot["versions"]).replace("$", "$$")
    step["args"][1] = script.replace(marker, marker + wrapper, 1)
    derived = {}
    for name, value in overlays.items():
        release.require(
            value.count(token.encode()) == 1, "Frontend helper secret reads changed"
        )
        derived[name] = value.replace(token.encode(), b"plg_pinned_secret_access")
    recipe_bytes = yaml.safe_dump(config, sort_keys=False).encode()
    release.require(
        token.encode() not in recipe_bytes
        and all(token.encode() not in item for item in derived.values()),
        "Frontend unpinned secret read remains",
    )
    manifest = {
        "kind": "proposed-frontend-pinned-input-v1",
        "environment": environment,
        "project": snapshot["project"],
        "fixtureBackend": fixture_backend,
        "versions": snapshot["versions"],
        "recipeSha256": _sha(recipe_bytes),
        "overlaysSha256": {
            name: _sha(value) for name, value in sorted(derived.items())
        },
        "providerVerified": False,
        "consumptionVerified": False,
        "environmentAccepted": False,
        "productionTrafficAuthorized": False,
    }
    return recipe_bytes, derived, json.loads(json.dumps(manifest))


def prepare_local(
    attempt, validation_run, inventory, archive_path, *, fixture_backend=False
):
    """Prepare local inputs; on failure any created archive is untrusted.

    The caller must use an exclusive owned directory and reconcile a leftover
    archive before retrying. No provider state or hosted proof is established.
    """
    release.require(
        type(attempt) is release.Attempt
        and type(validation_run) is int
        and validation_run > 0,
        "Frontend pinned preparation identity invalid",
    )
    authority = release.reviewed_inputs(attempt)
    validated = release.frontend_validation.verify(validation_run, release.SOURCE)
    git = release.source.backend._git
    recipe_path = "deploy/frontend-image.cloudbuild.yaml"
    recipe = git("show", f"{attempt.workflow_sha}:{recipe_path}")
    originals = {
        name: git("show", f"{attempt.workflow_sha}:{name}") for name in release.OVERLAYS
    }
    expected = {name: authority[name] for name in (recipe_path, *release.OVERLAYS)}
    derived_recipe, overlays, manifest = derive(
        attempt.environment,
        recipe,
        originals,
        inventory,
        expected,
        fixture_backend=fixture_backend,
    )
    archive = release.archive_source(archive_path, overlays)
    release.require(
        archive.get("sourceSha") == release.SOURCE
        and archive.get("sourceTree") == release.SOURCE_TREE
        and archive.get("overlays") == manifest["overlaysSha256"]
        and archive.get("environmentAccepted") is False
        and archive.get("productionTrafficAuthorized") is False,
        "Frontend pinned archive mismatch",
    )
    release.require(
        release.frontend_validation.verify(validation_run, release.SOURCE) == validated
        and release.reviewed_inputs(attempt) == authority,
        "Frontend pinned authority changed",
    )
    return derived_recipe, {
        "kind": "proposed-frontend-pinned-build-input-v1",
        "workflowSha": attempt.workflow_sha,
        "runId": attempt.run_id,
        "runAttempt": attempt.run_attempt,
        "substitutions": attempt.substitutions(),
        "sourceValidation": validated,
        "authorityFiles": authority,
        "pins": manifest,
        "archive": archive,
        "providerVerified": False,
        "consumptionVerified": False,
        "environmentAccepted": False,
        "productionTrafficAuthorized": False,
    }


def _pin_bindings(config, snapshot, fixture_backend):
    entries = config.get("availableSecrets", {}).get("secretManager")
    release.require(
        isinstance(entries, list) and len(entries) == 11,
        "Frontend secret bindings changed",
    )
    seen = set()
    for item in entries:
        release.require(
            isinstance(item, dict) and set(item) == {"versionName", "env"},
            "Frontend secret binding invalid",
        )
        env = item["env"]
        release.require(
            isinstance(env, str) and env.endswith("_VAL"),
            "Frontend secret binding invalid",
        )
        name = env[:-4]
        actual_name = (
            pins.FIXTURE_BACKEND if fixture_backend and name == "BACKEND_URL" else name
        )
        release.require(
            name not in seen
            and name in pins.REQUIRED
            and item["versionName"]
            == f"projects/$PROJECT_ID/secrets/${{_SECRET_PREFIX}}{name}/versions/latest"
            and snapshot["versions"].get(actual_name) is not None,
            "Frontend secret binding changed",
        )
        seen.add(name)
        item["versionName"] = snapshot["versions"][actual_name]
    release.require(len(seen) == 11, "Frontend secret bindings incomplete")
