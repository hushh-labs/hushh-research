"""Bundle Main-owned transport into an isolated W4 image and pin its runtime.

This derives bytes only. The hosted producer must authenticate its source,
backend pair, image and secret pins under the shared mutation guard. No function
here grants build submission, service mutation or production authority.
"""

from __future__ import annotations

import base64
import hashlib
import gzip
import io
import json
import re
import tarfile

import frontend_release as release
import frontend_secret_pins as pins
import yaml

SERVICE = "hushh-webapp-plg-qual"
# Official docker.io/library/python:3.13-slim index, read from Docker's native
# registry on 2026-10-28; hash independently matched Docker-Content-Digest.
PYTHON_BUILDER = (
    "python@sha256:2d44738ebf4ce5f63b9d9ea871e9c7cfdc0426f7b0c97cac915fd88ded1d86bb"
)
SCRIPTS = tuple(
    "scripts/ci/plg_fixture_" + name + ".cjs"
    for name in ("fetch", "provider", "preload")
)
INSTALLER = """import base64, hashlib, json, pathlib, sys
payload = json.loads(base64.b64decode(sys.argv[1], validate=True))
dockerfile = pathlib.Path('hushh-webapp/Dockerfile')
original = dockerfile.read_bytes()
if hashlib.sha256(original).hexdigest() != payload['dockerfileSha256']:
    raise ValueError('Fixture Dockerfile changed')
folder = pathlib.Path('hushh-webapp/scripts/plg-fixture')
folder.mkdir(mode=0o755)
for name, encoded in payload['files'].items():
    if name not in {'transport.json', 'plg_fixture_fetch.cjs', 'plg_fixture_provider.cjs', 'plg_fixture_preload.cjs'}:
        raise ValueError('Fixture runtime file invalid')
    raw = base64.b64decode(encoded, validate=True)
    with (folder / name).open('xb') as stream:
        stream.write(raw)
    (folder / name).chmod(0o444)
dockerfile.write_bytes(original + b'\\n# Main-owned qualification transport; application source remains W4.\\nCOPY scripts/plg-fixture/ /opt/plg-fixture/\\n')
"""


def digest(value):
    return hashlib.sha256(value).hexdigest()


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def names(attempt):
    release.require(type(attempt) is release.Attempt, "Fixture attempt invalid")
    tag = "q" + digest(f"{attempt.run_id}:{attempt.run_attempt}".encode())[:12]
    return {"service": SERVICE, "revision": SERVICE + "-" + tag, "tag": tag}


def transport(attempt, pair):
    identity = names(attempt)
    release.require(
        isinstance(pair, dict)
        and pair.get("environment") == attempt.environment
        and pair.get("project") == attempt.project
        and all(
            isinstance(pair.get(key), str)
            and re.fullmatch(r"[a-z0-9-]{1,128}", pair[key])
            for key in ("serviceUid", "revisionUid", "revision")
        )
        and re.fullmatch(r"consent-protocol-plg-qual-q[0-9a-f]{12}", pair["revision"]),
        "Fixture backend identity invalid",
    )
    # The upstream pair inspector checks native origins and the hosted S receipt.
    # Recheck canonical URL shape before embedding these untrusted bytes.
    from urllib.parse import urlsplit

    for key in ("serviceUrl", "candidateUrl"):
        url = pair.get(key)
        parsed = urlsplit(url if isinstance(url, str) else "")
        release.require(
            isinstance(url, str)
            and len(url) <= 512
            and parsed.scheme == "https"
            and parsed.hostname
            and parsed.hostname.endswith(".run.app")
            and parsed.netloc == parsed.hostname
            and not (parsed.path or parsed.query or parsed.fragment),
            "Fixture backend origin invalid",
        )
    release.require(
        pair["serviceUrl"] != pair["candidateUrl"], "Fixture backend tag missing"
    )
    return {
        "schemaVersion": 1,
        "environment": attempt.environment,
        "project": attempt.project,
        "frontendService": SERVICE,
        "frontendRevision": identity["revision"],
        "backendServiceUid": pair["serviceUid"],
        "backendRevisionUid": pair["revisionUid"],
        "backendRevision": pair["revision"],
        "backendServiceUrl": pair["serviceUrl"],
        "backendCandidateUrl": pair["candidateUrl"],
    }


