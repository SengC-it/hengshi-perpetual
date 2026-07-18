import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const v11Candidate = require('../work/binance_medium_frequency/forward_candidate_v11.json');

export const STRATEGY = Object.freeze({
  name: '衡势 Quant',
  version: 'hengshi-v12.4-shadow-2026q3',
  authorization: 'PAPER_ONLY',
  liveOrdersEnabled: false,
  evidenceStatus: 'FROZEN_CAUSAL_FORWARD_SHADOW',
  validFrom: v11Candidate.validFrom,
  validThrough: v11Candidate.validThrough,
  developmentDataObservedThrough: v11Candidate.developmentDataObservedThrough,
  activeLayers: ['liquid_low_vol', 'liquid_high_vol', 'tail_high_vol'],
  layerAssignments: v11Candidate.layerAssignments,
  portfolio: {
    initialEquity: 100000,
    riskPerTrade: 0.0025,
    symbolCap: 0.35,
    maxSignalsPerBar: 5,
    maxSignalsPerDay: 5,
    maxPositions: 9,
    maxGross: 1.5
  },
  rapidBull: {
    returnLookbackBars: 180,
    minimumReturn: 0.10
  },
  short: {
    mode: 'v11-premium-breakout-ridge',
    model: v11Candidate.model,
    scoreCutoffByLayer: v11Candidate.scoreCutoffByLayer,
    volumeMultiple: 1.10,
    takerEdge: 0.05,
    premiumZ: 0,
    exit: {
      stopAtr: 2,
      trailAtr: 3,
      maxHoldBars: 18,
      meanExitEma20: false
    }
  },
  long: {
    mode: 'v12.4-rapid-bull-reversal',
    scoreQuantile: 0.30,
    scoreCutoff: 1.9612650453850922,
    shockLookbackBars: 6,
    shockAtr: 2.5,
    volumeMultiple: 1.5,
    maximumTrendGap: 0.08,
    exit: {
      stopAtr: 1.5,
      trailAtr: null,
      maxHoldBars: 6,
      meanExitEma20: true
    }
  },
  forwardGate: {
    minimumCalendarDays: 180,
    minimumExecutedTrades: 50,
    minimumLongTrades: 30,
    minimumStressProfitFactor: 1.15,
    maximumDrawdown: -0.20,
    noRuleChanges: true
  },
  implementation: {
    signalInterval: '4h',
    causalSelection: true,
    historicalDailyBestSelectionDisabled: true,
    note: 'Signals are ranked only after the current 4h bar closes; future bars from the same day are never used.'
  }
});

export const EXIT_SHADOW = Object.freeze({
  version: 'hengshi-v12.7-exit-shadow-2026q3',
  authorization: 'PAPER_ONLY',
  liveOrdersEnabled: false,
  baselineVersion: STRATEGY.version,
  short: Object.freeze({
    ...STRATEGY.short.exit,
    maxHoldBars: 24
  }),
  long: Object.freeze({
    ...STRATEGY.long.exit
  })
});

export function assertPaperOnly() {
  if (STRATEGY.authorization !== 'PAPER_ONLY' || STRATEGY.liveOrdersEnabled !== false) {
    throw new Error('strategy safety lock is invalid');
  }
}
