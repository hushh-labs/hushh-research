"""
Structured Logging Configuration

Implements JSON structured logging with correlation IDs and request tracing.
Integrates with Google Cloud Logging for production environments.

Usage:
    from logging_config import get_logger

    logger = get_logger(__name__)
    logger.info("message", extra={
        "user_id": user.id,
        "vault_id": vault.id,
        "scopes": ["vault.read", "portfolio.read"]
    })
"""

import json
import logging
import logging.config
import traceback
import uuid
from contextlib import contextmanager
from typing import Any, Dict, Generator, Optional

try:
    from google.cloud import logging as cloud_logging

    HAS_CLOUD_LOGGING = True
except ImportError:
    HAS_CLOUD_LOGGING = False

# Context variable for request correlation
_request_context: Dict[str, Any] = {}


class StructuredLogRecord(logging.LogRecord):
    """Extended LogRecord with correlation ID support"""

    def __init__(self, *args: Any, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self.correlation_id = _request_context.get("correlation_id")
        self.user_id = _request_context.get("user_id")
        self.vault_id = _request_context.get("vault_id")


class JSONFormatter(logging.Formatter):
    """
    Structured JSON formatter for logs

    Outputs logs in JSON format compatible with Google Cloud Logging
    and other log aggregation services.
    """

    def format(self, record: logging.LogRecord) -> str:
        """Format log record as JSON"""
        structured_record: StructuredLogRecord = record  # type: ignore[assignment]
        log_data: Dict[str, Any] = {
            "timestamp": self.formatTime(record),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "module": record.module,
            "function": record.funcName,
            "line": record.lineno,
        }

        # Add correlation ID for request tracing
        if getattr(structured_record, "correlation_id", None):
            log_data["correlation_id"] = structured_record.correlation_id

        # Add user context
        if getattr(structured_record, "user_id", None):
            log_data["user_id"] = structured_record.user_id

        if getattr(structured_record, "vault_id", None):
            log_data["vault_id"] = structured_record.vault_id

        # Add exception info if present
        if record.exc_info:
            log_data["exception"] = {
                "type": record.exc_info[0].__name__,  # type: ignore[union-attr]
                "message": str(record.exc_info[1]),
                "traceback": traceback.format_exception(*record.exc_info),
            }

        # Add any extra attributes from the log call
        _skip = {
            "name", "msg", "args", "created", "filename", "funcName",
            "levelname", "levelno", "lineno", "module", "msecs", "message",
            "pathname", "process", "processName", "relativeCreated", "thread",
            "threadName", "exc_info", "exc_text", "stack_info",
            "correlation_id", "user_id", "vault_id", "extra",
        }
        for key, value in record.__dict__.items():
            if key not in _skip and not key.startswith("_"):
                log_data[key] = value

        return json.dumps(log_data, default=str)


def configure_logging(
    level: str = "INFO",
    use_cloud_logging: bool = False,
    project_id: Optional[str] = None,
) -> None:
    """
    Configure structured logging for the application

    Args:
        level: Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        use_cloud_logging: Enable Google Cloud Logging integration
        project_id: GCP project ID (required if use_cloud_logging=True)
    """

    # Update LogRecord factory to use our custom class
    logging.setLogRecordFactory(StructuredLogRecord)

    config: Dict[str, Any] = {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {
            "json": {
                "()": JSONFormatter,
            },
            "standard": {"format": "[%(levelname)s] %(name)s - %(message)s"},
        },
        "handlers": {
            "console": {
                "class": "logging.StreamHandler",
                "level": level,
                "formatter": "json",
                "stream": "ext://sys.stdout",
            },
        },
        "root": {
            "level": level,
            "handlers": ["console"],
        },
        "loggers": {
            "consent_protocol": {"level": level},
            "fastapi": {"level": level},
            "uvicorn": {"level": level},
        },
    }

    logging.config.dictConfig(config)

    # Setup Google Cloud Logging if requested and available
    if use_cloud_logging and HAS_CLOUD_LOGGING:
        try:
            cloud_client = cloud_logging.Client(project=project_id)
            cloud_client.setup_logging()
            logging.info("Google Cloud Logging initialized")
        except Exception as e:
            logging.warning("Failed to setup Cloud Logging: %s", e)


def get_logger(name: str) -> logging.Logger:
    """Get a logger instance with structured logging support"""
    return logging.getLogger(name)


@contextmanager
def log_context(
    correlation_id: Optional[str] = None,
    user_id: Optional[str] = None,
    vault_id: Optional[str] = None,
    **kwargs: Any,
) -> Generator[Dict[str, Any], None, None]:
    """
    Context manager for request-scoped logging context

    Usage:
        with log_context(user_id=user.id, correlation_id=request_id):
            logger.info("Processing request")  # Will include user_id and correlation_id
    """

    # Save previous context
    prev_context = _request_context.copy()

    # Update context
    _request_context.clear()
    _request_context["correlation_id"] = correlation_id or str(uuid.uuid4())
    if user_id:
        _request_context["user_id"] = user_id
    if vault_id:
        _request_context["vault_id"] = vault_id
    _request_context.update(kwargs)

    try:
        yield _request_context
    finally:
        # Restore previous context
        _request_context.clear()
        _request_context.update(prev_context)


def set_correlation_id(correlation_id: str) -> str:
    """Set correlation ID for request tracing"""
    _request_context["correlation_id"] = correlation_id
    return correlation_id


def get_correlation_id() -> str:
    """Get current correlation ID"""
    return _request_context.get("correlation_id", str(uuid.uuid4()))


class RequestContextMiddleware:
    """
    FastAPI middleware for adding correlation IDs to all requests

    Usage:
        app.add_middleware(RequestContextMiddleware)
    """

    def __init__(self, app: Any):
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Get or create correlation ID
        headers = dict(scope.get("headers", []))
        raw_id = headers.get(b"x-correlation-id")
        correlation_id = raw_id.decode() if raw_id else str(uuid.uuid4())

        # Set correlation ID in context
        _request_context["correlation_id"] = correlation_id

        async def send_with_correlation_id(message: Any) -> None:
            if message["type"] == "http.response.start":
                resp_headers = list(message.get("headers", []))
                resp_headers.append((b"x-correlation-id", correlation_id.encode()))
                message["headers"] = resp_headers
            await send(message)

        try:
            await self.app(scope, receive, send_with_correlation_id)
        finally:
            _request_context.pop("correlation_id", None)
