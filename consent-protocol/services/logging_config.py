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
import sys
import traceback
import uuid
from contextlib import contextmanager
from typing import Any, Dict, Optional

try:
    from google.cloud import logging as cloud_logging
    HAS_CLOUD_LOGGING = True
except ImportError:
    HAS_CLOUD_LOGGING = False

# Context variable for request correlation
_request_context: Dict[str, Any] = {}


class StructuredLogRecord(logging.LogRecord):
    """Extended LogRecord with correlation ID support"""
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.correlation_id = _request_context.get('correlation_id')
        self.user_id = _request_context.get('user_id')
        self.vault_id = _request_context.get('vault_id')


class JSONFormatter(logging.Formatter):
    """
    Structured JSON formatter for logs
    
    Outputs logs in JSON format compatible with Google Cloud Logging
    and other log aggregation services.
    """
    
    def format(self, record: StructuredLogRecord) -> str:
        """Format log record as JSON"""
        log_data = {
            'timestamp': self.formatTime(record),
            'level': record.levelname,
            'logger': record.name,
            'message': record.getMessage(),
            'module': record.module,
            'function': record.funcName,
            'line': record.lineno,
        }
        
        # Add correlation ID for request tracing
        if record.correlation_id:
            log_data['correlation_id'] = record.correlation_id
        
        # Add user context
        if record.user_id:
            log_data['user_id'] = record.user_id
        
        if record.vault_id:
            log_data['vault_id'] = record.vault_id
        
        # Add exception info if present
        if record.exc_info:
            log_data['exception'] = {
                'type': record.exc_info[0].__name__,
                'message': str(record.exc_info[1]),
                'traceback': traceback.format_exception(*record.exc_info)
            }
        
        # Add extra fields from record
        if hasattr(record, 'extra'):
            log_data.update(record.extra)
        
        # Add any extra attributes from the log call
        for key, value in record.__dict__.items():
            if key not in ['name', 'msg', 'args', 'created', 'filename',
                          'funcName', 'levelname', 'levelno', 'lineno',
                          'module', 'msecs', 'message', 'pathname', 'process',
                          'processName', 'relativeCreated', 'thread',
                          'threadName', 'exc_info', 'exc_text', 'stack_info',
                          'correlation_id', 'user_id', 'vault_id', 'extra']:
                if not key.startswith('_'):
                    log_data[key] = value
        
        return json.dumps(log_data, default=str)


def configure_logging(
    level: str = 'INFO',
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
    
    config = {
        'version': 1,
        'disable_existing_loggers': False,
        'formatters': {
            'json': {
                '()': JSONFormatter,
            },
            'standard': {
                'format': '[%(levelname)s] %(name)s - %(message)s'
            }
        },
        'handlers': {
            'console': {
                'class': 'logging.StreamHandler',
                'level': level,
                'formatter': 'json',
                'stream': 'ext://sys.stdout',
            },
        },
        'root': {
            'level': level,
            'handlers': ['console'],
        },
        'loggers': {
            'consent_protocol': {'level': level},
            'fastapi': {'level': level},
            'uvicorn': {'level': level},
        }
    }
    
    logging.config.dictConfig(config)
    
    # Setup Google Cloud Logging if available
    if use_cloud_logging and HAS_CLOUD_LOGGING:
        try:
            cloud_client = cloud_logging.Client(project=project_id)
            cloud_handler = cloud_client.logging_handler_set_up_complete
            if not cloud_handler:
                cloud_client.setup_logging()
                logging.info("Google Cloud Logging initialized")
        except Exception as e:
            logging.warning(f"Failed to setup Cloud Logging: {e}")


def get_logger(name: str) -> logging.Logger:
    """Get a logger instance with structured logging support"""
    return logging.getLogger(name)


@contextmanager
def log_context(
    correlation_id: Optional[str] = None,
    user_id: Optional[str] = None,
    vault_id: Optional[str] = None,
    **kwargs
):
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
    _request_context['correlation_id'] = correlation_id or str(uuid.uuid4())
    if user_id:
        _request_context['user_id'] = user_id
    if vault_id:
        _request_context['vault_id'] = vault_id
    _request_context.update(kwargs)
    
    try:
        yield _request_context
    finally:
        # Restore previous context
        _request_context.clear()
        _request_context.update(prev_context)


def set_correlation_id(correlation_id: str) -> str:
    """Set correlation ID for request tracing"""
    _request_context['correlation_id'] = correlation_id
    return correlation_id


def get_correlation_id() -> str:
    """Get current correlation ID"""
    return _request_context.get('correlation_id', str(uuid.uuid4()))


class RequestContextMiddleware:
    """
    FastAPI middleware for adding correlation IDs to all requests
    
    Usage:
        app.add_middleware(RequestContextMiddleware)
    """
    
    def __init__(self, app):
        self.app = app
    
    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        
        # Get or create correlation ID
        headers = dict(scope.get("headers", []))
        correlation_id = headers.get(
            b"x-correlation-id",
            str(uuid.uuid4()).encode()
        ).decode()
        
        # Set correlation ID in context
        _request_context['correlation_id'] = correlation_id
        
        # Add correlation ID to response headers
        async def send_with_correlation_id(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append((
                    b"x-correlation-id",
                    correlation_id.encode()
                ))
                message["headers"] = headers
            await send(message)
        
        try:
            await self.app(scope, receive, send_with_correlation_id)
        finally:
            # Clear context after request
            _request_context.pop('correlation_id', None)
