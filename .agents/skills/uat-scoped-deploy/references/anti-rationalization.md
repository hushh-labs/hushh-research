# uat-scoped-deploy — Anti-Rationalization Table

| Rationalization | Reality |
|---|---|
| "I can force a scope from the latest diff" | Default `scope=auto` compares the target SHA with each deployed service baseline, including accumulated lag. Force a scope only with complete target-to-deployed-service delta proof; an automatic resolution to `all` is valid. |
| "The service is in the usual region" | "Describing Cloud Run services with an assumed region" — region is discovered per deploy, never assumed. Provenance evidence includes the discovered region. |
| "The build is queued, so the deploy is done" | "Treating queued or in-progress deploys as complete" — only terminal state with timing proof counts. Queued is not deployed. |
| "It deployed fine, I watched the console" | "Reporting deploy success without revision, label, traffic, or log evidence" — success claims carry revision + label + traffic split + log evidence, or they are not claims. |
| "Same commit deployed to UAT yesterday" | Yesterday's deploy proves yesterday's build inputs. Env parity, secrets, and base images drift; each dispatch gets fresh provenance. |
| "Admin means I can deploy a green PR SHA" | Admin may bypass the merge queue only through the canonical Admin PR landing gate and exact-head merge; UAT still requires landed `main` and successful `Main Post-Merge Smoke`. |

## Red Flags

- A deploy report missing any of: revision, region discovery, traffic state, timing proof
- a forced scope selected from only the latest diff instead of the deployed-service baselines
- A success claim posted while Cloud Build state was still non-terminal
