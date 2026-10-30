"""Pure settlement of a refused research dispatch; no budget/store authority."""

from typing import Any


def refund_refused_charge(
    state: dict[str, Any],
    charges: list[tuple[int, ...]],
    charged_start: float | None,
    *,
    rejected: bool,
):
    if not rejected:
        return state, ()
    last = charges[-1] if charges else ()
    recorded = (state.get("work") or {}).get("usage_records", {})
    if any(str(slot) in recorded for slot in last):
        # A downstream search refusal cannot refund completed query inference.
        return state, ()
    starts = state["starts"]
    if charged_start is not None and starts[-1:] == [charged_start]:
        starts = starts[:-1]
    return {
        **state,
        "starts": starts,
        "attempted_combinations": [
            index for index in state["attempted_combinations"] if index not in last
        ],
    }, last
