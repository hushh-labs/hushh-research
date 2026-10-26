# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Stage an accepted phone-aware fallback using the primary's production bindings."""

from __future__ import annotations

import json
import re
import subprocess
import sys


def _value(command: list[str], key: str) -> str:
    values = [arg[len(key) + 1 :] for arg in command if arg.startswith(key + "=")]
    if len(values) != 1:
        raise ValueError("phone_fallback_template_flag_mismatch")
    return values[0]


def _pairs(value: str, separator: str) -> dict[str, str]:
    pairs = value.split(separator)
    if any("=" not in pair for pair in pairs):
        raise ValueError("phone_fallback_template_settings_invalid")
    result = dict(pair.split("=", 1) for pair in pairs)
    if len(result) != len(pairs):
        raise ValueError("phone_fallback_template_settings_duplicate")
    return result


def cold_command(command: list[str], *, sha: str, image: str) -> list[str]:
    """Keep production credentials/capacity intact; pin the cold reader's identity."""
    if (
        not re.fullmatch(r"[0-9a-f]{40}", sha)
        or not re.fullmatch(
            r"gcr\.io/hushh-pda/consent-protocol@sha256:[0-9a-f]{64}", image
        )
        or command[:4] != ["gcloud", "run", "deploy", "consent-protocol"]
        or "--no-traffic" not in command
        or _value(command, "--region") != "us-central1"
        or _value(command, "--command") != ""
        or _value(command, "--args") != ""
        or _value(command, "--service-account")
        != "consent-protocol-runtime@hushh-pda.iam.gserviceaccount.com"
    ):
        raise ValueError("phone_fallback_template_refused")
    tag = _value(command, "--tag")
    if not re.fullmatch(r"account-deletion-[1-9][0-9]*", tag):
        raise ValueError("phone_fallback_release_tag_invalid")
    env = _value(command, "--set-env-vars")
    if not env.startswith("^|^"):
        raise ValueError("phone_fallback_environment_encoding_invalid")
    settings = _pairs(env[3:], "|")
    labels = _pairs(_value(command, "--labels"), ",")
    if any(
        item.split("=", 1)[0] == "ACCOUNT_GENERATION_ADMISSION_ENABLED"
        for item in _value(command, "--set-secrets").split(",")
    ):
        raise ValueError("phone_fallback_generation_secret_unqualified")
    if (
        settings.get("HUSHH_DEPLOY_ENV") != "production"
        or settings.get("ENVIRONMENT") != "production"
        or settings.get("GOOGLE_CLOUD_PROJECT") != "hushh-pda"
        or settings.get("AUTH_PHONE_RECOVERY_ENABLED") not in {"true", "false"}
        or settings.get("ACCOUNT_GENERATION_ADMISSION_ENABLED", "false") != "false"
        or settings.get("HUSHH_DEPLOY_RUN_ID") != tag.removeprefix("account-deletion-")
        or labels.get("account-deletion-contract") != "v201"
    ):
        raise ValueError("phone_fallback_environment_identity_invalid")
    settings.update(
        HUSHH_DEPLOY_SHA=sha,
        HUSHH_DEPLOY_SOURCE="deploy-production-phone-rollback",
        AUTH_PHONE_RECOVERY_ENABLED="false",
        WORKOS_SSO_ENABLED="false",
    )
    labels.update(
        {"deploy-sha": sha, "deploy-source": "deploy-production-phone-rollback"}
    )
    replacements = {
        "--image": image,
        "--tag": tag.replace("account-deletion-", "phone-rollback-", 1),
        "--set-env-vars": "^|^"
        + "|".join(f"{key}={value}" for key, value in settings.items()),
        "--labels": ",".join(f"{key}={value}" for key, value in labels.items()),
    }
    for key in replacements:
        _value(command, key)
    if any(arg.startswith("--project") for arg in command):
        raise ValueError("phone_fallback_project_must_be_bound_by_helper")
    return [
        f"{arg.split('=', 1)[0]}={replacements[arg.split('=', 1)[0]]}"
        if arg.split("=", 1)[0] in replacements
        else arg
        for arg in command
    ] + ["--project=hushh-pda", "--quiet"]


def main() -> int:
    from revision_qualification import inspect_cold

    try:
        payload = sys.stdin.buffer.read(128 * 1024 + 1)
        if len(payload) > 128 * 1024:
            raise ValueError("phone_fallback_template_too_large")
        command = json.loads(payload)
        if not isinstance(command, list) or not all(
            isinstance(arg, str) for arg in command
        ):
            raise ValueError("phone_fallback_template_invalid")
        prepared = cold_command(command, sha=sys.argv[1], image=sys.argv[2])
        subprocess.run(prepared, check=True, timeout=480)  # noqa: S603
        # Qualify the actual immutable revision before creating any enabled
        # primary instance, whose public candidate tag can already receive calls.
        tag = _value(command, "--tag")
        inspect_cold(
            sha=sys.argv[1],
            image=sys.argv[2],
            run_id=tag.removeprefix("account-deletion-"),
        )
    except (ValueError, IndexError, OSError, subprocess.SubprocessError) as exc:
        print(f"Phone fallback staging refused: {type(exc).__name__}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
