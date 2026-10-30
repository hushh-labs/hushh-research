# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
FROM gcr.io/google.com/cloudsdktool/google-cloud-cli@sha256:d3f74bb21280869467e4e901c66280d4610e0bda81bab1cd7d9c112ccd1d2276
WORKDIR /app
COPY config/protected-lists.json config/protected-lists.json
COPY scripts/ops/verify_secret_list_invariants.py scripts/ops/verify_secret_list_invariants.py
COPY scripts/ci/process_group.py scripts/ci/process_group.py
COPY deploy/observability/auth_health_job.py deploy/observability/auth_health_job.py
COPY deploy/observability/auth_health_read_diagnostics.py deploy/observability/auth_health_read_diagnostics.py
ENV CLOUDSDK_CONFIG=/tmp/auth-health-gcloud
USER 1000:1000
ENTRYPOINT ["/usr/lib/google-cloud-sdk/platform/bundledpythonunix/bin/python3", "/app/deploy/observability/auth_health_job.py"]
