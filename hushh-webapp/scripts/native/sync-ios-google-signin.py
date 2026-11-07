#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Keep iOS Google sign-in bound to the selected native Firebase configuration."""

import os
from pathlib import Path
import plistlib
import re
import stat
import sys
import tempfile


def sync(source: Path, destination: Path) -> bool:
    firebase = plistlib.loads(source.read_bytes())
    info = plistlib.loads(destination.read_bytes())
    client = firebase.get("CLIENT_ID")
    scheme = firebase.get("REVERSED_CLIENT_ID")
    if (
        not isinstance(client, str)
        or not re.fullmatch(r"[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com", client)
        or scheme != ".".join(reversed(client.split(".")))
    ):
        raise ValueError("Missing or inconsistent Google client configuration.")
    types = info.get("CFBundleURLTypes")
    if not isinstance(info.get("GIDClientID"), str) or not isinstance(types, list):
        raise ValueError("Canonical iOS Google client declaration is missing.")
    google = []
    for entry in types:
        schemes = entry.get("CFBundleURLSchemes") if isinstance(entry, dict) else None
        if not isinstance(schemes, list) or any(
            not isinstance(s, str) for s in schemes
        ):
            raise ValueError("Invalid iOS callback scheme declaration.")
        google.extend(
            (schemes, index)
            for index, value in enumerate(schemes)
            if value.startswith("com.googleusercontent.apps.")
        )
    if len(google) != 1:
        raise ValueError("Expected exactly one iOS Google callback scheme.")
    schemes, index = google[0]
    if info["GIDClientID"] == client and schemes[index] == scheme:
        return False
    info["GIDClientID"] = client
    schemes[index] = scheme
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=destination.parent, prefix=".google-signin-", delete=False
        ) as output:
            temporary = Path(output.name)
            output.write(plistlib.dumps(info, sort_keys=False))
        temporary.chmod(stat.S_IMODE(destination.stat().st_mode))
        os.replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return True


if __name__ == "__main__":
    try:
        print("updated" if sync(Path(sys.argv[1]), Path(sys.argv[2])) else "current")
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, plistlib.InvalidFileException, TypeError, AttributeError) as error:
        print(
            f"Cannot synchronize iOS Google sign-in ({type(error).__name__}).",
            file=sys.stderr,
        )
        sys.exit(1)
