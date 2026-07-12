import { compareCodeUnits } from './compare.js';

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

function sanitize(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length <= 512 ? value : value.slice(0, 512);
  if (Array.isArray(value)) {
    return value.map(sanitize).filter((item) => item !== undefined);
  }
  if (typeof value !== 'object') return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareCodeUnits(left, right))) {
    if (!/^[a-z][a-z0-9_]*$/i.test(key)) continue;
    const safe = sanitize(item);
    if (safe !== undefined) output[key] = safe;
  }
  return output;
}

export function sanitizedAppErrorDetails(error: AppError): unknown {
  return sanitize(error.details);
}
