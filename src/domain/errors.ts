export interface AppError {
  code: string;
  message: string;
  details?: unknown;
}

export function appError(
  code: string,
  message: string,
  details?: unknown,
): AppError {
  if (details === undefined) {
    return { code, message };
  }

  return { code, message, details };
}
