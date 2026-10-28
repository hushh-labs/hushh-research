"""Finite frontend native_build capability; no release authority."""

from __future__ import annotations
import base64
import binascii
import hashlib
import importlib.util
import json
import re
import yaml
import frontend_release as release


def _expanded(value, substitutions: dict[str, str]):
    if isinstance(value, list):
        return [_expanded(item, substitutions) for item in value]
    if isinstance(value, dict):
        return {key: _expanded(item, substitutions) for key, item in value.items()}
    if isinstance(value, str):
        value = value.replace("$$", "\x00")
        for key in sorted(substitutions, key=len, reverse=True):
            value = value.replace("${" + key + "}", substitutions[key]).replace(
                "$" + key, substitutions[key]
            )
        return value.replace("\x00", "$")
    return value


def check_build(
    build: dict,
    attempt: release.Attempt,
    recipe: bytes,
    archive_sha256: str,
    expected_build_id: str,
    expected_recipe_sha256: str,
    expected_storage: dict,
    expected_service_account: str,
) -> dict:
    """Check provider build metadata; this alone grants no environment acceptance."""
    release.require(
        re.fullmatch("[0-9a-f]{64}", archive_sha256) is not None,
        "Frontend archive hash invalid",
    )
    release.require(
        re.fullmatch("[0-9a-f]{64}", expected_recipe_sha256) is not None
        and hashlib.sha256(recipe).hexdigest() == expected_recipe_sha256,
        "Frontend derived recipe changed",
    )
    config = yaml.safe_load(recipe)
    release.require(isinstance(config, dict), "Frontend build recipe invalid")
    release.require(
        isinstance(build, dict)
        and build.get("status") == "SUCCESS"
        and (build.get("projectId") == attempt.project)
        and (
            re.fullmatch(
                "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", expected_build_id
            )
            is not None
        )
        and (build.get("id") == expected_build_id)
        and bool(expected_service_account)
        and (build.get("serviceAccount") == expected_service_account)
        and (build.get("substitutions") == attempt.substitutions()),
        "Frontend build identity invalid",
    )
    wanted_steps = _verify_steps(build, config, attempt)
    sha_values = _verify_source(build, expected_storage)
    report = _output(build, wanted_steps, sha_values, archive_sha256, attempt)
    return {
        "buildId": build["id"],
        "project": attempt.project,
        "archiveSha256": archive_sha256,
        "imageTag": attempt.tag,
        "indexDigest": report["indexDigest"],
        "buildPlatformRequested": "linux/amd64",
        "platformVerified": False,
        "environmentAccepted": False,
        "productionTrafficAuthorized": False,
    }


def verify_image_manifests(
    index_bytes: bytes, child_bytes: bytes, index_digest: str
) -> dict:
    """Validate immutable registry bytes; the caller must pin the reviewed resolver."""
    release.require(
        isinstance(index_bytes, bytes)
        and isinstance(child_bytes, bytes)
        and (0 < len(index_bytes) <= 4 * 1024 * 1024)
        and (0 < len(child_bytes) <= 4 * 1024 * 1024),
        "Frontend image manifest invalid",
    )
    spec = importlib.util.spec_from_file_location(
        "plg_frontend_image_resolver",
        release.ROOT / "scripts/ci/resolve-cloud-run-image.py",
    )
    release.require(
        spec is not None and spec.loader is not None,
        "Frontend image resolver unavailable",
    )
    resolver = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(resolver)
    try:
        selected = resolver.resolve_manifest(index_bytes, index_digest)
        release.require(
            selected["selection"] == "linux/amd64", "Frontend image index missing amd64"
        )
        child = selected["digest"]
        release.require(
            resolver.resolve_manifest(child_bytes, child)
            == {"digest": child, "selection": "direct_manifest"},
            "Frontend image child invalid",
        )
    except (ValueError, TypeError, KeyError):
        raise release.Refused("Frontend image manifest invalid") from None
    return {
        "indexDigest": index_digest,
        "executableDigest": child,
        "platform": "linux/amd64",
        "environmentAccepted": False,
        "productionTrafficAuthorized": False,
    }


