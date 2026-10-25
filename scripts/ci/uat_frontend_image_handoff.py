#!/usr/bin/env python3
"""Pin a late-ready UAT web image inside its required deployment build.

The existing manifest resolver owns executable selection. The existing provider
collector owns the enclosing successful build proof. This module transports that
one pin through native Cloud Build step output without resolving the tag again.
"""

from __future__ import annotations

import argparse
import base64
import binascii
from dataclasses import asdict, dataclass
from datetime import datetime
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from capture_managed_provider_receipt import (
    ReceiptError,
    check_build,
    cloud_json,
    require,
)

PROJECT = "hushh-pda-uat"
REPOSITORY = f"gcr.io/{PROJECT}/hushh-webapp"
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
REFERENCE = re.compile(re.escape(REPOSITORY) + r"@sha256:[0-9a-f]{64}")
MODULE_PATH = "scripts/ci/uat_frontend_image_handoff.py"
STATE_FILE = ".uat-frontend-image-state.json"
PARENT_FILE = ".uat-frontend-image-parent"
MANIFEST_FILE = ".uat-frontend-image-manifest.json"
IMAGE_FILE = ".uat-frontend-image.json"
REFERENCE_FILE = ".uat-frontend-image-reference"
PIN_STEP = "pin-frontend-image"


@dataclass(frozen=True)
class Context:
    image_build_id: str
    deployment_build_id: str
    sha: str
    github_run: str
    github_attempt: str

    def __post_init__(self) -> None:
        require(
            bool(re.fullmatch(UUID, self.image_build_id))
            and bool(re.fullmatch(UUID, self.deployment_build_id))
            and self.image_build_id != self.deployment_build_id
            and bool(re.fullmatch(r"[0-9a-f]{40}", self.sha))
            and bool(re.fullmatch(r"[1-9][0-9]*", self.github_run))
            and bool(re.fullmatch(r"[1-9][0-9]*", self.github_attempt)),
            "image_context_invalid",
        )

    @property
    def tag(self) -> str:
        return f"uat-{self.sha}-{self.github_run}-{self.github_attempt}"

    @property
    def header(self) -> str:
        return "|".join(
            (
                self.sha,
                self.github_run,
                self.github_attempt,
                self.image_build_id,
                self.deployment_build_id,
            )
        )

    def arguments(self) -> list[str]:
        return [
            item
            for key, value in asdict(self).items()
            for item in ("--" + key.replace("_", "-"), value)
        ]


def _read(path: Path) -> bytes:
    require(path.stat().st_size <= 2 * 1024 * 1024, "image_evidence_oversized")
    return path.read_bytes()


def _write(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, sort_keys=True) + "\n")


def resolve_manifest(raw: bytes, reference: str) -> dict:
    spec = importlib.util.spec_from_file_location(
        "cloud_run_image", Path(__file__).with_name("resolve-cloud-run-image.py")
    )
    resolver = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(resolver)
    return resolver.resolve_manifest(raw, reference.split("@")[1])


def await_image(context: Context, workspace: Path, deadline: float) -> None:
    while True:
        build = cloud_json(
            ["builds", "describe", context.image_build_id, "--project=" + PROJECT],
            deadline,
        )
        values = build.get("substitutions", {})
        require(
            build.get("id") == context.image_build_id
            and build.get("projectId") == PROJECT
            and values.get("_IMAGE_TAG") == context.tag
            and values.get("_APP_ENV") == "uat"
            and values.get("_DEPLOY_ENV") == "uat",
            "image_build_binding_mismatch",
        )
        status = build.get("status")
        if status == "SUCCESS":
            break
        require(
            status in {"QUEUED", "PENDING", "WORKING"}, "image_build_not_successful"
        )
        require(time.monotonic() < deadline, "image_build_deadline")
        time.sleep(min(5, max(0, deadline - time.monotonic())))
    image = cloud_json(
        [
            "container",
            "images",
            "describe",
            f"{REPOSITORY}:{context.tag}",
            "--project=" + PROJECT,
        ],
        deadline,
    )
    digest = image.get("image_summary", {}).get("digest", "")
    require(bool(re.fullmatch(r"sha256:[0-9a-f]{64}", digest)), "image_digest_invalid")
    reference = REPOSITORY + "@" + digest
    _write(
        workspace / STATE_FILE,
        {"context": asdict(context), "index_reference": reference},
    )
    (workspace / PARENT_FILE).write_text(reference + "\n")


