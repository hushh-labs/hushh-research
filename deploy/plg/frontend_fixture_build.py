"""Fixed private fixture build capability; no independent release authority."""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.request
import urllib.error
from urllib.parse import urlsplit
import frontend_build_evidence as evidence
import frontend_fixture_runtime as runtime
import frontend_hosted_caller as caller
import frontend_release as release
import qualification_image as images

from frontend_fixture_io import LIMIT, write, load, inspect_inputs
from frontend_fixture_request_state import requesting


def build(attempt, folder, *, cloud=None):
    prepared, recipe, snapshot, original_recipe, original_overlays = inspect_inputs(
        attempt, folder
    )
    # Only the genuine current Main publication and native history may admit it.
    caller.authorize_submission(attempt, prepared, load(folder, "intent"))
    principal = os.environ.get("PLG_FRONTEND_BUILD_PRINCIPAL", "")
    release.require(
        re.fullmatch(
            r"projects/"
            + re.escape(attempt.project)
            + r"/serviceAccounts/[a-z0-9-]+@"
            + re.escape(attempt.project)
            + r"\.iam\.gserviceaccount\.com",
            principal,
        )
        is not None,
        "Fixture reviewed build principal missing",
    )
    cloud = cloud or images.Cloud()
    write(
        folder,
        "build-operation",
        {"status": "submission-needs-reconciliation", "intent": load(folder, "intent")},
    )
    requesting()
    raw = cloud.command(
        "builds",
        "submit",
        str(folder / "source.tar.gz"),
        "--project=" + attempt.project,
        "--config=" + str(folder / "build.yaml"),
        "--service-account=" + principal,
        "--async",
        "--suppress-logs",
        "--format=value(id)",
        "--substitutions="
        + ",".join(
            key + "=" + value for key, value in sorted(attempt.substitutions().items())
        ),
        timeout=120,
    )
    build_id = raw.decode().strip()
    release.require(
        re.fullmatch(images.UUID, build_id),
        "Fixture build submission needs reconciliation",
    )
    write(folder, "build-identity", {"id": build_id, "serviceAccount": principal})
    observed = _await_build(cloud, attempt, build_id)
    return _record_build(
        cloud,
        attempt,
        folder,
        prepared,
        recipe,
        snapshot,
        original_recipe,
        original_overlays,
        observed,
        build_id,
        principal,
    )


def manifest(cloud, attempt, digest):
    release.require(re.fullmatch(images.DIGEST, digest), "Fixture image digest invalid")
    token = cloud.command("auth", "print-access-token").decode().strip()
    release.require(
        bool(token) and "\n" not in token, "Fixture registry identity missing"
    )
    request = urllib.request.Request(
        f"https://gcr.io/v2/{attempt.project}/hushh-webapp/manifests/{digest}",
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
        },
    )
    try:
        with urllib.request.build_opener(images.NoRedirect()).open(
            request, timeout=30
        ) as response:
            raw = response.read(LIMIT + 1)
    except Exception:
        raise release.Refused("Fixture registry read unavailable") from None
    release.require(len(raw) <= LIMIT, "Fixture registry response oversized")
    return raw


def blob(cloud, attempt, digest):
    """Read a small immutable helper layer; never forward auth on redirects."""
    release.require(re.fullmatch(images.DIGEST, digest), "Fixture blob digest invalid")
    token = cloud.command("auth", "print-access-token").decode().strip()
    release.require(
        bool(token) and "\n" not in token, "Fixture registry identity missing"
    )
    request = urllib.request.Request(
        f"https://gcr.io/v2/{attempt.project}/hushh-webapp/blobs/{digest}",
        headers={"Authorization": "Bearer " + token},
    )
    opener = urllib.request.build_opener(images.NoRedirect())
    try:
        try:
            response = opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            with error:
                location = error.headers.get("Location", "")
                parsed = urlsplit(location)
                release.require(
                    error.code in {302, 303, 307, 308}
                    and len(location) <= 8192
                    and parsed.scheme == "https"
                    and parsed.hostname
                    and parsed.netloc == parsed.hostname
                    and (
                        parsed.hostname == "storage.googleapis.com"
                        or parsed.hostname.endswith(".googleusercontent.com")
                    ),
                    "Fixture registry blob redirect refused",
                )
            response = opener.open(urllib.request.Request(location), timeout=30)
        with response:
            release.require(response.status == 200, "Fixture registry blob unavailable")
            raw = response.read(LIMIT + 1)
    except Exception:
        raise release.Refused("Fixture registry blob unavailable") from None
    release.require(
        0 < len(raw) <= LIMIT and "sha256:" + hashlib.sha256(raw).hexdigest() == digest,
        "Fixture registry blob changed",
    )
    return raw


def _await_build(cloud, attempt, build_id):
    deadline = time.monotonic() + 1900
    while True:
        observed = cloud.read(
            "builds", "describe", build_id, "--project=" + attempt.project
        )
        release.require(
            observed.get("id") == build_id
            and observed.get("projectId") == attempt.project,
            "Fixture build identity changed",
        )
        if observed.get("status") == "SUCCESS":
            break
        release.require(
            observed.get("status") in {"QUEUED", "WORKING", "PENDING"}
            and time.monotonic() < deadline,
            "Fixture build needs reconciliation",
        )
        time.sleep(10)
    return observed


def _record_build(
    cloud,
    attempt,
    folder,
    prepared,
    recipe,
    snapshot,
    original_recipe,
    original_overlays,
    observed,
    build_id,
    principal,
):
    # Provider-native source provenance binds the uploaded archive and generation.
    storage = images.source_provenance(observed, prepared["archive"]["archiveSha256"])
    proof = release.check_build(
        observed,
        attempt,
        recipe,
        prepared["archive"]["archiveSha256"],
        build_id,
        hashlib.sha256(recipe).hexdigest(),
        storage,
        principal,
    )
    index = manifest(cloud, attempt, proof["indexDigest"])
    resolver = release.verify_image_manifests
    # The reviewed resolver chooses the child digest; its bytes are read by digest.
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "fixture_image_resolver", release.ROOT / "scripts/ci/resolve-cloud-run-image.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    child_digest = module.resolve_manifest(index, proof["indexDigest"])["digest"]
    child = manifest(cloud, attempt, child_digest)
    resolver(index, child, proof["indexDigest"])
    child_document = json.loads(child)
    layer_digest = child_document["layers"][-1]["digest"]
    bundled = runtime.verify_runtime_layer(
        child, blob(cloud, attempt, layer_digest), prepared["fixtureRuntime"]
    )
    release.require(
        inspect_inputs(attempt, folder)
        == (prepared, recipe, snapshot, original_recipe, original_overlays),
        "Fixture inputs changed during build",
    )
    document = evidence.build_document(
        attempt,
        prepared,
        recipe,
        observed,
        build_id,
        storage,
        principal,
        index,
        child,
        original_recipe,
        original_overlays,
    )
    write(folder, "build-evidence", document)
    write(folder, "runtime-image-readback", bundled)
    write(
        folder,
        "candidate-plan",
        runtime.service_document(
            attempt,
            document["imageReference"],
            snapshot["inventory"],
            prepared["fixtureRuntime"],
        ),
    )
