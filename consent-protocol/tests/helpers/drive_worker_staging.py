"""Production worker shape shared by the staging admission contracts."""


def existing_worker_revision(*, name: str, image: str, runtime: str, scanner_index: str) -> dict:
    return {
        "metadata": {
            "name": name,
            "uid": "old-uid",
            "creationTimestamp": "2026-10-27T00:00:00Z",
            "labels": {"deploy-sha": "b" * 40},
            "annotations": {
                "autoscaling.knative.dev/maxScale": "2",
                "run.googleapis.com/cloudsql-instances": "hushh-pda:us-central1:hushh-vault-db",
            },
        },
        "spec": {
            "containerConcurrency": 1,
            "timeoutSeconds": 240,
            "serviceAccountName": runtime,
            "containers": [
                {
                    "name": "drive-worker",
                    "image": image,
                    "command": ["gunicorn"],
                    "args": [
                        "server_drive_worker:app",
                        "-w",
                        "1",
                        "-k",
                        "uvicorn.workers.UvicornWorker",
                        "--timeout",
                        "220",
                        "--worker-tmp-dir",
                        "/tmp",  # noqa: S108 - exact reviewed worker launcher contract
                        "-b",
                        "0.0.0.0:8080",
                    ],
                    "startupProbe": {"httpGet": {"path": "/ready", "port": 8080}},
                    "resources": {"limits": {"cpu": "2", "memory": "4Gi"}},
                    "env": [
                        {"name": key, "value": value}
                        for key, value in {
                            "DRIVE_WORK_DRAIN_ENABLED": "true",
                            "DRIVE_WORKER_MODE": "true",
                            "DB_POOL_MIN_SIZE": "0",
                            "DB_POOL_MAX_SIZE": "2",
                            "DB_SQLALCHEMY_POOL_SIZE": "1",
                            "DB_SQLALCHEMY_MAX_OVERFLOW": "0",
                            "PROTECTED_DOCUMENT_DELIVERY_ENABLED": "false",
                        }.items()
                    ],
                },
                {
                    "name": "clamav",
                    "image": "clamav/clamav@" + scanner_index,
                    "resources": {"limits": {"cpu": "2", "memory": "4Gi"}},
                },
            ],
        },
        "status": {"conditions": [{"type": "Ready", "status": "True"}]},
    }
