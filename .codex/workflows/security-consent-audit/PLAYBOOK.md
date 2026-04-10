# Security Consent Audit

Use this workflow pack when the task matches `security-consent-audit`.

## Goal

Audit IAM, consent, vault, PKM, and delegated access boundaries against Hushh trust invariants.

## Steps

1. Start with `security-audit` and use `iam-consent-governance` as the default narrow path.
2. Open only the required reads listed in `workflow.json` plus the selected skill manifests.
3. Run the required commands first, then the verification bundle.
4. Capture every field listed in `impact_fields` before calling the work complete.
5. Escalate through `handoff_chain` when the task crosses domain boundaries.

## Common Drift Risks

1. treating signed-in as consent
2. allowing delegated scope escalation
3. ignoring vault or PKM boundary docs
