#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Validate a browser-safe UAT Logo.dev template from stdin without echoing it."""

from __future__ import annotations

import re
import sys


def main() -> int:
    value = sys.stdin.read(2049)
    if len(value) > 2048 or not re.fullmatch(
        r"https://img\.logo\.dev/\{domain\}\?token=pk_[A-Za-z0-9_-]+"
        r"&fallback=404&redirect=404",
        value,
    ):
        sys.stderr.write(
            "Invalid public receipt-logo template: require the reviewed Logo.dev "
            "publishable URL with fallback=404 and redirect=404.\n"
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