def _verify_steps(build, config, attempt):
    wanted_steps = config.get("steps", [])
    steps = build.get("steps", [])
    normal_ids = [
        "resolve-google-contacts-client-config",
        "build-frontend-image",
        "record-plg-frontend-image",
    ]
    fixture_ids = [normal_ids[0], "install-plg-fixture-runtime", *normal_ids[1:]]
    release.require(
        isinstance(steps, list)
        and isinstance(wanted_steps, list)
        and (len(steps) == len(wanted_steps) in (3, 4))
        and all((isinstance(step, dict) for step in wanted_steps))
        and ([step.get("id") for step in wanted_steps] in (normal_ids, fixture_ids)),
        "Frontend build step inventory changed",
    )
    variables = attempt.substitutions() | {"PROJECT_ID": attempt.project}
    for actual, wanted in zip(steps, wanted_steps, strict=True):
        release.require(
            isinstance(actual, dict) and actual.get("status") == "SUCCESS",
            "Frontend build step failed",
        )
        for key, value in wanted.items():
            release.require(
                actual.get(key) in (value, _expanded(value, variables)),
                "Frontend build step changed",
            )
        for key in (
            "allowFailure",
            "allowExitCodes",
            "automapSubstitutions",
            "script",
            "dir",
            "volumes",
            "timeout",
        ):
            release.require(
                not actual.get(key), "Frontend build step authority changed"
            )
        for key in ("env", "secretEnv", "waitFor", "entrypoint", "args"):
            release.require(
                key in wanted or not actual.get(key),
                "Frontend build step authority changed",
            )
    for key in ("secrets", "artifacts", "images", "gitConfig"):
        release.require(not build.get(key), "Frontend build authority changed")
    for key in ("availableSecrets", "timeout"):
        wanted = config.get(key)
        release.require(
            build.get(key) in (wanted, _expanded(wanted, variables)),
            "Frontend build configuration changed",
        )
    release.require(
        build.get("tags", []) == config.get("tags", []), "Frontend build tags changed"
    )
    options, expected_options = (build.get("options", {}), config.get("options", {}))
    release.require(
        isinstance(options, dict)
        and all((options.get(key) == value for key, value in expected_options.items()))
        and (
            not any(
                (
                    options.get(key)
                    for key in (
                        "env",
                        "secretEnv",
                        "volumes",
                        "automapSubstitutions",
                        "substitutionOption",
                        "pool",
                    )
                )
            )
        ),
        "Frontend build options changed",
    )
    return wanted_steps


def _verify_source(build, expected_storage):
    provenance = build.get("sourceProvenance", {})
    release.require(isinstance(provenance, dict), "Frontend build source unavailable")
    storage = provenance.get("resolvedStorageSource", {})
    release.require(
        isinstance(storage, dict)
        and set(storage) == {"bucket", "object", "generation"}
        and all(
            (
                isinstance(storage.get(key), str) and storage[key]
                for key in ("bucket", "object")
            )
        )
        and (
            re.fullmatch("[1-9][0-9]*", str(storage.get("generation", ""))) is not None
        )
        and (storage == expected_storage)
        and (build.get("source") == {"storageSource": storage}),
        "Frontend build source unavailable",
    )
    uri = f"gs://{storage['bucket']}/{storage['object']}"
    hashes = provenance.get("fileHashes", {})
    release.require(
        isinstance(hashes, dict)
        and len(hashes) == 1
        and (next(iter(hashes)) in {uri, uri + "#" + str(storage["generation"])}),
        "Frontend build source hash unavailable",
    )
    hash_entry = next(iter(hashes.values()))
    release.require(
        isinstance(hash_entry, dict), "Frontend build source hash unavailable"
    )
    file_hashes = hash_entry.get("fileHash", [])
    release.require(
        isinstance(file_hashes, list)
        and all((isinstance(item, dict) for item in file_hashes)),
        "Frontend build source hash unavailable",
    )
    sha_values = [
        item.get("value") for item in file_hashes if item.get("type") == "SHA256"
    ]
    return sha_values


def _output(build, wanted_steps, sha_values, archive_sha256, attempt):
    results = build.get("results", {})
    release.require(isinstance(results, dict), "Frontend build output unavailable")
    outputs = results.get("buildStepOutputs", [])
    release.require(
        len(sha_values) == 1
        and isinstance(outputs, list)
        and (len(outputs) >= len(wanted_steps)),
        "Frontend build output unavailable",
    )
    try:
        source_sha = base64.b64decode(sha_values[0], validate=True).hex()
        encoded = outputs[len(wanted_steps) - 1]
        release.require(
            isinstance(encoded, str) and 0 < len(encoded) <= 5500,
            "Frontend build output invalid",
        )
        raw = base64.b64decode(encoded, validate=True)
        release.require(len(raw) <= 4096, "Frontend build output oversized")
        report = json.loads(raw, object_pairs_hook=release.source.backend._json_pairs)
    except (binascii.Error, TypeError, ValueError, UnicodeError):
        raise release.Refused("Frontend build output invalid") from None
    release.require(
        source_sha == archive_sha256
        and isinstance(report, dict)
        and (set(report) == {"kind", "imageTag", "indexDigest", "platform"})
        and (report.get("kind") == "plg-frontend-image-build-output-v1")
        and (report.get("imageTag") == attempt.tag)
        and (report.get("platform") == "linux/amd64")
        and (
            re.fullmatch("sha256:[0-9a-f]{64}", report.get("indexDigest", ""))
            is not None
        ),
        "Frontend build output did not match",
    )
    return report
