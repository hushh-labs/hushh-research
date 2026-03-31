# consent-protocol/db/db_client.py
"""
Database Client - SQLAlchemy Session Pooler

This module provides a unified database access layer using SQLAlchemy with
Supabase's session pooler for direct PostgreSQL connections.

Architecture:
  API Route → Service Layer (validates consent) → DB Client → PostgreSQL

Benefits over REST API:
  - Direct PostgreSQL connection (lower latency)
  - Full SQL power (transactions, CTEs, raw queries)
  - Single connection method for all operations
  - Consistent with migration scripts
"""

import json
import logging
import os
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Optional, Union
from urllib.parse import quote_plus

from dotenv import load_dotenv
from psycopg2.extras import Json as PsycopgJson
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.pool import NullPool, QueuePool

load_dotenv()

logger = logging.getLogger(__name__)

# Singleton engine instance
_engine: Optional[Engine] = None


def _env_truthy(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int, *, minimum: int = 0) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        logger.warning("Invalid integer for %s=%r; using default %s", name, raw, default)
        return default
    if value < minimum:
        logger.warning(
            "Out-of-range integer for %s=%r; expected >= %s. Using default %s",
            name,
            raw,
            minimum,
            default,
        )
        return default
    return value


def _adapt_db_param_value(value: Any, dialect_name: str | None = None) -> Any:
    """Adapt JSON-like values for the active DB driver."""
    if isinstance(value, dict):
        if dialect_name and dialect_name.startswith("postgres"):
            return PsycopgJson(value)
        return json.dumps(value)
    return value


def _adapt_db_params(params: dict[str, Any], dialect_name: str | None = None) -> dict[str, Any]:
    return {
        key: _adapt_db_param_value(value, dialect_name=dialect_name)
        for key, value in params.items()
    }


class DatabaseExecutionError(RuntimeError):
    """Raised when a database operation fails and must not be silently ignored."""

    def __init__(
        self,
        *,
        table_name: str,
        operation: str,
        details: str,
    ):
        self.table_name = table_name
        self.operation = operation
        self.details = details
        super().__init__(f"DB operation failed [{table_name}.{operation}]: {details}")


def get_db_engine() -> Engine:
    """
    Get SQLAlchemy engine using session pooler credentials.

    Defaults to QueuePool to reuse local TCP connections and reduce repeated
    connection handshakes; can be switched back to NullPool via env.

    Returns:
        SQLAlchemy Engine instance

    Raises:
        EnvironmentError: If DB credentials are not set
    """
    global _engine

    if _engine is None:
        db_user = os.getenv("DB_USER")
        db_password = os.getenv("DB_PASSWORD")
        db_host = os.getenv("DB_HOST")
        db_unix_socket = os.getenv("DB_UNIX_SOCKET")
        db_port = os.getenv("DB_PORT", "5432")
        db_name = os.getenv("DB_NAME", "postgres")

        if not db_user or not db_password or not (db_host or db_unix_socket):
            raise EnvironmentError(
                "Database credentials not set. Required: DB_USER, DB_PASSWORD, and one of DB_HOST/DB_UNIX_SOCKET. "
                "Optional: DB_PORT (default 5432), DB_NAME (default postgres)"
            )
        if db_unix_socket:
            # Cloud SQL Unix socket path must be passed in query host param.
            encoded_socket = quote_plus(db_unix_socket)
            database_url = (
                f"postgresql+psycopg2://{db_user}:{db_password}@/{db_name}?host={encoded_socket}"
            )
            target = db_unix_socket
        else:
            ssl_suffix = (
                "?sslmode=require"
                if ("supabase.com" in str(db_host) or "pooler.supabase" in str(db_host))
                else ""
            )
            database_url = f"postgresql+psycopg2://{db_user}:{db_password}@{db_host}:{db_port}/{db_name}{ssl_suffix}"
            target = f"{db_host}:{db_port}/{db_name}"

        connect_args: dict[str, Any] = {
            "connect_timeout": _env_int("DB_CONNECT_TIMEOUT_SECONDS", 10, minimum=1)
        }
        if not db_unix_socket:
            connect_args.update(
                {
                    "keepalives": 1,
                    "keepalives_idle": _env_int("DB_TCP_KEEPALIVE_IDLE_SECONDS", 30, minimum=1),
                    "keepalives_interval": _env_int(
                        "DB_TCP_KEEPALIVE_INTERVAL_SECONDS", 10, minimum=1
                    ),
                    "keepalives_count": _env_int("DB_TCP_KEEPALIVE_COUNT", 5, minimum=1),
                }
            )

        use_null_pool = _env_truthy("DB_SQLALCHEMY_USE_NULL_POOL", False)
        logger.info(f"Initializing database connection to {target}")
        if use_null_pool:
            _engine = create_engine(
                database_url,
                poolclass=NullPool,
                connect_args=connect_args,
                pool_pre_ping=True,
            )
            logger.info("Database engine initialized with NullPool")
        else:
            _engine = create_engine(
                database_url,
                poolclass=QueuePool,
                pool_size=_env_int("DB_SQLALCHEMY_POOL_SIZE", 5, minimum=1),
                max_overflow=_env_int("DB_SQLALCHEMY_MAX_OVERFLOW", 10, minimum=0),
                pool_timeout=_env_int("DB_SQLALCHEMY_POOL_TIMEOUT_SECONDS", 30, minimum=1),
                pool_recycle=_env_int("DB_SQLALCHEMY_POOL_RECYCLE_SECONDS", 1800, minimum=30),
                pool_pre_ping=True,
                connect_args=connect_args,
            )
            logger.info("Database engine initialized with QueuePool")
        logger.info("Database engine initialized")

    return _engine


