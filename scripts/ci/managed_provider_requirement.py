#!/usr/bin/env python3
"""Whether a failed provider check already decides this release's readiness.

The aggregate accepts a provider only when its check exited 0, so a failed check
of the provider that readiness requires has already decided the verdict. That
provider's step can then end the build at once, instead of leaving the aggregate
to report it after every other step finishes. Exit 0 means required, 1 means not
required; any other exit leaves the verdict to the aggregate, as before.
"""

from __future__ import annotations

import argparse
import json
import os

import managed_provider_readiness as readiness

CONFIG = readiness.ROOT / "consent-protocol/config/managed-ai-runtime.json"


def decides_release(provider: str, environment: str, *, document: dict | None = None) -> bool:
    """Only UAT's aggregate selects a provider; other lanes keep their own step gate."""
    if environment != "uat":
        return False
    document = json.loads(CONFIG.read_text()) if document is None else document
    return readiness.configured_provider(document) == provider


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", required=True, choices=sorted(readiness.PROVIDERS))
    args = parser.parse_args()
    return 0 if decides_release(args.provider, os.environ["READINESS_ENVIRONMENT"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
