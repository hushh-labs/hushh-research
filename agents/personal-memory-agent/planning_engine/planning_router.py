from planning_engine.goal_parser import parse_goal
from planning_engine.task_generator import generate_tasks
from planning_engine.priority_planner import prioritize_tasks


def process_goal(goal_text):

    parsed_goal = parse_goal(goal_text)

    generated_tasks = generate_tasks(parsed_goal)

    prioritized_tasks = prioritize_tasks(
        generated_tasks
    )

    return {
        "goal_analysis": parsed_goal,
        "generated_tasks": generated_tasks,
        "priority_plan": prioritized_tasks
    }