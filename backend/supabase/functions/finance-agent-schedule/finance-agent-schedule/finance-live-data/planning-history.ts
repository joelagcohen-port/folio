import {verifiedDatedSnapshot,compareVerifiedForecasts} from './forecast-series.ts';
// Never reconstruct a historical series from incomplete events or compare mixed scopes.
export function summarizePlanningHistory(rows:any[],horizon:number,truncated=false,timezone='UTC'){
 const eligible=rows.filter(row=>row.horizon_days===horizon&&(row.source_provenance?.forecast_inputs?.timezone===timezone||row.source_provenance?.forecast_inputs?.timezone==null));
 const snapshots=eligible.map(row=>{const verified=verifiedDatedSnapshot(row);return{generated_at:row.generated_at,request_started_at:row.request_started_at??null,quality:row.input_quality??'unknown_legacy',verified:!!verified,stale:!verified,starting_balance:verified?.starting_balance??null,projected_low:verified?.projected_low??null,low_date:verified?.low_date??null,ending_balance:verified?.ending_balance??null,series_contract:row.source_provenance?.forecast_inputs?.series_contract??null,coverage:row.coverage??null};});
 const changes=eligible.slice(1).map((row,i)=>compareVerifiedForecasts(eligible[i],row));
 return{horizon_days:horizon,timezone,snapshot_count:snapshots.length,truncated,changes_truncated:changes.length>8,range_start:snapshots[0]?.generated_at??null,range_end:snapshots.at(-1)?.generated_at??null,snapshots,changes:changes.slice(-8),low_range:null,quality_note:'Only complete, verified series with identical household, account source scope, timezone, horizon and calendar dates can be compared. Legacy or incomplete series are not reconstructed.'};
}
