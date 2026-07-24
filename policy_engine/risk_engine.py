def calculate_risk(data):

    risk = 0

    if data.get("pii_detected"):
        risk += 50

    if not data.get("consent_valid"):
        risk += 30

    if data.get("trust_score", 0) < 70:
        risk += 20

    return {
        "risk_score": risk
    }