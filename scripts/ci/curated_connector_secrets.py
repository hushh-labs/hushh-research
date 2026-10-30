#!/usr/bin/env python3
"""Print the Secret Manager names every curated connector's OAuth client needs.

Reads consent-protocol/config/curated_connectors/*.json (the reviewed manifests)
and prints the client id variable, plus the client secret variable for providers
that have one, '+'-joined and sorted. Secret name == environment variable name,
so the deploy mounts each one under the name the runtime reads; there is no
per-provider wiring to add.

Standard library only (run by the deploy workflow before dependencies matter).
Full manifest validation lives in the backend tests; this reader is deliberately
strict about the two fields it depends on and fails on anything else odd.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

MANIFEST_DIR = Path(__file__).resolve().parents[2] / "consent-protocol" / "config" / "curated_connectors"
_NAME = re.compile(r"^[A-Z][A-Z0-9_]{1,127}$")


def secret_names(directory: Path = MANIFEST_DIR) -> list[str]:
    names: set[str] = set()
    for path in sorted(directory.glob("*.json")):
        try:
            oauth = json.loads(path.read_text(encoding="utf-8"))["oauth"]
            found = [oauth["clientIdEnv"]]
            if oauth.get("tokenEndpointAuth") != "none":
                found.append(oauth["clientSecretEnv"])
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise SystemExit(f"{path.name}: not a readable curated connector manifest ({error!r})")
        for name in found:
            if not isinstance(name, str) or not _NAME.match(name):
                raise SystemExit(f"{path.name}: {name!r} is not a valid secret name")
            names.add(name)
    return sorted(names)


def main() -> int:
    print("+".join(secret_names()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