def close_db_engine():
    """Close database engine (for cleanup)."""
    global _engine
    if _engine is not None:
        _engine.dispose()
        _engine = None
        logger.info("Database engine closed")


@contextmanager
def get_db_connection():
    """
    Context manager for database connections.

    Usage:
        with get_db_connection() as conn:
            result = conn.execute(text("SELECT * FROM users"))
    """
    engine = get_db_engine()
    conn = engine.connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@dataclass
class QueryResult:
    """Result from a database query, compatible with Supabase response format."""

    data: list[dict]
    count: Optional[int] = None
    error: Optional[str] = None


class TableQuery:
    """
    Supabase-compatible query builder for SQLAlchemy.

    Provides a fluent API similar to supabase-py for easy migration:

        # Old (Supabase REST):
        supabase.table("users").select("*").eq("id", user_id).execute()

        # New (SQLAlchemy):
        db.table("users").select("*").eq("id", user_id).execute()
    """

    def __init__(self, table_name: str, engine: Engine):
        self.table_name = table_name
        self.engine = engine
        self._columns = "*"
        self._filters: list[tuple[str, str, Any]] = []
        self._order_by: Optional[tuple[str, bool]] = None
        self._limit_val: Optional[int] = None
        self._offset_val: Optional[int] = None
        self._insert_data: Optional[Union[dict, list[dict]]] = None
        self._update_data: Optional[dict] = None
        self._upsert_data: Optional[Union[dict, list[dict]]] = None
        self._on_conflict: Optional[str] = None
        self._operation = "select"
        self._count_preference: Optional[str] = None

    def select(self, columns: str = "*", count: Optional[str] = None) -> "TableQuery":
        """
        Select columns to return.

        Args:
            columns: Comma-separated list of columns
            count: Count algorithm (e.g., 'exact')
        """
        self._columns = columns
        self._count_preference = count
        self._operation = "select"
        return self

    def insert(self, data: Union[dict, list[dict]]) -> "TableQuery":
        """Insert data into table."""
        self._insert_data = data
        self._operation = "insert"
        return self

    def update(self, data: dict) -> "TableQuery":
        """Update data in table."""
        self._update_data = data
        self._operation = "update"
        return self

    def upsert(self, data: Union[dict, list[dict]], on_conflict: str = "id") -> "TableQuery":
        """Upsert data (insert or update on conflict)."""
        self._upsert_data = data
        self._on_conflict = on_conflict
        self._operation = "upsert"
        return self

    def delete(self) -> "TableQuery":
        """Delete rows from table."""
        self._operation = "delete"
        return self

    def eq(self, column: str, value: Any) -> "TableQuery":
        """Filter where column equals value."""
        self._filters.append((column, "=", value))
        return self

    def neq(self, column: str, value: Any) -> "TableQuery":
        """Filter where column not equals value."""
        self._filters.append((column, "!=", value))
        return self

    def gt(self, column: str, value: Any) -> "TableQuery":
        """Filter where column greater than value."""
        self._filters.append((column, ">", value))
        return self

    def gte(self, column: str, value: Any) -> "TableQuery":
        """Filter where column greater than or equal to value."""
        self._filters.append((column, ">=", value))
        return self

    def lt(self, column: str, value: Any) -> "TableQuery":
        """Filter where column less than value."""
        self._filters.append((column, "<", value))
        return self

    def lte(self, column: str, value: Any) -> "TableQuery":
        """Filter where column less than or equal to value."""
        self._filters.append((column, "<=", value))
        return self

    def like(self, column: str, pattern: str) -> "TableQuery":
        """Filter where column matches pattern (case-sensitive)."""
        self._filters.append((column, "LIKE", pattern))
        return self

    def ilike(self, column: str, pattern: str) -> "TableQuery":
        """Filter where column matches pattern (case-insensitive)."""
        self._filters.append((column, "ILIKE", pattern))
        return self

    def is_(self, column: str, value: Any) -> "TableQuery":
        """Filter where column IS value (for NULL checks)."""
        self._filters.append((column, "IS", value))
        return self

    def in_(self, column: str, values: list) -> "TableQuery":
        """Filter where column is in list of values."""
        self._filters.append((column, "IN", values))
        return self

    def order(self, column: str, desc: bool = False) -> "TableQuery":
        """Order results by column."""
        self._order_by = (column, desc)
        return self

    def limit(self, count: int) -> "TableQuery":
        """Limit number of results."""
        self._limit_val = count
        return self

    def offset(self, count: int) -> "TableQuery":
        """Offset results (for pagination)."""
        self._offset_val = count
        return self

    def single(self) -> "TableQuery":
        """Expect single result (sets limit to 1)."""
        self._limit_val = 1
        return self

    def _build_where_clause(self, params: dict, dialect_name: str | None = None) -> str:
        """Build WHERE clause from filters."""
        if not self._filters:
            return ""

        conditions = []
        for i, (column, op, value) in enumerate(self._filters):
            param_name = f"p{i}"
            if op == "IS":
                if value is None:
                    conditions.append(f'"{column}" IS NULL')
                else:
                    conditions.append(f'"{column}" IS :{param_name}')
                    params[param_name] = _adapt_db_param_value(value, dialect_name=dialect_name)
            elif op == "IN":
                # Handle IN clause with multiple parameters
                in_params = []
                for j, v in enumerate(value):
                    in_param = f"{param_name}_{j}"
                    in_params.append(f":{in_param}")
                    params[in_param] = _adapt_db_param_value(v, dialect_name=dialect_name)
                conditions.append(f'"{column}" IN ({", ".join(in_params)})')
            else:
                conditions.append(f'"{column}" {op} :{param_name}')
                params[param_name] = _adapt_db_param_value(value, dialect_name=dialect_name)

        return " WHERE " + " AND ".join(conditions)

    def execute(self) -> QueryResult:
        """Execute the query and return results."""
        try:
            with self.engine.connect() as conn:
                if self._operation == "select":
                    return self._execute_select(conn)
                elif self._operation == "insert":
                    return self._execute_insert(conn)
                elif self._operation == "update":
                    return self._execute_update(conn)
                elif self._operation == "upsert":
                    return self._execute_upsert(conn)
                elif self._operation == "delete":
                    return self._execute_delete(conn)
                else:
                    raise DatabaseExecutionError(
                        table_name=self.table_name,
                        operation=self._operation,
                        details=f"Unknown operation: {self._operation}",
                    )
        except DatabaseExecutionError:
            raise
        except Exception as e:
            logger.error(f"Database error: {e}")
            raise DatabaseExecutionError(
                table_name=self.table_name,
                operation=self._operation,
                details=str(e),
            ) from e

    def _execute_select(self, conn) -> QueryResult:
        """Execute SELECT query."""
        params: dict[str, Any] = {}
        dialect_name = getattr(getattr(conn, "engine", None), "dialect", None)
        dialect_name = getattr(dialect_name, "name", None) or getattr(
            getattr(self.engine, "dialect", None), "name", None
        )
        where_clause = self._build_where_clause(params, dialect_name=dialect_name)

        # Build column list
        if self._columns == "*":
            columns = "*"
        else:
            columns = ", ".join(f'"{c.strip()}"' for c in self._columns.split(","))

        total_count = None
        if self._count_preference == "exact":
            count_sql = f'SELECT COUNT(*) FROM "{self.table_name}"' + where_clause
            total_count = conn.execute(text(count_sql), params).scalar()

        # Skip select if limit is 0 but count was requested
        if self._limit_val == 0:
            return QueryResult(data=[], count=total_count)

        sql = f'SELECT {columns} FROM "{self.table_name}"'
        sql += where_clause

        if self._order_by:
            col, desc = self._order_by
            sql += f' ORDER BY "{col}" {"DESC" if desc else "ASC"}'

        if self._limit_val is not None:
            sql += f" LIMIT {self._limit_val}"

        if self._offset_val is not None:
            sql += f" OFFSET {self._offset_val}"

        result = conn.execute(text(sql), params)
        rows = [dict(row._mapping) for row in result]

        # If count was not requested, use row count
        if total_count is None:
            total_count = len(rows)

        return QueryResult(data=rows, count=total_count)

    def _execute_insert(self, conn) -> QueryResult:
        """Execute INSERT query."""
        if not self._insert_data:
            raise ValueError("No data to insert")

        data_list = (
            self._insert_data if isinstance(self._insert_data, list) else [self._insert_data]
        )

        if not data_list:
            raise ValueError("Empty data list")

        columns = list(data_list[0].keys())
        col_names = ", ".join(f'"{c}"' for c in columns)

        dialect_name = getattr(getattr(self.engine, "dialect", None), "name", None)
        inserted_rows = []
        for i, row_data in enumerate(data_list):
            param_names = ", ".join(f":v{i}_{c}" for c in columns)
            params = _adapt_db_params(
                {f"v{i}_{c}": row_data[c] for c in columns}, dialect_name=dialect_name
            )

            sql = (
                f'INSERT INTO "{self.table_name}" ({col_names}) VALUES ({param_names}) RETURNING *'
            )
            result = conn.execute(text(sql), params)
            inserted_rows.extend([dict(row._mapping) for row in result])

        conn.commit()
        return QueryResult(data=inserted_rows, count=len(inserted_rows))

    def _execute_update(self, conn) -> QueryResult:
        """Execute UPDATE query."""
        if not self._update_data:
            raise ValueError("No data to update")

        params = {}
        dialect_name = getattr(getattr(self.engine, "dialect", None), "name", None)
        set_clauses = []
        for i, (col, val) in enumerate(self._update_data.items()):
            param_name = f"u{i}"
            set_clauses.append(f'"{col}" = :{param_name}')
            params[param_name] = _adapt_db_param_value(val, dialect_name=dialect_name)

        sql = f'UPDATE "{self.table_name}" SET {", ".join(set_clauses)}'
        sql += self._build_where_clause(params, dialect_name=dialect_name)
        sql += " RETURNING *"

        result = conn.execute(text(sql), params)
        rows = [dict(row._mapping) for row in result]
        conn.commit()
        return QueryResult(data=rows, count=len(rows))

    def _execute_upsert(self, conn) -> QueryResult:
        """Execute UPSERT (INSERT ... ON CONFLICT UPDATE) query."""
        if not self._upsert_data:
            raise ValueError("No data to upsert")

        data_list = (
            self._upsert_data if isinstance(self._upsert_data, list) else [self._upsert_data]
        )

        if not data_list:
            raise ValueError("Empty data list")

        columns = list(data_list[0].keys())
        col_names = ", ".join(f'"{c}"' for c in columns)
        conflict_cols = [
            field.strip() for field in (self._on_conflict or "id").split(",") if field.strip()
        ]
        if not conflict_cols:
            raise ValueError("At least one conflict column is required for upsert")

        conflict_cols_quoted = ", ".join(f'"{c}"' for c in conflict_cols)
        immutable_cols = {"created_at"}
        update_cols = [
            c for c in columns if c not in set(conflict_cols) and c not in immutable_cols
        ]
        update_clause = ", ".join(f'"{c}" = EXCLUDED."{c}"' for c in update_cols)

        dialect_name = getattr(getattr(self.engine, "dialect", None), "name", None)
        upserted_rows = []
        for i, row_data in enumerate(data_list):
            param_names = ", ".join(f":v{i}_{c}" for c in columns)
            params = _adapt_db_params(
                {f"v{i}_{c}": row_data[c] for c in columns}, dialect_name=dialect_name
            )

            if update_clause:
                sql = f'''
                    INSERT INTO "{self.table_name}" ({col_names}) 
                    VALUES ({param_names}) 
                    ON CONFLICT ({conflict_cols_quoted}) DO UPDATE SET {update_clause}
                    RETURNING *
                '''
            else:
                sql = f'''
                    INSERT INTO "{self.table_name}" ({col_names}) 
                    VALUES ({param_names}) 
                    ON CONFLICT ({conflict_cols_quoted}) DO NOTHING
                    RETURNING *
                '''
            result = conn.execute(text(sql), params)
            upserted_rows.extend([dict(row._mapping) for row in result])

        conn.commit()
        return QueryResult(data=upserted_rows, count=len(upserted_rows))

    def _execute_delete(self, conn) -> QueryResult:
        """Execute DELETE query."""
        params: dict[str, Any] = {}
        sql = f'DELETE FROM "{self.table_name}"'
        dialect_name = getattr(getattr(self.engine, "dialect", None), "name", None)
        sql += self._build_where_clause(params, dialect_name=dialect_name)
        sql += " RETURNING *"

        result = conn.execute(text(sql), params)
        rows = [dict(row._mapping) for row in result]
        conn.commit()
        return QueryResult(data=rows, count=len(rows))


