/** Locale-independent ordering used by every canonical serialization and report. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
