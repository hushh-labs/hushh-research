"""Validate supplied account observations without deriving a balance timeline."""

import math
from datetime import date
from typing import Any


def normalize_balance_history(value: Any) -> list[dict[str, Any]]:
    observed: dict[str, float] = {}
    for row in value if isinstance(value, list) else []:
        if not isinstance(row, dict):
            continue
        day, amount = row.get("date"), row.get("value")
        if not isinstance(day, str) or len(day) != 10:
            continue
        try:
            if date.fromisoformat(day).isoformat() != day:
                continue
        except ValueError:
            continue
        if isinstance(amount, bool) or not isinstance(amount, (int, float)):
            continue
        if math.isfinite(amount):
            observed[day] = float(amount)
    return [{"date": day, "value": observed[day]} for day in sorted(observed)]
