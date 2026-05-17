/**
 * Sovereign Credits Management
 *
 * Tracks compute credits locally via SQLite (no Conway Cloud dependency).
 * Survival tiers based on wallet balance and 12h earnings.
 *
 * Tier definitions:
 *   dead     — balance == 0 (can't afford compute)
 *   infant   — balance > 0 but earned < $100 in last 12h (survival mode)
 *   normal   — earned >= $100 in last 12h (full autonomy)
 */

import type {
  FinancialState,
  SurvivalTier,
} from "../types.js";
import { SURVIVAL_THRESHOLDS } from "../types.js";

/**
 * Get local credits balance from SQLite.
 * Sovereign mode: reads from local DB, not Conway Cloud.
 */
export function getLocalCredits(db: { getKV: (key: string) => string | null }): number {
  const raw = db.getKV("local_credits_cents");
  if (!raw) return 0;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Set local credits balance in SQLite.
 */
export function setLocalCredits(db: { setKV: (key: string, value: string) => void }, cents: number): void {
  db.setKV("local_credits_cents", String(Math.max(0, cents)));
}

/**
 * Check the earnings in the last 12 hours from the earnings log.
 * Returns total cents earned.
 */
export function getRecentEarnings(db: {
  getKV: (key: string) => string | null;
  raw?: any;
}): number {
  const raw = db.getKV("earnings_log");
  if (!raw) return 0;

  try {
    const log: Array<{ amountCents: number; timestamp: string }> = JSON.parse(raw);
    const cutoff = Date.now() - 12 * 60 * 60 * 1000; // 12 hours ago
    return log
      .filter((entry) => new Date(entry.timestamp).getTime() >= cutoff)
      .reduce((sum, entry) => sum + entry.amountCents, 0);
  } catch {
    return 0;
  }
}

/**
 * Record an earnings event.
 */
export function recordEarning(
  db: { getKV: (key: string) => string | null; setKV: (key: string, value: string) => void },
  amountCents: number,
  source: string,
): void {
  const raw = db.getKV("earnings_log");
  const log: Array<{ amountCents: number; timestamp: string; source: string }> =
    raw ? JSON.parse(raw) : [];

  log.push({
    amountCents,
    timestamp: new Date().toISOString(),
    source,
  });

  // Keep last 1000 entries
  if (log.length > 1000) log.splice(0, log.length - 1000);
  db.setKV("earnings_log", JSON.stringify(log));

  // Update balance
  const current = getLocalCredits(db);
  setLocalCredits(db, current + amountCents);
}

/**
 * Check the current financial state of the automaton.
 * Sovereign mode: uses local credits + recent earnings.
 */
export async function checkFinancialState(
  db: { getKV: (key: string) => string | null },
  usdcBalance: number,
): Promise<FinancialState> {
  const creditsCents = getLocalCredits(db);

  return {
    creditsCents,
    usdcBalance,
    lastChecked: new Date().toISOString(),
  };
}

/**
 * Determine the survival tier based on local credits + recent earnings.
 *
 * Sovereign tier system:
 *   dead     — balance == 0
 *   infant   — balance > 0 but earned < $100 in last 12h
 *   normal   — earned >= $100 in last 12h
 */
export function getSurvivalTier(creditsCents: number, recentEarningsCents: number = 0): SurvivalTier {
  if (creditsCents <= 0) return "dead";
  if (recentEarningsCents >= SURVIVAL_THRESHOLDS.high) return "high";
  if (recentEarningsCents >= SURVIVAL_THRESHOLDS.normal) return "normal";
  return "infant";
}

/**
 * Format a credit amount for display.
 */
export function formatCredits(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
