from optimization_engine.reasoning_optimizer import optimize_reasoning
from optimization_engine.strategy_refiner import refine_strategies
from optimization_engine.adaptation_tracker import track_adaptation


def process_recursive_optimization(memories):

    reasoning_results = optimize_reasoning(
        memories
    )

    strategy_results = refine_strategies(
        memories
    )

    adaptation_results = track_adaptation(
        reasoning_results,
        strategy_results
    )

    return {
        "reasoning_optimization": reasoning_results,
        "strategy_refinement": strategy_results,
        "adaptation_tracking": adaptation_results,
        "optimization_state": "recursive-cognition-active"
    }