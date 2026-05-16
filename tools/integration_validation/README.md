\# Runtime Integration Validation Framework



This tool validates runtime integrations and environment readiness

before application startup.



\## Features



\- Environment variable validation

\- Workflow registry validation

\- Runtime service health checks

\- Structured PASS/FAIL reporting

\- CI/CD-friendly execution

\- Failure visibility for debugging



\## Validation Checks



\### Environment Validation

Checks required runtime variables:

\- OPENAI\_API\_KEY

\- DATABASE\_URL

\- REDIS\_URL



\### Workflow Validation

Ensures workflow registry loads correctly.



\### Service Validation

Verifies runtime services are reachable.



\## Usage



```bash

python tools/integration\_validation/run\_all\_checks.py

```



\## Example Output



```text

\[PASS] Workflow registry loaded

\[FAIL] OPENAI\_API\_KEY is missing

```



\## Exit Behavior



\- Returns exit code `0` when all checks pass

\- Returns exit code `1` when validation fails

