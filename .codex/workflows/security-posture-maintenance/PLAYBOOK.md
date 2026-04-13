# Security Posture Maintenance

Use this workflow pack when the task matches `security-posture-maintenance`.

## Goal

Review live GitHub security drift and Codex-system integrity on a recurring cadence without waiting for a feature PR to surface aged backlog.

## Steps

1. Start with `security-audit` and treat GitHub alert state plus Codex audit state as one maintenance surface.
2. Run only the maintenance-safe commands listed in `workflow.json`; do not expand into feature or incident work unless the findings require it.
3. Update the rolling maintenance issue after every unattended run so the backlog stays visible.
4. Escalate through `handoff_chain` when the findings move from security posture into repo operations, docs, or skill-system drift.

## Common Drift Risks

1. letting open high-severity backlog age outside normal PR traffic
2. treating workflow drift as separate from security posture
3. running scheduled maintenance without updating the rolling issue
