"""Build exact S in isolated Dev; copy its accepted executable digest to UAT.

No commands run on import. A proof is collected from a successful Cloud Build,
its native output and immutable registry bytes, never admitted from a file.
This image proof grants no shared acceptance or production traffic authority.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import qualification_acceptance as acceptance
import validation
from qualification_target import SOURCE, QualificationError, Target, require

ROOT = validation.ROOT
MODULE = "deploy/plg/qualification_image.py"
RECIPE = "deploy/backend-image.cloudbuild.yaml"
RECORD_STEP = "record-backend-image"
UUID = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
DIGEST = r"sha256:[0-9a-f]{64}"
LIMIT = 4 * 1024 * 1024


@dataclass(frozen=True)
class Attempt:
    workflow_sha: str
    run_id: str
    run_attempt: str

    def __post_init__(self):
        require(
            re.fullmatch(r"[0-9a-f]{40}", self.workflow_sha) is not None
            and all(re.fullmatch(r"[1-9][0-9]*", v) for v in (self.run_id, self.run_attempt)),
            "qualification_image_attempt_invalid",
        )

    @property
    def tag(self) -> str:
        return f"plg-qual-{SOURCE[:12]}-{self.run_id}-{self.run_attempt}"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class Cloud:
    """The current normal gcloud identity; no account switch or token on argv."""

    def command(self, *args: str, timeout: float = 30) -> bytes:
        program = shutil.which("gcloud")
        require(program is not None, "qualification_image_gcloud_unavailable")
        try:
            result = subprocess.run(  # noqa: S603 -- fixed gcloud port, fixed target selectors.
                [program, *args], cwd=ROOT, capture_output=True, timeout=timeout, check=False
            )
        except (OSError, subprocess.SubprocessError):
            raise QualificationError("qualification_image_command_needs_reconciliation") from None
        require(
            result.returncode == 0 and len(result.stdout) <= LIMIT,
            "qualification_image_command_needs_reconciliation",
        )
        return result.stdout

    def read(self, *args: str) -> dict:
        value = json.loads(self.command(*args, "--format=json"))
        require(isinstance(value, dict), "qualification_image_cloud_record_invalid")
        return value

    def manifest(self, project: str, digest: str) -> bytes:
        require(project in {Target("dev").project, Target("uat").project}, "image_project_invalid")
        require(re.fullmatch(DIGEST, digest) is not None, "image_digest_invalid")
        token = self.command("auth", "print-access-token").decode("utf-8").strip()
        require(bool(token) and "\n" not in token, "qualification_image_token_unavailable")
        request = urllib.request.Request(
            f"https://gcr.io/v2/{project}/consent-protocol/manifests/{digest}",
            headers={
                "Authorization": "Bearer " + token,
                "Accept": ", ".join(
                    (
                        "application/vnd.oci.image.index.v1+json",
                        "application/vnd.docker.distribution.manifest.list.v2+json",
                        "application/vnd.oci.image.manifest.v1+json",
                        "application/vnd.docker.distribution.manifest.v2+json",
                    )
                ),
            },
        )
        try:
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
                raw = response.read(LIMIT + 1)
        except Exception:
            raise QualificationError("qualification_image_manifest_unavailable") from None
        require(len(raw) <= LIMIT, "qualification_image_manifest_oversized")
        return raw


def reviewed_recipe(attempt: Attempt, environment: str) -> tuple[bytes, str]:
    definitions = acceptance.reviewed_definitions(attempt.workflow_sha, environment)
    require(MODULE in definitions, "qualification_image_authority_unregistered")
    raw = validation.authority._git("show", attempt.workflow_sha + ":" + RECIPE)
    digest = hashlib.sha256(raw).hexdigest()
    require(definitions[RECIPE] == digest, "qualification_image_recipe_changed")
    return raw, digest


def archive_source(path: Path) -> tuple[str, str]:
    tree = validation.authority._git("rev-parse", SOURCE + "^{tree}").decode().strip()
    require(re.fullmatch(r"[0-9a-f]{40}", tree) is not None, "qualification_image_tree_invalid")
    result = validation.authority._run_git(
        "archive",
        "--format=tar.gz",
        "--output=" + str(path),
        SOURCE,
        "consent-protocol",
        "contracts",
    )
    require(result.returncode == 0 and path.is_file(), "qualification_image_archive_unavailable")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return tree, digest.hexdigest()


def _expanded(value, substitutions: dict):
    if isinstance(value, list):
        return [_expanded(item, substitutions) for item in value]
    if isinstance(value, str):
        for key, replacement in substitutions.items():
            value = value.replace("${" + key + "}", replacement).replace("$" + key, replacement)
    return value


def check_recipe(build: dict, recipe: bytes, attempt: Attempt) -> int:
    # Admission runs before the locked source runtime is installed. Only the
    # later image phase needs PyYAML, which that runtime supplies.
    import yaml

    expected = yaml.safe_load(recipe)
    substitutions = {"_IMAGE_TAG": attempt.tag, "_BUILD_TARGET": "backend"}
    require(
        build.get("substitutions") == substitutions,
        "qualification_image_build_substitutions_changed",
    )
    steps, wanted = build.get("steps", []), expected["steps"]
    require(len(steps) == len(wanted), "qualification_image_build_recipe_changed")
    record = []
    variables = {**substitutions, "PROJECT_ID": Target("dev").project}
    for index, (actual, defined) in enumerate(zip(steps, wanted, strict=True)):
        require(actual.get("status") == "SUCCESS", "qualification_image_build_step_unsuccessful")
        for key, value in defined.items():
            require(
                actual.get(key) in (value, _expanded(value, variables)),
                "qualification_image_build_recipe_changed",
            )
        for key in (
            "allowFailure",
            "allowExitCodes",
            "automapSubstitutions",
            "env",
            "secretEnv",
            "script",
            "dir",
            "volumes",
            "remoteConfig",
            "timeout",
        ):
            require(not actual.get(key), "qualification_image_build_step_authority_changed")
        require(
            "waitFor" in defined or not actual.get("waitFor"),
            "qualification_image_build_step_authority_changed",
        )
        if actual.get("id") == RECORD_STEP:
            record.append(index)
    require(len(record) == 1, "qualification_image_record_step_missing")
    options = build.get("options", {})
    require(
        all(options.get(key) == value for key, value in expected["options"].items())
        and not any(
            options.get(key)
            for key in (
                "env",
                "secretEnv",
                "volumes",
                "automapSubstitutions",
                "dynamicSubstitutions",
            )
        )
        and options.get("substitutionOption") in (None, "MUST_MATCH")
        and not any(
            build.get(key)
            for key in ("images", "secrets", "availableSecrets", "artifacts", "gitConfig")
        )
        and build.get("timeout") == expected["timeout"],
        "qualification_image_build_options_changed",
    )
    return record[0]


def source_provenance(build: dict, archive_sha: str) -> dict:
    provenance = build.get("sourceProvenance", {})
    storage = provenance.get("resolvedStorageSource", {})
    require(
        set(storage) == {"bucket", "object", "generation"}
        and all(isinstance(storage[key], str) and storage[key] for key in ("bucket", "object"))
        and re.fullmatch(r"[1-9][0-9]*", str(storage.get("generation", ""))) is not None
        and build.get("source") == {"storageSource": storage},
        "qualification_image_storage_source_unbound",
    )
    uri = f"gs://{storage['bucket']}/{storage['object']}"
    hashes = provenance.get("fileHashes", {})
    require(
        len(hashes) == 1 and next(iter(hashes)) in {uri, uri + "#" + str(storage["generation"])},
        "qualification_image_archive_hash_unbound",
    )
    values = next(iter(hashes.values())).get("fileHash", [])
    sha = [item.get("value") for item in values if item.get("type") == "SHA256"]
    require(len(sha) == 1, "qualification_image_archive_hash_missing")
    require(
        base64.b64decode(sha[0], validate=True).hex() == archive_sha,
        "qualification_image_archive_hash_changed",
    )
    return {**storage, "generation": str(storage["generation"])}


def native_digest(build: dict, index: int, attempt: Attempt) -> str:
    outputs = build.get("results", {}).get("buildStepOutputs", [])
    require(
        isinstance(outputs, list) and len(outputs) > index, "qualification_image_output_missing"
    )
    encoded = outputs[index]
    require(
        isinstance(encoded, str) and 0 < len(encoded) <= 5500, "qualification_image_output_invalid"
    )
    raw = base64.b64decode(encoded, validate=True)
    require(len(raw) <= 4096, "qualification_image_output_oversized")
    report = json.loads(raw)
    require(
        isinstance(report, dict)
        and set(report) == {"kind", "imageTag", "indexDigest", "platform"}
        and report.get("kind") == "backend-image-build-output-v1"
        and report.get("imageTag") == attempt.tag
        and report.get("platform") == "linux/amd64"
        and re.fullmatch(DIGEST, report.get("indexDigest", "")) is not None,
        "qualification_image_output_binding_changed",
    )
    return report["indexDigest"]


def resolve_image(cloud: Cloud, target: Target, digest: str, *, index_required: bool) -> str:
    path = ROOT / "scripts/ci/resolve-cloud-run-image.py"
    spec = importlib.util.spec_from_file_location("plg_image_resolver", path)
    resolver = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(resolver)
    selected = resolver.resolve_manifest(cloud.manifest(target.project, digest), digest)
    require(
        not index_required or selected["selection"] == "linux/amd64",
        "qualification_image_amd64_descriptor_required",
    )
    child = selected["digest"]
    require(
        resolver.resolve_manifest(cloud.manifest(target.project, child), child)
        == {"digest": child, "selection": "direct_manifest"},
        "qualification_image_executable_manifest_invalid",
    )
    return f"gcr.io/{target.project}/consent-protocol@{child}"


def await_build(cloud: Cloud, build_id: str) -> dict:
    require(re.fullmatch(UUID, build_id) is not None, "qualification_image_build_id_unbound")
    deadline = time.monotonic() + 1900
    while True:
        build = cloud.read("builds", "describe", build_id, "--project=" + Target("dev").project)
        require(
            build.get("id") == build_id and build.get("projectId") == Target("dev").project,
            "qualification_image_build_id_unbound",
        )
        if build.get("status") == "SUCCESS":
            return build
        require(
            build.get("status") in {"QUEUED", "PENDING", "WORKING"},
            "qualification_image_build_failed",
        )
        require(time.monotonic() < deadline, "qualification_image_build_needs_reconciliation")
        time.sleep(min(5, max(0, deadline - time.monotonic())))


def submit_archive(cloud: Cloud, archive: Path, config: Path, attempt: Attempt) -> str:
    build_id = (
        cloud.command(
            "builds",
            "submit",
            str(archive),
            "--project=" + Target("dev").project,
            "--config=" + str(config),
            "--async",
            "--suppress-logs",
            "--format=value(id)",
            "--substitutions=_BUILD_TARGET=backend,_IMAGE_TAG=" + attempt.tag,
            timeout=120,
        )
        .decode("utf-8")
        .strip()
    )
    require(
        re.fullmatch(UUID, build_id) is not None, "qualification_image_submit_needs_reconciliation"
    )
    return build_id


def build_dev(
    attempt: Attempt, validation_run: int, *, cloud=None, checkpoint=lambda _value: None
) -> dict:
    recipe, config_sha = reviewed_recipe(attempt, "dev")
    source = validation.verify(validation_run, SOURCE)
    target, cloud = Target("dev"), cloud or Cloud()
    with tempfile.TemporaryDirectory(prefix="plg-image-") as temporary:
        archive = Path(temporary) / "source.tar.gz"
        tree, archive_sha = archive_source(archive)
        config = Path(temporary) / "backend-image.cloudbuild.yaml"
        config.write_bytes(recipe)
        checkpoint(
            {
                "sourceArchiveSha256": archive_sha,
                "sourceTree": tree,
                "configSha256": config_sha,
                "imageTag": attempt.tag,
            }
        )
        build_id = submit_archive(cloud, archive, config, attempt)
        checkpoint({"buildId": build_id})
        build = await_build(cloud, build_id)
        index = check_recipe(build, recipe, attempt)
        storage = source_provenance(build, archive_sha)
        digest = native_digest(build, index, attempt)
        reference = resolve_image(cloud, target, digest, index_required=True)
    require(
        validation.verify(validation_run, SOURCE) == source,
        "qualification_image_source_validation_changed",
    )
    return {
        "reference": reference,
        "sourceSha": SOURCE,
        "mode": "source-build",
        "observedAt": datetime.now(timezone.utc).isoformat(),
        "build": {
            "project": target.project,
            "status": "SUCCESS",
            "sourceSha": SOURCE,
            "sourceTree": tree,
            "configSha256": config_sha,
            "imageTag": attempt.tag,
            "executableReference": reference,
            "platform": "linux/amd64",
            "buildId": build_id,
            "sourceArchiveSha256": archive_sha,
            "storageSource": storage,
            "indexReference": f"gcr.io/{target.project}/consent-protocol@{digest}",
        },
    }


def promote_uat(attempt: Attempt, dev_run: int, *, cloud=None) -> dict:
    reviewed_recipe(attempt, "uat")
    previous = acceptance.verify("dev", dev_run)
    require(
        type(previous) is acceptance.IsolatedAcceptance, "qualification_image_isolated_dev_required"
    )
    target, cloud = Target("uat"), cloud or Cloud()
    reference = previous.image_reference
    require(
        re.fullmatch(r"gcr\.io/hushh-pda-dev/consent-protocol@" + DIGEST, reference) is not None,
        "qualification_image_dev_reference_invalid",
    )
    repository = f"gcr.io/{target.project}/consent-protocol"
    tag = repository + ":" + attempt.tag
    cloud.command("container", "images", "add-tag", "--quiet", reference, tag, timeout=120)
    observed = cloud.read("container", "images", "describe", tag, "--project=" + target.project)
    digest = observed.get("image_summary", {}).get("digest", "")
    require(re.fullmatch(DIGEST, digest) is not None, "qualification_image_copy_digest_missing")
    copied = resolve_image(cloud, target, digest, index_required=False)
    require(
        copied == repository + "@" + reference.rsplit("@", 1)[1]
        and acceptance.verify("dev", dev_run) == previous,
        "qualification_image_accepted_dev_changed",
    )
    return {
        "reference": copied,
        "sourceSha": SOURCE,
        "mode": "promoted-dev",
        "promotedFrom": reference,
        "observedAt": datetime.now(timezone.utc).isoformat(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("environment", choices=("dev", "uat"))
    parser.add_argument("--workflow-sha", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-attempt", required=True)
    parser.add_argument("--validation-run", type=int)
    parser.add_argument("--dev-run", type=int)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    attempt = Attempt(args.workflow_sha, args.run_id, args.run_attempt)
    require(
        (args.environment == "dev" and args.validation_run is not None and args.dev_run is None)
        or (args.environment == "uat" and args.dev_run is not None and args.validation_run is None),
        "qualification_image_predecessor_argument_invalid",
    )
    intent = {
        "status": "needs-reconciliation",
        "environment": args.environment,
        "sourceSha": SOURCE,
        "runId": attempt.run_id,
        "runAttempt": attempt.run_attempt,
        "workflowSha": attempt.workflow_sha,
        "imageTag": attempt.tag,
        "validationRun": args.validation_run,
        "devRun": args.dev_run,
    }
    with args.output.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(intent, sort_keys=True) + "\n")

    def checkpoint(value):
        intent.update(value)
        args.output.write_text(json.dumps(intent, sort_keys=True) + "\n", encoding="utf-8")

    try:
        if args.environment == "dev":
            proof = build_dev(attempt, args.validation_run, checkpoint=checkpoint)
        else:
            proof = promote_uat(attempt, args.dev_run)
        args.output.write_text(json.dumps(proof, sort_keys=True) + "\n", encoding="utf-8")
    except Exception:
        print("Isolated PLG image needs reconciliation; no automatic retry.", file=sys.stderr)
        return 1
    print(proof["reference"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
