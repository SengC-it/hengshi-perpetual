const fs = require('fs');
const path = require('path');
const { classifyUniverse } = require('./v41_core');
const { trailingStats } = require('./v41_engine');
const { loadPrepared, quarterWindows } = require('./v41_run');
const { loadPremium } = require('./v5c_features');
const { CONFIGS, scanBreakoutEvents, summarizeBreakoutRun, simulateBreakoutPeriod } = require('./v5d_breakout');

const ROOT=__dirname,DATA=path.join(ROOT,'v5c_data'),OUTPUT=path.resolve(ROOT,'..','..','outputs'),START=Date.parse('2022-01-01T00:00:00Z'),END=Date.parse('2026-06-30T20:00:00Z');
function plans(prepared){return quarterWindows().map(fold=>({...fold,layers:classifyUniverse(prepared.map(row=>trailingStats(row,fold.startTime)))}));}
function simulateFixed(prepared,events,folds,market,config,scenario){
  const output={initialEquity:100000,finalEquity:100000,trades:[],equity:[],finalSignals:[],executedSignals:0,quarters:[]};let capital=100000;
  for(const fold of folds){
    const selections={liquid_low_vol:config,liquid_high_vol:config,tail_low_vol:{configId:'cash'},tail_high_vol:{configId:'cash'}};
    const run=simulateBreakoutPeriod({preparedSymbols:prepared,events:events.filter(row=>row.market===market),layers:fold.layers,selections,startTime:fold.startTime,endTime:fold.endTime,scenario,initialEquity:capital,maxPerBar:2});
    const before=capital;capital=run.finalEquity;output.trades.push(...run.trades);output.equity.push(...run.equity);output.finalSignals.push(...run.finalSignals);output.executedSignals+=run.executedSignals;output.quarters.push(capital/before-1);
  }
  output.finalEquity=capital;const summary=summarizeBreakoutRun(output);summary.signalsPerDay=output.finalSignals.length/((END-START)/86400000+1);summary.positiveQuarterShare=output.quarters.filter(x=>x>0).length/output.quarters.length;return summary;
}
function run(){
  const {prepared}=loadPrepared();for(const row of prepared){const file=path.join(DATA,row.market,`${row.symbol}_premium_4h.csv`);if(fs.existsSync(file))row.premium=loadPremium(file,row.bars);}
  const events=scanBreakoutEvents(prepared.filter(row=>row.premium),CONFIGS,START,END),folds=plans(prepared),results={};
  for(const config of CONFIGS)results[config.configId]=Object.fromEntries(['base','stress','extreme'].map(scenario=>[scenario,simulateFixed(prepared,events,folds,'cm',config,scenario)]));
  fs.writeFileSync(path.join(OUTPUT,'binance_all_perpetuals_v5f_cm_category_screen.json'),JSON.stringify({evidenceStatus:'post_hoc_category_neighborhood_screen',results},null,2));return results;
}
if(require.main===module){try{console.log(JSON.stringify(run(),null,2));}catch(error){console.error(error.stack||error.message);process.exitCode=1;}}
module.exports={simulateFixed,run};
