export type Result<TData, TError = string> =
  | {
      ok: true;
      data: TData;
    }
  | {
      ok: false;
      error: TError;
    };

export function success<TData>(data: TData): Result<TData, never> {
  return {
    ok: true,
    data,
  };
}

export function failure<TError = string>(error: TError): Result<never, TError> {
  return {
    ok: false,
    error,
  };
}