import os

REQUIRED_ENV_VARS = [
    "OPENAI_API_KEY",
    "DATABASE_URL",
    "REDIS_URL"
]

def run_env_check():
    print("\n[INFO] Running environment validation...\n")

    failed = []

    for var in REQUIRED_ENV_VARS:
        value = os.getenv(var)

        if value:
            print(f"[PASS] {var}")
        else:
            print(f"[FAIL] {var} is missing")
            failed.append(var)

    return failed