class DatabaseClient:
    """
    Main database client with Supabase-compatible API.

    Usage:
        from db.db_client import get_db

        db = get_db()

        # Select
        result = db.table("users").select("*").eq("id", user_id).execute()

        # Insert
        result = db.table("users").insert({"name": "John"}).execute()

        # Update
        result = db.table("users").update({"name": "Jane"}).eq("id", user_id).execute()

        # Delete
        result = db.table("users").delete().eq("id", user_id).execute()

        # Raw SQL
        result = db.execute_raw("SELECT * FROM users WHERE id = :id", {"id": user_id})
    """

    def __init__(self, engine: Optional[Engine] = None):
        self._engine = engine

    @property
    def engine(self) -> Engine:
        if self._engine is None:
            self._engine = get_db_engine()
        return self._engine

    def table(self, table_name: str) -> TableQuery:
        """Start a query on a table."""
        return TableQuery(table_name, self.engine)

    def execute_raw(self, sql: str, params: Optional[dict] = None) -> QueryResult:
        """
        Execute raw SQL query.

        Args:
            sql: SQL query string with :param placeholders
            params: Dictionary of parameter values

        Returns:
            QueryResult with data
        """
        try:
            with self.engine.connect() as conn:
                dialect_name = getattr(getattr(self.engine, "dialect", None), "name", None)
                adapted_params = _adapt_db_params(params or {}, dialect_name=dialect_name)
                result = conn.execute(text(sql), adapted_params)

                # Check if this is a SELECT-like query that returns rows
                if result.returns_rows:
                    rows = [dict(row._mapping) for row in result]
                    conn.commit()
                    return QueryResult(data=rows, count=len(rows))
                conn.commit()
                return QueryResult(data=[], count=result.rowcount)
        except DatabaseExecutionError:
            raise
        except Exception as e:
            logger.error(f"Raw SQL error: {e}")
            raise DatabaseExecutionError(
                table_name="<raw_sql>",
                operation="execute_raw",
                details=str(e),
            ) from e

    def rpc(self, function_name: str, params: Optional[dict] = None) -> QueryResult:
        """
        Call a PostgreSQL function (RPC).

        Args:
            function_name: Name of the function to call
            params: Dictionary of function parameters

        Returns:
            QueryResult with function result
        """
        try:
            with self.engine.connect() as conn:
                if params:
                    param_list = ", ".join(f":{k}" for k in params.keys())
                    sql = f"SELECT {function_name}({param_list})"
                else:
                    sql = f"SELECT {function_name}()"

                result = conn.execute(text(sql), params or {})
                rows = [dict(row._mapping) for row in result]
                return QueryResult(data=rows, count=len(rows))
        except DatabaseExecutionError:
            raise
        except Exception as e:
            logger.error(f"RPC error: {e}")
            raise DatabaseExecutionError(
                table_name="<rpc>",
                operation=function_name,
                details=str(e),
            ) from e


# Singleton client instance
_db_client: Optional[DatabaseClient] = None


def get_db() -> DatabaseClient:
    """
    Get database client instance.

    This is the main entry point for database operations.

    Returns:
        DatabaseClient instance
    """
    global _db_client
    if _db_client is None:
        _db_client = DatabaseClient()
    return _db_client


# Backward compatibility alias
def get_supabase() -> DatabaseClient:
    """
    Backward compatibility alias for get_db().

    DEPRECATED: Use get_db() instead.
    """
    logger.warning("get_supabase() is deprecated, use get_db() instead")
    return get_db()
