import time
from typing import Any, Callable


class WorkflowRetryService:
    """
    Reusable retry utility for transient workflow failures.
    """

    def __init__(self, retries: int = 3, delay: int = 1):
        self.retries = retries
        self.delay = delay

    def execute_with_retry(
        self,
        operation: Callable[..., Any],
        *args,
        **kwargs,
    ) -> Any:

        last_error = None

        for attempt in range(1, self.retries + 1):

            try:
                return operation(*args, **kwargs)

            except Exception as error:

                last_error = error

                if attempt < self.retries:
                    time.sleep(self.delay)

        raise last_error
