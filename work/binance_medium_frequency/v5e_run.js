const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { serializeCsv } = require('./run');
const { weeklyBlockBootstrap } = require('./v2');
const { classifyUniverse, signalAcceptance } = require('./v41_core');
const { trailingStats, FOUR_HOURS } = require('./v41_engine');
const { loadPrepared, quarterWindows } = require('./v41_run');
const { loadPremium } = require('./v5c_features');
const { CONFIGS, scanBreakoutEvents, summarizeBreakoutRun, simulateBreakoutPeriod } = require('./v5d_breakout');
const { filterByMarketRegime } = require('./v5e_regime');

const ROOT = __dirname, DATA = path.join(ROOT, 'v5c_data'), OUTPUT = path.resolve(ROOT, '..', '..', 'outputs');
const RESULT_FILE = path.join(OUTPUT, 'binance_all_perpetuals_v5e_results.json');
const START = Date.parse('2022-01-01T00:00:00Z'), END = Date.parse('2026-06-30T20:00:00Z');
const LAYERS = ['liquid_low_vol','liquid_high_vol','tail_low_vol','tail_high_vol'], BROAD = CONFIGS.find(row => row.configId === 'broad');
const SELECTIONS = { liquid_low_vol: BROAD, liquid_high_vol: BROAD, tail_low_vol: { configId: 'cash' }, tail_high_vol: { configId: 'cash' } };

function buildPlan(prepared) {
  return quarterWindows().map(fold => {
    const layers = classifyUniverse(prepared.map(row => trailingStats(row, fold.startTime)));
    return { ...fold, layers, layerCounts: Object.fromEntries([...new Set(layers.values())].map(layer => [layer, [...layers.values()].filter(value => value === layer).length])) };
  });
}

function runScenario(prepared, events, plans, scenario) {
  const output = { initialEquity: 100000, finalEquity: 100000, trades: [], equity: [], finalSignals: [], executedSignals: 0, quarters: [] }; let capital = output.initialEquity;
  for (const plan of plans) {
    const run = simulateBreakoutPeriod({ preparedSymbols: prepared, events, layers: plan.layers, selections: SELECTIONS, startTime: plan.startTime, endTime: plan.endTime, scenario, initialEquity: capital });
    const startEquity = capital; capital = run.finalEquity; output.trades.push(...run.trades); output.equity.push(...run.equity); output.finalSignals.push(...run.finalSignals); output.executedSignals += run.executedSignals;
    output.quarters.push({ startTime: plan.startTime, endTime: plan.endTime, startEquity, endEquity: capital, totalReturn: capital/startEquity-1, trades: run.summary.trades, signals: run.summary.finalSignals });
  }
  output.finalEquity = capital; output.summary = summarizeBreakoutRun(output); output.summary.signalsPerDay = output.finalSignals.length / ((END-START)/86400000+1); return output;
}

