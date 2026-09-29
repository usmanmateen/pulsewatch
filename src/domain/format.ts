import { MINUTE_MS, type EpochMs } from './types';

/** 348 → "5h 48m"; 45 → "45m". Used in notification text. */
export function formatDuration(totalMinutes: number): string {
  const minutes = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return `${hours}h ${String(rest).padStart(2, '0')}m`;
}

/** Elapsed time between two instants, formatted like {@link formatDuration}. */
export function formatElapsed(from: EpochMs, to: EpochMs): string {
  return formatDuration((to - from) / MINUTE_MS);
}

/** "36 minutes" / "1h 12m" — prose-friendly for short durations. */
export function formatElapsedProse(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes));
  if (rounded < 60) return rounded === 1 ? '1 minute' : `${rounded} minutes`;
  return formatDuration(rounded);
}

const countFormatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

/** 8421 → "8,421". */
export function formatCount(value: number): string {
  return countFormatter.format(value);
}

/** Formats a number with fixed decimals, dropping a trailing ".0". */
export function formatNumber(value: number, decimals = 0): string {
  const fixed = value.toFixed(decimals);
  return decimals > 0 ? fixed.replace(/\.0+$/, '') : fixed;
}

/** "+3" / "-2" (uses a true minus sign for readability). */
export function formatSigned(value: number, decimals = 0): string {
  const text = formatNumber(Math.abs(value), decimals);
  if (Number(text) === 0) return text;
  return value > 0 ? `+${text}` : `−${text}`;
}

/**
 * Renders a clock time from minutes relative to midnight. Values outside
 * 0–1439 wrap, so a bedtime of -52 renders as "23:08".
 */
export function formatClockMinutes(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hours = Math.floor(wrapped / 60);
  const rest = wrapped % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}
