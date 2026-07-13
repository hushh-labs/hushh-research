# uat-scoped-deploy — Anti-Rationalization Table

| Rationalization | Reality |
|---|---|
| "scope=all is simpler than picking a scope" | "Using scope=all for frontend-only or backend-only changes" is failure #1 in this lane's workflow. Scoped deploys exist to shrink blast radius and timing surface; all-scope on a one-sided change is unforced risk. |
| "The service is in the usual region" | "Describing Cloud Run services with an assumed region" — region is discovered per deploy, never assumed. Provenance evidence includes the discovered region. |
| "The build is queued, so the deploy is done" | "Treating queued or in-progress deploys as complete" — only terminal state with timing proof counts. Queued is not deployed. |
| "It deployed fine, I watched the console" | "Reporting deploy success without revision, label, traffic, or log evidence" — success claims carry revision + label + traffic split + log evidence, or they are not claims. |
| "Same commit deployed to UAT yesterday" | Yesterday's deploy proves yesterday's build inputs. Env parity, secrets, and base images drift; each dispatch gets fresh provenance. |
| "Admin means I can deploy a green PR SHA" | Admin authority still requires merge queue, landed `main`, and successful `Main Post-Merge Smoke`; UAT never deploys an unmerged PR SHA. |

## Red Flags

- A deploy report missing any of: revision, region discovery, traffic state, timing proof
- scope=all used where the diff touches only one surface
- A success claim posted while Cloud Build state was still non-terminal
