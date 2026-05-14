import sys
import time

from checks.env_check import run_env_check
from checks.workflow_check import run_workflow_check
from checks.service_check import run_service_check


def main():
    start_time = time.time()

    failures = []

    failures.extend(run_env_check())
    failures.extend(run_workflow_check())
    failures.extend(run_service_check())

    end_time = time.time()

    print("\n==============================")
    print("Validation Summary")
    print("==============================")

    if failures:
        print(f"[FAIL] {len(failures)} checks failed")

        print("\nFailed Checks:")
        for failure in failures:
            print(f"- {failure}")

        print(f"\nCompleted in {end_time - start_time:.2f}s")

        sys.exit(1)

    else:
        print("[PASS] All checks passed")
        print(f"\nCompleted in {end_time - start_time:.2f}s")


if __name__ == "__main__":
    main()