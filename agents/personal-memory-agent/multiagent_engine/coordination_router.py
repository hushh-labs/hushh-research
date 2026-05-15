from multiagent_engine.planner_agent import planner_agent
from multiagent_engine.reflection_agent import reflection_agent
from multiagent_engine.forecast_agent import forecast_agent


def process_multiagent_coordination(memories):

    planner_results = planner_agent(
        memories
    )

    reflection_results = reflection_agent(
        memories
    )

    forecast_results = forecast_agent(
        memories
    )

    return {
        "planner_agent": planner_results,
        "reflection_agent": reflection_results,
        "forecast_agent": forecast_results,
        "coordination_state": "distributed-cognition-active"
    }