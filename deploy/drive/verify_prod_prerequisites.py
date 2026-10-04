#!/usr/bin/env python3
"""Fail closed before a production Drive candidate can receive traffic.

Only fixed production resources are inspected. Credential values stay in this
process and are never included in diagnostics or release artifacts.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import subprocess
from urllib.parse import urlsplit

PROJECT = "hushh-pda"
RUNTIME_ACCOUNT = "consent-protocol-runtime@hushh-pda.iam.gserviceaccount.com"
SCHEDULER_ACCOUNT = "drive-work-drain-sched@hushh-pda.iam.gserviceaccount.com"
PICKER_KEY_NAME = "Hussh Drive Picker (UAT + prod)"
SECRETS = (
    "GOOGLE_DRIVE_OAUTH_CLIENT_ID",
    "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET",
    "GOOGLE_DRIVE_PICKER_API_KEY",
    "EXTERNAL_CONNECTOR_CREDENTIAL_KEY",
    "DRIVE_DOCUMENT_KEY_V1",
    "DRIVE_SHARING_KEY_V1",
)


class PrerequisiteError(RuntimeError):
    """A diagnostic that never contains a credential or user identifier."""


def _gcloud(*args: str) -> str:
    result = subprocess.run(["gcloud", *args], capture_output=True, text=True)
    if result.returncode:
        raise PrerequisiteError("Production Drive prerequisite metadata is unavailable")
    return result.stdout


def _secret(name: str) -> str:
    try:
        metadata = json.loads(
            _gcloud(
                "secrets",
                "versions",
                "describe",
                "latest",
                f"--secret={name}",
                f"--project={PROJECT}",
                "--format=json",
            )
        )
        if metadata.get("state") != "ENABLED":
            raise PrerequisiteError(f"Production Drive secret {name} is not enabled")
        value = _gcloud(
            "secrets",
            "versions",
            "access",
            "latest",
            f"--secret={name}",
            f"--project={PROJECT}",
        ).strip()
    except (json.JSONDecodeError, PrerequisiteError) as exc:
        raise PrerequisiteError(
            f"Production Drive secret {name} is unavailable"
        ) from exc
    if not value:
        raise PrerequisiteError(f"Production Drive secret {name} is empty")
    return value


def _key_bytes(value: str, *, urlsafe: bool) -> bytes:
    try:
        if urlsafe:
            return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise PrerequisiteError(
            "Production Drive encryption key has invalid encoding"
        ) from exc


def verify(*, oauth_attested: bool) -> None:
    if not oauth_attested:
        raise PrerequisiteError(
            "Production Google Auth Platform Drive scope and exact callback attestation is missing"
        )
    values = {name: _secret(name) for name in SECRETS}
    if not values["GOOGLE_DRIVE_OAUTH_CLIENT_ID"].endswith(
        ".apps.googleusercontent.com"
    ):
        raise PrerequisiteError("Production Drive OAuth client ID is malformed")
    document_key = _key_bytes(values["DRIVE_DOCUMENT_KEY_V1"], urlsafe=False)
    sharing_key = _key_bytes(values["DRIVE_SHARING_KEY_V1"], urlsafe=False)
    if len(document_key) != 32:
        raise PrerequisiteError("Production Drive document key must be 32 bytes")
    if len(sharing_key) != 32:
        raise PrerequisiteError("Production Drive sharing key must be 32 bytes")
    if document_key == sharing_key:
        raise PrerequisiteError(
            "Production Drive document and sharing keys must be distinct"
        )
    connector_key = values["EXTERNAL_CONNECTOR_CREDENTIAL_KEY"]
    try:
        decoded_connector_key = _key_bytes(connector_key, urlsafe=True)
    except PrerequisiteError:
        decoded_connector_key = b""
    if len(decoded_connector_key) not in {16, 24, 32} and len(
        connector_key.encode()
    ) not in {16, 24, 32}:
        raise PrerequisiteError(
            "Production connector credential key has invalid length"
        )

    keys = json.loads(
        _gcloud("services", "api-keys", "list", f"--project={PROJECT}", "--format=json")
    )
    matching = [item for item in keys if item.get("displayName") == PICKER_KEY_NAME]
    if len(matching) != 1:
        raise PrerequisiteError("Reviewed production Drive Picker API key is missing")
    key = matching[0]
    restrictions = key.get("restrictions") or {}
    targets = restrictions.get("apiTargets") or []
    referrers = (restrictions.get("browserKeyRestrictions") or {}).get(
        "allowedReferrers"
    ) or []
    if {target.get("service") for target in targets} != {
        "picker.googleapis.com"
    } or not any(urlsplit(ref).hostname == "one.hushh.ai" for ref in referrers):
        raise PrerequisiteError(
            "Production Drive Picker API key restrictions are incomplete"
        )
    key_string = json.loads(
        _gcloud(
            "services",
            "api-keys",
            "get-key-string",
            key["name"],
            f"--project={PROJECT}",
            "--format=json",
        )
    ).get("keyString")
    if key_string != values["GOOGLE_DRIVE_PICKER_API_KEY"]:
        raise PrerequisiteError(
            "Production Drive Picker secret does not match the reviewed API key"
        )

    for account in (RUNTIME_ACCOUNT, SCHEDULER_ACCOUNT):
        _gcloud("iam", "service-accounts", "describe", account, f"--project={PROJECT}")
    policy = json.loads(_gcloud("projects", "get-iam-policy", PROJECT, "--format=json"))
    member = f"serviceAccount:{RUNTIME_ACCOUNT}"
    if not any(
        item.get("role") == "roles/cloudscheduler.jobRunner"
        and member in (item.get("members") or [])
        and not item.get("condition")
        for item in policy.get("bindings", [])
    ):
        raise PrerequisiteError(
            "Production Drive prompt-wake Scheduler run grant is missing"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--oauth-attested", action="store_true")
    args = parser.parse_args()
    if args.project != PROJECT:
        parser.error("Production Drive preflight requires the fixed production project")
    try:
        verify(oauth_attested=args.oauth_attested)
    except (KeyError, TypeError, ValueError, PrerequisiteError) as exc:
        parser.exit(1, f"Production Drive preflight blocked: {exc}\n")
    print(
        "Production Drive credentials, Picker restrictions and scheduler identities verified"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
