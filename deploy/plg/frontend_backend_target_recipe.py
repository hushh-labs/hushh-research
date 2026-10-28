"""Propose a build-time isolated backend equality gate; never authorize a build.

The pair is untrusted until a hosted consumer independently authenticates the
provider's project, service, revision, UID, tag and audience under a fence.
No secret values are read, returned or logged by this module.
"""

from __future__ import annotations

import hashlib
import re
from urllib.parse import urlsplit

import frontend_release as release
import frontend_pinned_recipe as pinned_recipe
import frontend_secret_pins as secret_pins
import yaml


def bind(
    recipe: bytes,
    pair: dict,
    environment: str,
    *,
    inventory,
    original_recipe,
    original_overlays,
    expected_hashes,
) -> tuple[bytes, dict]:
    """Add a fail-closed check without embedding or revealing the secret value."""
    release.require(
        environment in release.TARGETS
        and isinstance(recipe, bytes)
        and isinstance(pair, dict)
        and pair.get("kind") == "proposed-private-plg-backend-pair-v1"
        and pair.get("environment") == environment
        and pair.get("project") == release.TARGETS[environment]
        and all(
            pair.get(key) is False
            for key in (
                "providerVerified",
                "durableFenceVerified",
                "frontendPairAccepted",
                "productionTrafficAuthorized",
            )
        ),
        "Frontend backend pair invalid",
    )
    expected, _overlays, _manifest = pinned_recipe.derive(
        environment,
        original_recipe,
        original_overlays,
        inventory,
        expected_hashes,
        fixture_backend=True,
    )
    release.require(recipe == expected, "Frontend backend pinned recipe changed")
    config, step, url = _binding_inputs(recipe, pair, environment)
    check = f"if [[ \"$${{BACKEND_URL_VAL}}\" != '{url}' ]]; then echo 'Isolated backend target mismatch' >&2; exit 1; fi\n"
    step["args"][1] = step["args"][1].replace(
        "set -euo pipefail\n", "set -euo pipefail\n" + check, 1
    )
    step["secretEnv"] = ["APP_FRONTEND_ORIGIN_VAL", "BACKEND_URL_VAL"]
    result = yaml.safe_dump(config, sort_keys=False).encode()
    return result, {
        "kind": "proposed-isolated-frontend-backend-binding-v1",
        "environment": environment,
        "project": release.TARGETS[environment],
        "recipeSha256": hashlib.sha256(result).hexdigest(),
        "backendIdentityVerified": False,
        "secretPayloadVerified": False,
        "maySubmit": False,
    }


def _binding_inputs(recipe, pair, environment):
    url = pair.get("candidateUrl")
    release.require(
        isinstance(url, str) and len(url) <= 512, "Frontend backend target invalid"
    )
    parsed = urlsplit(url)
    release.require(
        parsed.scheme == "https"
        and parsed.hostname is not None
        and re.fullmatch(r"[a-z0-9][a-z0-9.-]*\.run\.app", parsed.hostname) is not None
        and parsed.netloc == parsed.hostname
        and not (parsed.path or parsed.query or parsed.fragment)
        and url == "https://" + parsed.hostname,
        "Frontend backend target invalid",
    )
    config = yaml.safe_load(recipe)
    release.require(
        isinstance(config, dict)
        and isinstance(config.get("steps"), list)
        and len(config["steps"]) == 3,
        "Frontend backend recipe invalid",
    )
    step = config["steps"][0]
    release.require(
        isinstance(step, dict)
        and step.get("id") == "resolve-google-contacts-client-config"
        and step.get("secretEnv") == ["APP_FRONTEND_ORIGIN_VAL"]
        and isinstance(step.get("args"), list)
        and len(step["args"]) == 2
        and step["args"][0] == "-c"
        and isinstance(step["args"][1], str)
        and step["args"][1].count("set -euo pipefail\n") == 1,
        "Frontend backend recipe changed",
    )
    bindings = config.get("availableSecrets", {}).get("secretManager", [])
    matched = [
        item
        for item in bindings
        if isinstance(item, dict) and item.get("env") == "BACKEND_URL_VAL"
    ]
    release.require(
        len(matched) == 1
        and re.fullmatch(
            r"projects/"
            + re.escape(release.TARGETS[environment])
            + r"/secrets/"
            + re.escape(secret_pins.FIXTURE_BACKEND)
            + r"/versions/[1-9][0-9]*",
            matched[0].get("versionName", ""),
        )
        is not None,
        "Frontend backend secret not pinned",
    )
    return config, step, url
