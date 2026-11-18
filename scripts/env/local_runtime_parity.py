#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Maintainable helpers for local runtime env normalization and proxy credentials."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
NORMALIZED_JSON_KEYS = frozenset(
    {
        "FIREBASE_ADMIN_CREDENTIALS_JSON",
        "FIREBASE_AUTH_VERIFIER_CREDENTIALS_JSON",
        "BACKEND_RUNTIME_CONFIG_JSON",
        "CONSENT_ED25519_PUBLIC_KEYS",
        "CONSENT_AUDIT_ED25519_PUBLIC_KEYS",
        "OWNER_FEED_ED25519_PUBLIC_KEYS",
    }
)
ED25519_PAIRING_SPECS = (
    (
        "CONSENT_TOKEN_SIGNING_ALG",
        "CONSENT_ED25519_PRIVATE_KEY",
        "CONSENT_ED25519_PUBLIC_KEYS",
    ),
    (
        "CONSENT_AUDIT_SIGNING_ALG",
        "CONSENT_AUDIT_ED25519_PRIVATE_KEY",
        "CONSENT_AUDIT_ED25519_PUBLIC_KEYS",
    ),
)


def _is_placeholder(value: str) -> bool:
    stripped = value.strip()
    if not stripped:
        return True
    if stripped.startswith("__") and stripped.endswith("__"):
        return True
    lower = stripped.lower()
    return (
        lower.startswith(("replace_with_", "dummy-"))
        or "replace_with_" in lower
        or lower == "changeme"
    )


