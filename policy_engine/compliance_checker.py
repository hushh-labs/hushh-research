from policy_rules import POLICY_RULES


def check_compliance(data):

    compliant = True

    if data.get("trust_score", 0) < POLICY_RULES["min_trust_score"]:
        compliant = False

    if not data.get("consent_valid"):
        compliant = False

    if data.get("pii_detected"):
        compliant = False

    return {
        "policy_compliant": compliant
    }