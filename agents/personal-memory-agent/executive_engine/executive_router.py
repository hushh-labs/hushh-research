from executive_engine.executive_controller import executive_controller
from executive_engine.decision_arbitrator import decision_arbitrator
from executive_engine.strategy_supervisor import strategy_supervisor


def process_executive_reasoning(memories):

    executive_results = executive_controller(
        memories
    )

    arbitration_results = decision_arbitrator(
        memories
    )

    supervision_results = strategy_supervisor(
        memories
    )

    return {
        "executive_controller": executive_results,
        "decision_arbitration": arbitration_results,
        "strategy_supervision": supervision_results,
        "executive_state": "hierarchical-cognition-active"
    }