def _read_env_map(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        if not raw_line or raw_line.lstrip().startswith("#") or "=" not in raw_line:
            continue
        key, value = raw_line.split("=", 1)
        if not ASSIGN_RE.match(raw_line):
            continue
        cleaned = value.strip()
        if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in {"'", '"'}:
            cleaned = cleaned[1:-1]
        values[key] = cleaned
    return values


def normalize_json_env_file(path: Path) -> None:
    if not path.is_file():
        return
    lines = path.read_text(encoding="utf-8").splitlines()
    decoder = json.JSONDecoder()
    output: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        matched = next((k for k in NORMALIZED_JSON_KEYS if line.startswith(f"{k}=")), None)
        if not matched:
            output.append(line)
            index += 1
            continue
        prefix = f"{matched}="
        buf = line[len(prefix) :]
        cursor = index
        normalized: str | None = None
        while True:
            try:
                parsed, _ = decoder.raw_decode(buf)
                if isinstance(parsed, dict):
                    normalized = json.dumps(parsed, separators=(",", ":"))
                break
            except json.JSONDecodeError:
                cursor += 1
                if cursor >= len(lines):
                    break
                buf += "\n" + lines[cursor]
        if normalized is None:
            output.append(line)
            index += 1
            continue
        output.append(prefix + normalized)
        index = cursor + 1
        while index < len(lines):
            nxt = lines[index]
            if ASSIGN_RE.match(nxt) or nxt.startswith("#") or not nxt.strip():
                break
            index += 1
    path.write_text("\n".join(output) + "\n", encoding="utf-8")


def enforce_ed25519_pairings(path: Path) -> None:
    if not path.is_file():
        return
    values = _read_env_map(path)
    clear_keys = {
        alg_key
        for alg_key, priv_key, pub_key in ED25519_PAIRING_SPECS
        if values.get(alg_key, "").strip().lower() == "ed25519"
        and (_is_placeholder(values.get(priv_key, "")) or _is_placeholder(values.get(pub_key, "")))
    }
    if not clear_keys:
        return
    lines = path.read_text(encoding="utf-8").splitlines()
    updated = [
        f"{line.split('=', 1)[0]}=" if ("=" in line and line.split("=", 1)[0] in clear_keys) else line
        for line in lines
    ]
    path.write_text("\n".join(updated) + "\n", encoding="utf-8")


def _default_adc_path() -> Path:
    explicit = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    sdk_config = os.environ.get("CLOUDSDK_CONFIG", "").strip()
    base = Path(sdk_config).expanduser() if sdk_config else (Path.home() / ".config" / "gcloud")
    return base / "application_default_credentials.json"


def resolve_proxy_credentials(
    env_file: Path, *, materialize_temp: Path | None = None, check_only: bool = False
) -> tuple[int, str, str]:
    values = _read_env_map(env_file)
    explicit = values.get("CLOUDSQL_PROXY_CREDENTIALS_FILE", "").strip()
    if explicit and not _is_placeholder(explicit):
        explicit_path = Path(explicit).expanduser()
        if not explicit_path.is_file():
            msg = f"Cloud SQL proxy credentials file not found: {explicit_path}"
            return 1, f"fail|{msg}", msg
        return 0, "pass|CLOUDSQL_PROXY_CREDENTIALS_FILE is present for proxy auth", str(explicit_path)

    raw_json = values.get("FIREBASE_ADMIN_CREDENTIALS_JSON", "").strip()
    if not raw_json or _is_placeholder(raw_json):
        msg = "local requires Cloud SQL proxy credentials from FIREBASE_ADMIN_CREDENTIALS_JSON or CLOUDSQL_PROXY_CREDENTIALS_FILE."
        return 1, "fail|FIREBASE_ADMIN_CREDENTIALS_JSON or CLOUDSQL_PROXY_CREDENTIALS_FILE is missing", msg

    try:
        payload = json.loads(raw_json)
    except json.JSONDecodeError:
        msg = "FIREBASE_ADMIN_CREDENTIALS_JSON is not valid JSON for Cloud SQL proxy credentials."
        return 1, f"fail|{msg}", msg
    if not isinstance(payload, dict):
        msg = "FIREBASE_ADMIN_CREDENTIALS_JSON must be a JSON object."
        return 1, f"fail|{msg}", msg

    client_email = str(payload.get("client_email") or "").strip()
    if client_email.startswith("firebase-sdk-"):
        adc_path = _default_adc_path()
        if adc_path.is_file():
            detail = "Application Default Credentials available for least-privilege Firebase project proxy auth"
            return 0, f"pass|{detail}", str(adc_path)
        msg = (
            f"FIREBASE_ADMIN_CREDENTIALS_JSON uses least-privilege {client_email} without Cloud SQL access "
            "and no ADC file was found; run 'gcloud auth application-default login' or set CLOUDSQL_PROXY_CREDENTIALS_FILE"
        )
        return 1, f"fail|{msg}", msg

    if check_only:
        return 0, "pass|FIREBASE_ADMIN_CREDENTIALS_JSON is present for proxy auth", ""
    if materialize_temp is not None:
        materialize_temp.write_text(json.dumps(payload), encoding="utf-8")
        os.chmod(materialize_temp, 0o600)
        return 0, "", str(materialize_temp)
    return 0, "pass|FIREBASE_ADMIN_CREDENTIALS_JSON is present for proxy auth", ""


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    norm = subparsers.add_parser("normalize-json")
    norm.add_argument("env_file", type=Path)
    ed = subparsers.add_parser("enforce-ed25519-pairings")
    ed.add_argument("env_file", type=Path)
    proxy = subparsers.add_parser("resolve-proxy-credentials")
    proxy.add_argument("--env-file", type=Path, required=True)
    proxy.add_argument("--materialize-temp", type=Path, default=None)
    proxy.add_argument("--check-only", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command == "normalize-json":
        normalize_json_env_file(args.env_file)
        return 0
    if args.command == "enforce-ed25519-pairings":
        enforce_ed25519_pairings(args.env_file)
        return 0
    code, status_line, output = resolve_proxy_credentials(
        args.env_file, materialize_temp=args.materialize_temp, check_only=args.check_only
    )
    if args.check_only:
        print(status_line)
        return code
    if code != 0:
        print(output, file=sys.stderr)
        return code
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