def bundle(attempt, pair, recipe, scripts, authority, dockerfile):
    """Add a deterministic runtime installer to an already bound build recipe."""
    release.require(
        isinstance(scripts, dict)
        and set(scripts) == set(SCRIPTS)
        and isinstance(authority, dict)
        and isinstance(dockerfile, bytes)
        and 0 < len(dockerfile) < 256 * 1024
        and all(
            isinstance(value, bytes)
            and 0 < len(value) <= release.MAX_HELPER
            and digest(value) == authority.get(name)
            for name, value in scripts.items()
        ),
        "Fixture runtime authority changed",
    )
    configuration = transport(attempt, pair)
    files = {name.rsplit("/", 1)[1]: value for name, value in scripts.items()}
    files["transport.json"] = encode(configuration) + b"\n"
    payload = {
        "dockerfileSha256": digest(dockerfile),
        "files": {
            name: base64.b64encode(raw).decode() for name, raw in sorted(files.items())
        },
    }
    config = yaml.safe_load(recipe)
    release.require(
        isinstance(config, dict)
        and [step.get("id") for step in config.get("steps", [])]
        == [
            "resolve-google-contacts-client-config",
            "build-frontend-image",
            "record-plg-frontend-image",
        ],
        "Fixture build recipe changed",
    )
    config["steps"].insert(
        1,
        {
            "id": "install-plg-fixture-runtime",
            "name": PYTHON_BUILDER,
            "entrypoint": "python3",
            "args": [
                "-I",
                "-c",
                INSTALLER,
                base64.b64encode(encode(payload)).decode(),
            ],
            "waitFor": ["resolve-google-contacts-client-config"],
        },
    )
    config["steps"][2]["waitFor"] = ["install-plg-fixture-runtime"]
    config["steps"][3]["name"] = PYTHON_BUILDER
    config["tags"] = [attempt.tag]
    result = yaml.safe_dump(config, sort_keys=False).encode()
    return result, {
        "kind": "plg-frontend-fixture-runtime-input-v1",
        "configuration": configuration,
        "filesSha256": {name: digest(raw) for name, raw in sorted(files.items())},
        "originalDockerfileSha256": digest(dockerfile),
        "recipeSha256": digest(result),
        "providerVerified": False,
        "productionTrafficAuthorized": False,
    }


def reviewed_bundle(attempt, pair, recipe, authority):
    """Load helper bytes from the attempt's reviewed Main authority."""
    git = release.source.backend._git
    scripts = {name: git("show", f"{attempt.workflow_sha}:{name}") for name in SCRIPTS}
    dockerfile = git("show", f"{release.SOURCE}:hushh-webapp/Dockerfile")
    return bundle(attempt, pair, recipe, scripts, authority, dockerfile)


def verify_runtime_layer(child_manifest, compressed_layer, runtime):
    """Verify the actual final COPY layer, not only its build-recipe claim."""
    release.require(
        isinstance(child_manifest, bytes)
        and len(child_manifest) <= 4 * 1024 * 1024
        and isinstance(compressed_layer, bytes)
        and 0 < len(compressed_layer) <= 4 * 1024 * 1024,
        "Fixture image layer invalid",
    )
    child = json.loads(
        child_manifest, object_pairs_hook=release.source.backend._json_pairs
    )
    layers = child.get("layers") if isinstance(child, dict) else None
    release.require(
        isinstance(layers, list) and 0 < len(layers) <= 100,
        "Fixture image layers invalid",
    )
    layer = layers[-1]
    release.require(
        isinstance(layer, dict)
        and layer.get("mediaType")
        in {
            "application/vnd.oci.image.layer.v1.tar+gzip",
            "application/vnd.docker.image.rootfs.diff.tar.gzip",
        }
        and layer.get("digest") == "sha256:" + digest(compressed_layer)
        and layer.get("size") == len(compressed_layer),
        "Fixture image layer identity changed",
    )
    with gzip.GzipFile(fileobj=io.BytesIO(compressed_layer)) as stream:
        raw = stream.read(4 * 1024 * 1024 + 1)
    release.require(len(raw) <= 4 * 1024 * 1024, "Fixture image layer oversized")
    expected = runtime.get("filesSha256") if isinstance(runtime, dict) else None
    release.require(
        isinstance(expected, dict)
        and set(expected)
        == {"transport.json", *(name.rsplit("/", 1)[1] for name in SCRIPTS)},
        "Fixture runtime file inventory invalid",
    )
    found, seen = {}, set()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
        for entry in archive:
            name = entry.name.rstrip("/")
            release.require(
                len(seen) < 16
                and name not in seen
                and (entry.isdir() or entry.isfile())
                and name
                in {
                    "opt",
                    "opt/plg-fixture",
                    *("opt/plg-fixture/" + key for key in expected),
                },
                "Fixture runtime layer entry invalid",
            )
            seen.add(name)
            if entry.isdir():
                release.require(
                    name in {"opt", "opt/plg-fixture"},
                    "Fixture runtime layer directory invalid",
                )
                continue
            release.require(
                0 < entry.size <= release.MAX_HELPER and entry.mode & 0o222 == 0,
                "Fixture runtime layer file invalid",
            )
            with archive.extractfile(entry) as stream:
                found[name.rsplit("/", 1)[1]] = digest(
                    stream.read(release.MAX_HELPER + 1)
                )
    release.require(found == expected, "Fixture runtime image bytes changed")
    return {
        "runtimeLayerDigest": layer["digest"],
        "executableManifestDigest": "sha256:" + digest(child_manifest),
        "bundledFilesVerified": True,
        "configurationSha256": found["transport.json"],
        "productionTrafficAuthorized": False,
    }


