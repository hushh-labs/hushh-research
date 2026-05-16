import sys
import time

from checks.env_check import run_env_check
from checks.workflow_check import run_workflow_check
from checks.service_check import run_service_check

from diagnostics_report import generate_report


def main():
    start_time = time.time()

    failures = []

    results = {}

    env_failures = run_env_check()
    workflow_failures = run_workflow_check()
    service_failures = run_service_check()

    failures.extend(env_failures)
    failures.extend(workflow_failures)
    failures.extend(service_failures)

    results["environment"] = (
        "PASS" if not env_failures else f"FAIL: {env_failures}"
    )

    results["workflow"] = (
        "PASS" if not workflow_failures else f"FAIL: {workflow_failures}"
    )

    results["services"] = (
        "PASS" if not service_failures else f"FAIL: {service_failures}"
    )

    end_time = time.time()

    results["execution_time_seconds"] = round(
        end_time - start_time,
        2
    )

    generate_report(results)

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