# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Import-safe command-line options for the capacity admission entrypoint."""

from __future__ import annotations

import argparse
from pathlib import Path


def parse_args(
    description: str | None, phases: tuple[str, ...], default_profile: Path
) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--environment", choices=("uat", "production"), required=True)
    parser.add_argument(
        "--phase",
        choices=phases,
        default="pre-deploy",
        help="Reserve the next deployment candidate, or check only retained capacity",
    )
    parser.add_argument("--profile", type=Path, default=default_profile)
    parser.add_argument(
        "--additional-candidate-service", action="append", default=[],
        help="Also reserve one independent production fallback revision of this service",
    )
    candidates = parser.add_mutually_exclusive_group()
    candidates.add_argument(
        "--candidate-service",
        action="append",
        help="Reserve a new revision of this service (repeat for each deployed service)",
    )
    candidates.add_argument(
        "--inherit-candidate-service",
        action="append",
        help="Reserve a candidate inheriting this live service's template (repeatable)",
    )
    candidates.add_argument(
        "--no-candidates",
        action="store_true",
        help="Audit the global database budget without reserving a new service revision",
    )
    candidates.add_argument(
        "--frontend-only",
        action="store_true",
        help="Verify UAT web service has zero incremental SQL demand without auditing unrelated jobs",
    )
    parser.add_argument(
        "--frontend-revision",
        help="Also verify this exact frontend candidate revision before traffic promotion",
    )
    parser.add_argument(
        "--report-only",
        action="store_true",
        help="Report an over-budget result without a nonzero exit",
    )
    parser.add_argument("--output", choices=("text", "json"), default="text")
    return parser.parse_args()
