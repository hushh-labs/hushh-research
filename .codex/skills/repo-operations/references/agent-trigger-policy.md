# Repo Operations Trigger Policy

This reference defines when the `repo-operations` skill should trigger and when it should not.

## Trigger this skill for

1. failing CI or GitHub Actions questions
2. branch protection, merge queue, or PR freshness policy
3. UAT or production deployment work
4. Cloud Run, Cloud Build, runtime rollout, or rollback questions
5. env, secret, or parity verification
6. incident triage for delivery or runtime operations

## Do not trigger this skill for

1. design system or frontend component work
2. backend feature implementation without an ops question
3. GitHub board/project management work only
4. general coding questions with no delivery, CI, or operational surface

## Sub-agent policy

1. Default: no sub-agents.
2. Spawn sub-agents only when the user explicitly asks for delegation or parallel agent work.
3. If allowed, split by bounded operational domains, not overlapping edits.

## Good examples

1. “Why did UAT deploy fail?”
2. “Check main branch protection and merge queue.”
3. “Verify env parity for production rollout.”
4. “Is this PR blocked by freshness or by branch protection?”

## Bad examples

1. “Redesign the profile page”
2. “Refactor this React component”
3. “Create a GitHub board item”
