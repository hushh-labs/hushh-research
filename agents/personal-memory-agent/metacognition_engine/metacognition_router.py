from metacognition_engine.confidence_analyzer import analyze_confidence
from metacognition_engine.reasoning_evaluator import evaluate_reasoning
from metacognition_engine.feedback_optimizer import optimize_feedback


def process_metacognition(memories):

    confidence_results = analyze_confidence(
        memories
    )

    reasoning_results = evaluate_reasoning(
        memories
    )

    optimization_results = optimize_feedback(
        confidence_results,
        reasoning_results
    )

    return {
        "confidence_analysis": confidence_results,
        "reasoning_evaluation": reasoning_results,
        "feedback_optimization": optimization_results
    }