function sideRobust(trades, side) { const pnl = trades.filter(row => row.side === side).map(row => row.netPnl).sort((a,b)=>b-a); return pnl.length >= 30 && pnl.slice(5).reduce((a,b)=>a+b,0)>0; }
function diagnostics(stress, extreme) {
  const positiveQuarterShare = stress.quarters.filter(row => row.totalReturn > 0).length/stress.quarters.length, profitWithoutBest10 = stress.trades.map(row=>row.netPnl).sort((a,b)=>b-a).slice(10).reduce((a,b)=>a+b,0);
  const bootstrap = weeklyBlockBootstrap(stress.trades, START, 50000), longRobust = sideRobust(stress.trades,1), shortRobust = sideRobust(stress.trades,-1);
  const gate = signalAcceptance({ finalSignals: stress.summary.finalSignals, executedSignals: stress.summary.executedSignals, signalsPerDay: stress.summary.signalsPerDay, stress: stress.summary, extreme: extreme.summary, positiveQuarterShare, profitWithoutBest10, bootstrapProbabilityPositive: bootstrap.probabilityPositive, longRobust, shortRobust, profitableLayers: stress.summary.profitableLayers, maxSymbolContribution: stress.summary.maxSymbolContribution });
  gate.checks.drawdown20 = stress.summary.maxDrawdown >= -0.20; gate.checks.positiveQuartersTwoThirds = positiveQuarterShare >= 2/3; gate.checks.bootstrap75 = bootstrap.probabilityPositive >= 0.75; gate.pass = Object.values(gate.checks).every(Boolean); gate.failures = Object.entries(gate.checks).filter(([,ok])=>!ok).map(([name])=>name);
  return { positiveQuarterShare, profitWithoutBest10, bootstrap, longRobust, shortRobust, gate };
}
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function runAll() {
  fs.mkdirSync(OUTPUT,{recursive:true}); const { manifest, prepared } = loadPrepared(); let premiumAttached=0;
  for (const row of prepared) { const file=path.join(DATA,row.market,`${row.symbol}_premium_4h.csv`); if(fs.existsSync(file)){row.premium=loadPremium(file,row.bars);premiumAttached++;} }
  const benchmark=prepared.find(row=>row.market==='um'&&row.symbol==='BTCUSDT'); if(!benchmark) throw new Error('BTCUSDT benchmark unavailable');
  const rawEvents=scanBreakoutEvents(prepared.filter(row=>row.premium),[BROAD],START,END), events=filterByMarketRegime(rawEvents,benchmark), plans=buildPlan(prepared);
  console.error(`v5e broad ${rawEvents.length}; regime ${events.length}`);
  const baseRun=runScenario(prepared,events,plans,'base'), stressRun=runScenario(prepared,events,plans,'stress'), extremeRun=runScenario(prepared,events,plans,'extreme'), acceptance=diagnostics(stressRun,extremeRun);
  const result={ generatedAt:new Date().toISOString(),version:'all-perpetuals-liquid-btc-regime-breakout-v5e',evidenceStatus:'causal_full_history_diagnostic_not_independent_validation',dates:['2022-01-01','2026-06-30'],universe:{requested:manifest.requestedSymbols,prepared:prepared.length,premiumAttached},events:{broad:rawEvents.length,btcRegimeAligned:events.length},design:{layers:['liquid_low_vol','liquid_high_vol'],config:BROAD,benchmarkRegime:'BTCUSDT EMA20 versus EMA50 at signal close',exit:{stopAtr:2,trailAtr:3,maxHoldBars:18}},base:baseRun.summary,stress:stressRun.summary,extreme:extremeRun.summary,quarterlyStress:stressRun.quarters,acceptance,plans:plans.map(plan=>({startTime:plan.startTime,endTime:plan.endTime,layerCounts:plan.layerCounts})),caveats:['This rule was formed after earlier results exposed the historical interval, so it is diagnostic rather than independent validation.','Four-hour OHLC cannot reproduce intrabar paths; stop is checked before trailing-stop updates.','Order-book depth, partial fills, liquidation, ADL, outages and complete delisted history are not fully modeled.']};
  fs.writeFileSync(RESULT_FILE,JSON.stringify(result,null,2)); fs.writeFileSync(path.join(OUTPUT,'binance_all_perpetuals_v5e_signals.csv'),serializeCsv(stressRun.finalSignals,['signalTime','entryTime','market','symbol','baseAsset','layer','configId','side','score','premium','premiumZ','takerShare','volumeRatio','breakoutAtr'])); fs.writeFileSync(path.join(OUTPUT,'binance_all_perpetuals_v5e_trades.csv'),serializeCsv(stressRun.trades,['signalTime','entryTime','exitTime','market','symbol','baseAsset','layer','configId','side','entryPrice','exitPrice','qty','notional','grossPnl','fees','fundingPnl','netPnl','reason','barsHeld'])); fs.writeFileSync(path.join(OUTPUT,'binance_all_perpetuals_v5e_equity.csv'),serializeCsv(stressRun.equity,['time','equity','cash','positions','grossExposure']));
  return {resultFile:RESULT_FILE,sha256:hash(RESULT_FILE),events:result.events,base:result.base,stress:result.stress,extreme:result.extreme,acceptance};
}
if(require.main===module){try{console.log(JSON.stringify(runAll(),null,2));}catch(error){console.error(error.stack||error.message);process.exitCode=1;}}
module.exports={buildPlan,runScenario,diagnostics,runAll};