def service_document(attempt, image, inventory, runtime):
    """Derive a separate private service; runtime backend uses a numeric pin."""
    checked = pins.validate_inventory(
        attempt.environment, inventory, fixture_backend=True
    )
    version = checked["versions"][pins.FIXTURE_BACKEND].rsplit("/", 1)[1]
    identity = names(attempt)
    release.require(
        isinstance(image, str)
        and re.fullmatch(
            r"gcr\.io/"
            + re.escape(attempt.project)
            + r"/hushh-webapp@sha256:[0-9a-f]{64}",
            image,
        )
        and isinstance(runtime, dict)
        and runtime.get("kind") == "plg-frontend-fixture-runtime-input-v1"
        and runtime.get("configuration", {}).get("frontendRevision")
        == identity["revision"]
        and runtime["configuration"].get("project") == attempt.project,
        "Fixture runtime image invalid",
    )
    labels = {
        "purpose": "plg-qualification",
        "deploy-env": attempt.environment,
        "deploy-source": "plg-frontend-fixture",
        "deploy-sha": release.SOURCE,
        "github-run-id": attempt.run_id,
    }
    return {
        "apiVersion": "serving.knative.dev/v1",
        "kind": "Service",
        "metadata": {
            "name": SERVICE,
            "namespace": attempt.project,
            "labels": labels,
            "annotations": {
                "run.googleapis.com/invoker-iam-disabled": "false",
                "run.googleapis.com/maxScale": "1",
            },
        },
        "spec": {
            "template": {
                "metadata": {
                    "name": identity["revision"],
                    "labels": labels,
                    "annotations": {
                        "autoscaling.knative.dev/minScale": "0",
                        "autoscaling.knative.dev/maxScale": "1",
                    },
                },
                "spec": {
                    "serviceAccountName": f"plg-qualification-frontend@{attempt.project}.iam.gserviceaccount.com",
                    "containerConcurrency": 10,
                    "timeoutSeconds": 120,
                    "containers": [_runtime_container(attempt, image, version)],
                },
            },
            "traffic": [
                {
                    "revisionName": identity["revision"],
                    "percent": 100,
                    "tag": identity["tag"],
                }
            ],
        },
    }


def iam_plan(attempt):
    """Describe narrow bindings for the release owner; never apply IAM here."""
    return {
        "project": attempt.project,
        "principal": f"plg-qualification-frontend@{attempt.project}.iam.gserviceaccount.com",
        "backendService": "consent-protocol-plg-qual",
        "serviceRoles": ["roles/run.invoker"],
        "serviceCustomRolePermissions": ["run.services.get", "run.revisions.get"],
        "secretAccessor": [pins.FIXTURE_BACKEND],
        "projectRoles": [],
        "resourceGrantabilityVerified": False,
        "productionTrafficAuthorized": False,
    }


def _runtime_container(attempt, image, version):
    return {
        "image": image,
        "ports": [{"containerPort": 8080}],
        "resources": {"limits": {"cpu": "1", "memory": "512Mi"}},
        "env": [
            {"name": "GOOGLE_CLOUD_PROJECT", "value": attempt.project},
            {"name": "PLG_FIXTURE_FETCH_ENABLE", "value": "1"},
            {
                "name": "NODE_OPTIONS",
                "value": "--require=/opt/plg-fixture/plg_fixture_preload.cjs",
            },
            {
                "name": "BACKEND_URL",
                "valueFrom": {
                    "secretKeyRef": {"name": pins.FIXTURE_BACKEND, "key": version}
                },
            },
        ],
    }
