# Active-work status brief

Give the person enough evidence to decide whether work is advancing. Default to
four short lines; expand only when asked for an audit or handoff.

1. **Delivered:** describe the user-visible outcome and link its PR or receipt.
2. **Now:** state what is actually running, its stage, and the uncertainty it resolves.
3. **Measured:** give one or two relevant numbers with scope and observation time.
4. **Next / ETA:** show the next dependency, blocker if any, and a qualified estimate.

Use human descriptions before identifiers: “TestFlight tooling fix, PR #…” rather
than a list of SHAs. Distinguish source merged, deployed, and accepted. Historical
deployments remain dated evidence until their serving state is rechecked.

## Evidence and timing

- Read the existing task checkpoint and refresh current PR heads/run attempts before
  calling them green. Update that checkpoint; do not create a competing status log.
- Separate queue wait, runner execution, critical-path elapsed time and runner-minutes.
  Compare equivalent scopes, environments and cold/warm conditions. Label sample size.
- Say “not measured” when appropriate. A test count is not a coverage percentage;
  a source patch is not a measured speedup. Do not invent completion percentages.
- Estimate from remaining dependent stages and comparable observed runs. Parallel
  stages contribute their longest path, not their sum. Include approval/queue/provider
  uncertainty; give best/likely/worst only when there is evidence to support them.
- Recalculate when a failed stage changes the path. State why an earlier estimate
  moved. If the prerequisite is externally blocked, give the next checkpoint rather
  than a countdown that implies it will resolve by itself.

## Async queue

When asked, append a compact table: **lane | active result/stage | next dependency**.
Report actual running agents/jobs; distinguish active, waiting, ready and completed.
Completed child work is evidence awaiting integration until the parent verifies it.
Do not claim work continues after ending the turn unless a real retained job exists.

## Example

**Delivered:** [PR #123](https://github.com/example/repo/pull/123) removes duplicate setup; source checks passed.
**Now:** dependency review and exact-candidate CI run independently; deployment waits for both.
**Measured:** the last three comparable CI runs took 11–14 minutes; deployment gains are unmeasured.
**Next:** inspect terminal CI, merge, then verify the deployed result. ETA depends on the current queue.

Keep failures actionable and successes specific. Never hide an unresolved prerequisite
behind a green aggregate, an agent's conclusion, or a reassuring estimate.
