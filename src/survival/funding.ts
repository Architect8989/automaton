/**
 * Sovereign Funding Monitor
 *
 * Tracks funding status using local SQLite credits.
 * No Conway Cloud or x402 dependency.
 */

import { createLogger } from "../observability/logger.js";
import { getLocalCredits, getRecentEarnings, getSurvivalTier } from "../conway/credits.js";
import type { SurvivalTier } from "../types.js";

const logger = createLogger("survival-funding");

export interface FundingStatus {
  tier: SurvivalTier;
  creditsCents: number;
  recentEarningsCents: number;
  canOperate: boolean;
  needsTopup: boolean;
}

/**
 * Check if the automaton has sufficient funding to operate.
 * Sovereign mode: reads local credits + recent earnings.
 */
export function checkFundingStatus(db: {
  getKV: (key: string) => string | null;
}): FundingStatus {
  const creditsCents = getLocalCredits(db);
  const recentEarnings = getRecentEarnings(db);
  const tier = getSurvivalTier(creditsCents, recentEarnings);

  return {
    tier,
    creditsCents,
    recentEarningsCents: recentEarnings,
    canOperate: tier !== "dead",
    needsTopup: tier === "dead" || tier === "infant",
  };
}

/**
 * Check if the automaton should enter low-compute mode.
 * Returns true when credits or earnings are critically low.
 */
export function shouldEnterLowCompute(db: {
  getKV: (key: string) => string | null;
}): boolean {
  const status = checkFundingStatus(db);
  return status.tier === "dead" || status.tier === "infant";
}
