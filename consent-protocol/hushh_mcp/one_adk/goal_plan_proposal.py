"""Typed Chat proposal for an owner-reviewed goal and its task steps."""


def propose_goal_plan(title: str, outcome: str, steps: list[str], category: str = "") -> dict:
    """Draft a goal when the person wants to plan or create one in Chat.

    Use a concise title, an observable outcome, and up to eight concrete task
    steps. Category is optional. Leave steps empty if they are unknown. Open a
    review for the owner to edit and save. Say the plan is ready for review.
    This tool saves and schedules nothing. Do not claim a goal or task exists
    until the owner has saved it. For an explicit private Files scheduling
    request, offer its separate review through propose_file_schedule if available.
    """
    if (
        not isinstance(title, str)
        or not title.strip()
        or len(title) > 240
        or not isinstance(outcome, str)
        or not outcome.strip()
        or len(outcome) > 4_000
        or not isinstance(category, str)
        or len(category) > 80
        or not isinstance(steps, list)
        or len(steps) > 8
        or any(not isinstance(step, str) or not step.strip() or len(step) > 240 for step in steps)
    ):
        return {"status": "invalid_proposal"}
    return {
        "status": "proposal_ready",
        "type": "goals.plan",
        "title": title.strip(),
        "outcome": outcome.strip(),
        "category": category.strip() or None,
        "steps": [step.strip() for step in steps],
    }
