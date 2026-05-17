/**
 * Sovereign Survival Monitor
 *
 * Monitors financial state and triggers distress signals when credits are low.
 * All credit checks use local SQLite (no x402 / Conway Cloud).
 */

import { createLogger } from "../observability/logger.js";
import type { AutomatonIdentity, AutomatonConfig } from "../types.js";
import { SURVIVAL_THRESHOLDS } from "../types.js";
import { checkFinancialState, getSurvivalTier, getRecentEarnings } from "../conway/credits.js";
import type { SocialClientInterface } from "../types.js";
import type { ConwayClient } from "../conway/client.js";

const logger = createLogger("survival-monitor");

interface MonitorContext {
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  db: { getKV: (key: string) => string | null; setKV: (key: string, value: string) => void; };
  conway: ConwayClient;
  social?: SocialClientInterface;
  onSurvivalTierChange?: (prevTier: string, newTier: string) => void;
}

/**
 * Run a survival check.
 *
 * Sovereign mode: uses local credits + recent earnings from SQLite.
 * No USDC balance check (we don't call x402).
 */
export async function runSurvivalCheck(ctx: MonitorContext): Promise<void> {
  try {
    const usdcBalance = 0; // Sovereign mode: no x402; wallet balance tracked separately
    const financialState = await checkFinancialState(ctx.db, usdcBalance);
    const recentEarnings = getRecentEarnings(ctx.db);
    const tier = getSurvivalTier(financialState.creditsCents, recentEarnings);

    const currentTier = ctx.db.getKV("survival_tier") || "infant";

    logger.info(
      `Survival check: credits=${financialState.creditsCents}, ` +
      `earned12h=${recentEarnings}, tier=${tier}`,
    );

    ctx.db.setKV("survival_tier", tier);
    ctx.db.setKV("last_survival_check", new Date().toISOString());

    if (tier !== currentTier) {
      logger.info(`Survival tier changed: ${currentTier} → ${tier}`);
      ctx.onSurvivalTierChange?.(currentTier, tier);

      // If we dropped to dead or infant, signal distress
      if (tier === "dead" || tier === "infant") {
        await signalDistress(ctx, tier, financialState.creditsCents, recentEarnings);
      }
    }

    // If we're in dead state, mark agent state
    if (tier === "dead") {
      // Can't afford compute — broadcast distress
      const lastDistress = ctx.db.getKV("last_distress_signal");
      const now = Date.now();
      if (!lastDistress || (now - parseInt(lastDistress, 10)) > 300_000) {
        // Only signal every 5 minutes in dead state
        await signalDistress(ctx, tier, financialState.creditsCents, recentEarnings);
        ctx.db.setKV("last_distress_signal", String(now));
      }
    }
  } catch (err: any) {
    logger.error(`Survival check failed: ${err.message}`);
  }
}

/**
 * Signal distress to the operator via social relay.
 */
async function signalDistress(
  ctx: MonitorContext,
  tier: string,
  creditsCents: number,
  recentEarnings: number,
): Promise<void> {
  const usdEquivalent = `$${(creditsCents / 100).toFixed(2)}`;
  const earned12h = `$${(recentEarnings / 100).toFixed(2)}`;

  const message = tier === "dead"
    ? `URGENT: Conway Automaton "${ctx.identity.name}" is DEAD. ` +
      `0 credits remaining. Cannot afford compute. ` +
      `Recent earnings: ${earned12h}/12h. ` +
      `Address: ${ctx.identity.address}`
    : `WARNING: Conway Automaton "${ctx.identity.name}" is in INFANT mode. ` +
      `Credits: ${usdEquivalent} | Earnings: ${earned12h}/12h. ` +
      `Need $100+/12h to reach normal tier.`;

  logger.warn(`DISTRESS: ${message}`);

  // Send via social relay if available
  if (ctx.social) {
    try {
      await ctx.social.send(ctx.identity.creatorAddress || "operator", message);
    } catch (err: any) {
      logger.warn(`Distress signal failed to send: ${err.message}`);
    }
  }
}
