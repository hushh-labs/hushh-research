def run_scenario(data):

    risk_triggered = False
    workflow_blocked = False

    if data.get("trust_score", 100) < 50:
        risk_triggered = True

    if not data.get("consent_active"):
        workflow_blocked = True

    return {
        "risk_triggered": risk_triggered,
        "workflow_blocked": workflow_blocked
    }