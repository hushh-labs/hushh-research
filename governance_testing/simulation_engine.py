from scenario_runner import run_scenario
from validation_tester import validate_workflow


def simulate_governance(data):

    scenario_result = run_scenario(data)

    validation_result = validate_workflow(
        scenario_result
    )

    return {
        "simulation_completed": True,
        "scenario_result": scenario_result,
        "validation_result": validation_result
    }