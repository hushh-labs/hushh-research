def parse_goal(goal_text):

    goal_data = {
        "goal": goal_text,
        "goal_length": len(goal_text.split()),
        "priority": "medium"
    }

    if "AI" in goal_text or "agent" in goal_text:

        goal_data["priority"] = "high"

    return goal_data