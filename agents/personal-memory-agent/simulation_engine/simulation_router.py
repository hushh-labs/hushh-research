from simulation_engine.scenario_generator import generate_scenarios
from simulation_engine.outcome_simulator import simulate_outcomes
from simulation_engine.impact_evaluator import evaluate_impact


def process_simulation(memories):

    scenarios = generate_scenarios(
        memories
    )

    outcomes = simulate_outcomes(
        scenarios
    )

    impact_results = evaluate_impact(
        outcomes
    )

    return {
        "generated_scenarios": scenarios,
        "simulated_outcomes": outcomes,
        "impact_evaluation": impact_results,
        "simulation_state": "counterfactual-cognition-active"
    }