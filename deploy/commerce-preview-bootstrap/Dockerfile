# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
FROM python:3.13-slim
WORKDIR /bootstrap
COPY responder.py ./responder.py
USER 65532:65532
EXPOSE 8080
CMD ["python", "responder.py"]