def validate_image(image: object, context: Context) -> dict:
    require(isinstance(image, dict), "image_pin_invalid")
    require(
        set(image)
        == {
            "status",
            "repository",
            "index_reference",
            "image_reference",
            "digest_algorithm",
            "selection",
            "sha",
        }
        and image.get("status") == "pinned"
        and image.get("repository") == REPOSITORY
        and image.get("sha") == context.sha
        and image.get("digest_algorithm") == "sha256"
        and image.get("selection") in {"direct_manifest", "linux/amd64"}
        and isinstance(image.get("index_reference"), str)
        and bool(REFERENCE.fullmatch(image["index_reference"]))
        and isinstance(image.get("image_reference"), str)
        and bool(REFERENCE.fullmatch(image["image_reference"])),
        "image_pin_binding_mismatch",
    )
    return image


def pin_image(context: Context, workspace: Path) -> dict:
    state = json.loads(_read(workspace / STATE_FILE))
    require(
        set(state) == {"context", "index_reference"}
        and state["context"] == asdict(context)
        and isinstance(state["index_reference"], str)
        and bool(REFERENCE.fullmatch(state["index_reference"]))
        and _read(workspace / PARENT_FILE).decode() == state["index_reference"] + "\n",
        "image_state_mismatch",
    )
    resolved = resolve_manifest(
        _read(workspace / MANIFEST_FILE), state["index_reference"]
    )
    image = validate_image(
        {
            "status": "pinned",
            "repository": REPOSITORY,
            "index_reference": state["index_reference"],
            "image_reference": REPOSITORY + "@" + resolved["digest"],
            "digest_algorithm": "sha256",
            "selection": resolved["selection"],
            "sha": context.sha,
        },
        context,
    )
    _write(workspace / IMAGE_FILE, image)
    (workspace / REFERENCE_FILE).write_text(
        context.header + "\n" + image["image_reference"] + "\n"
    )
    return {
        "schema": "uat_frontend_image_handoff.v1",
        "context": asdict(context),
        "image": image,
    }


def collect_image(
    context: Context, backend_image: str, legacy_exception: bool, deadline: float
) -> tuple[dict, dict]:
    require(
        bool(
            re.fullmatch(
                r"gcr\.io/hushh-pda-uat/consent-protocol@sha256:[0-9a-f]{64}",
                backend_image,
            )
        ),
        "backend_image_invalid",
    )
    build = cloud_json(
        ["builds", "describe", context.deployment_build_id, "--project=" + PROJECT],
        deadline,
    )
    check_build(
        build,
        {
            "build_id": context.deployment_build_id,
            "project": PROJECT,
            "source_sha": context.sha,
            "github_run": context.github_run,
            "image": backend_image,
            "runtime_account": f"consent-protocol-runtime@{PROJECT}.iam.gserviceaccount.com",
            "environment": "uat",
            "region": "us-central1",
            "legacy_exception": legacy_exception,
        },
    )
    pins = [
        (index, step)
        for index, step in enumerate(build.get("steps", []))
        if step.get("id") == PIN_STEP
    ]
    require(len(pins) == 1, "image_pin_step_missing")
    index, step = pins[0]
    recipe_arguments = context.arguments()
    recipe_arguments[recipe_arguments.index("--deployment-build-id") + 1] = "$BUILD_ID"
    require(
        step.get("status") == "SUCCESS"
        and step.get("entrypoint") == "python3"
        and step.get("args")
        in (
            [MODULE_PATH, "pin", *context.arguments()],
            [MODULE_PATH, "pin", *recipe_arguments],
        )
        and step.get("waitFor") == ["inspect-frontend-image-manifest"]
        and not step.get("allowFailure")
        and not step.get("allowExitCodes"),
        "image_pin_step_mismatch",
    )
    wait_seconds = image_wait_seconds(build, context)
    outputs = build.get("results", {}).get("buildStepOutputs", [])
    require(
        isinstance(outputs, list) and len(outputs) > index, "image_step_output_missing"
    )
    image = image_from_output(outputs[index], context)
    return image, {
        "context": asdict(context),
        "build_step": {"id": PIN_STEP, "index": index},
        "image": image,
        "image_wait_seconds": wait_seconds,
    }


