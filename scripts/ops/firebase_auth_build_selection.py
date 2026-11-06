#!/usr/bin/env python3
"""Read a qualified Auth selection for web builds; never changes live authority.

No selection preserves the current client configuration. Isolated selection
requires all four public SDK values and the same environment-owned project.
Credentials and user exports are never emitted or written by this helper.
"""
from __future__ import annotations

import argparse
import json
import subprocess
from collections.abc import Callable
from pathlib import Path

AUTH_FIELDS = {
    "apiKey": "NEXT_PUBLIC_AUTH_FIREBASE_API_KEY",
    "authDomain": "NEXT_PUBLIC_AUTH_FIREBASE_AUTH_DOMAIN",
    "projectId": "NEXT_PUBLIC_AUTH_FIREBASE_PROJECT_ID",
    "appId": "NEXT_PUBLIC_AUTH_FIREBASE_APP_ID",
}
PROJECTS = {"dev": "hushh-pda-dev", "uat": "hushh-pda-uat", "production": "hushh-pda"}


def select_auth_config(project: str, runtime: dict, read: Callable[[str], str]) -> dict[str, str]:
    selected = runtime.get("firebase_auth_project_id")
    if selected is None:
        return {}
    environment = runtime.get("environment")
    if (selected != project or not isinstance(environment, str) or PROJECTS.get(environment) != project
            or runtime.get("google_cloud_project") != project):
        raise ValueError("Firebase Auth selection belongs to a different environment")
    values = {key: read(name).strip() for key, name in AUTH_FIELDS.items()}
    if not all(values.values()) or values["projectId"] != selected:
        raise ValueError("Firebase Auth selection is incomplete or inconsistent")
    return values


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--prefix", default="")
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()

    def read(name: str) -> str:
        result = subprocess.run([
            "gcloud", "secrets", "versions", "access", "latest",
            "--project=" + args.project, "--secret=" + args.prefix + name,
        ], capture_output=True, text=True, timeout=30)
        if result.returncode:
            raise RuntimeError("Firebase Auth build configuration is unavailable")
        return result.stdout.strip()

    runtime = json.loads(read("BACKEND_RUNTIME_CONFIG_JSON"))
    if not isinstance(runtime, dict):
        raise ValueError("Firebase Auth runtime configuration is invalid")
    values = select_auth_config(args.project, runtime, read)
    if args.output_dir:
        args.output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        for key, name in AUTH_FIELDS.items():
            output = args.output_dir / name
            output.write_text(values.get(key, ""))
            output.chmod(0o600)
        print(json.dumps({"isolated_auth_selected": bool(values)}))
    else:
        print(json.dumps(values))


if __name__ == "__main__":
    main()
