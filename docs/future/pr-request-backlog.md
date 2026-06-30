# PR Request Governance

> Planning-only governance note for PR request workflows, idea capture boundaries, and project execution queues.

## Status

This page is a **planning-only governance note**. Executable backlog items and active task lists are managed dynamically in the canonical repository project board and issue tracker rather than static markdown files.

## Visual Context

This governance note inherits its documentation placement model from the [Documentation Architecture Map](../reference/operations/documentation-architecture-map.md) and the future-roadmap boundary from [Hussh Future Roadmap](./README.md).

## Task Intake & Backlog Boundary

To avoid stale documentation competing with the issue-backed planning board and PR-train governance records, do not store lists of raw, executable coding tasks in static markdown backlogs.

When seeding or staging PR requests:
1. **GitHub Issues & Boards**: Move all executable, trackable tickets or backlog items directly to the project issue tracker.
2. **Reuse Existing Contracts**: Each request must leverage existing repository patterns; do not define redundant voice models, alternate consent paths, or parallel database layers.
3. **Validate Prior Work**: Before opening an implementation branch, cross-verify the current source of truth in code, generated contracts, and active tests.

## Promotion Checklist

Before creating a new pull request or promoting a task from the board to execution:

1. **Verify Target Paths**: Confirm the target path and check current implementation files to avoid duplicate work.
2. **Duplicate Search**: Search active PRs and issues for exact or semantic duplicates.
3. **Single Responsibility**: Restrict each branch to a single, coherent feature boundary or documented task.
4. **DCO Compliance**: Ensure Developer Certificate of Origin (`Signed-off-by`) signatures are present on every commit.
5. **Traceability**: Link the specific planning ticket or issue being resolved in the PR description.