def image_wait_seconds(build: dict, context: Context) -> int:
    waits = [s for s in build["steps"] if s.get("id") == "await-frontend-image"]
    require(len(waits) == 1, "image_wait_step_missing")
    step = waits[0]
    arguments = context.arguments()
    recipe = arguments.copy()
    recipe[recipe.index("--deployment-build-id") + 1] = "$BUILD_ID"
    require(
        step.get("status") == "SUCCESS"
        and step.get("entrypoint") == "python3"
        and step.get("args")
        in ([MODULE_PATH, "wait", *arguments], [MODULE_PATH, "wait", *recipe])
        and step.get("waitFor") == ["build-backend-image", "verify-runtime-iam"]
        and not step.get("allowFailure")
        and not step.get("allowExitCodes"),
        "image_wait_step_mismatch",
    )
    timing = step.get("timing", {})
    timestamps = [
        build["startTime"],
        timing.get("startTime", ""),
        timing.get("endTime", ""),
        build["finishTime"],
    ]
    times = [
        datetime.fromisoformat(value.replace("Z", "+00:00")) for value in timestamps
    ]
    require(
        all(value.utcoffset() is not None for value in times)
        and times == sorted(times),
        "image_wait_timing_invalid",
    )
    return math.ceil((times[2] - times[1]).total_seconds())


def collect_manifest(image: dict, output: Path, deadline: float) -> None:
    # Re-fetch only the immutable original parent, preserving the existing raw
    # artifact. Independently recheck its bytes and selection against the pin.
    remaining = deadline - time.monotonic()
    require(remaining > 0, "image_manifest_deadline")
    result = subprocess.run(
        [
            "docker",
            "buildx",
            "imagetools",
            "inspect",
            "--raw",
            image["index_reference"],
        ],
        capture_output=True,
        check=False,
        timeout=min(30, remaining),
    )
    require(
        result.returncode == 0 and len(result.stdout) <= 2 * 1024 * 1024,
        "image_manifest_unavailable",
    )
    resolved = resolve_manifest(result.stdout, image["index_reference"])
    require(
        REPOSITORY + "@" + resolved["digest"] == image["image_reference"]
        and resolved["selection"] == image["selection"],
        "image_manifest_pin_mismatch",
    )
    output.write_bytes(result.stdout)


def image_from_output(encoded: object, context: Context) -> dict:
    # Native outputs are indexed by step in this exact successful Build GET.
    # Stay below even the original 4KiB output limit; reject truncation/garbage.
    require(
        isinstance(encoded, str) and 0 < len(encoded) <= 5500,
        "image_step_output_invalid",
    )
    raw = base64.b64decode(encoded, validate=True)
    require(len(raw) <= 4096, "image_step_output_oversized")
    report = json.loads(raw)
    require(
        isinstance(report, dict)
        and set(report) == {"schema", "context", "image"}
        and report["schema"] == "uat_frontend_image_handoff.v1"
        and report["context"] == asdict(context),
        "image_step_output_context_mismatch",
    )
    return validate_image(report["image"], context)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["wait", "pin", "collect"])
    for field in Context.__dataclass_fields__:
        parser.add_argument("--" + field.replace("_", "-"), required=True)
    parser.add_argument("--workspace", type=Path, default=Path("/workspace"))
    parser.add_argument("--backend-image", default="")
    parser.add_argument(
        "--legacy-exception", choices=["true", "false"], default="false"
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--proof-output", type=Path)
    parser.add_argument("--manifest-output", type=Path)
    args = parser.parse_args()
    try:
        context = Context(
            **{field: getattr(args, field) for field in Context.__dataclass_fields__}
        )
        if args.action == "wait":
            await_image(context, args.workspace, time.monotonic() + 1800)
        elif args.action == "pin":
            report = pin_image(context, args.workspace)
            raw = json.dumps(report, sort_keys=True).encode()
            require(len(raw) <= 4096, "image_step_output_oversized")
            # BUILDER_OUTPUT is supplied by Cloud Build, not a substitution.
            destination = os.environ.get("BUILDER_OUTPUT", "")
            require(
                bool(destination) and Path(destination).is_absolute(),
                "image_step_output_unavailable",
            )
            (Path(destination) / "output").write_bytes(raw)
        else:
            require(
                args.output is not None
                and args.proof_output is not None
                and args.manifest_output is not None,
                "image_output_missing",
            )
            deadline = time.monotonic() + 120
            image, proof = collect_image(
                context,
                args.backend_image,
                args.legacy_exception == "true",
                deadline,
            )
            collect_manifest(image, args.manifest_output, deadline)
            _write(args.output, image)
            _write(args.proof_output, proof)
            print(image["image_reference"])
    except (
        ReceiptError,
        binascii.Error,
        OSError,
        ValueError,
        TypeError,
        KeyError,
        AttributeError,
        subprocess.SubprocessError,
    ):
        # Cloud errors, registry contents and environment payloads stay private.
        print("UAT frontend image handoff failed closed.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
