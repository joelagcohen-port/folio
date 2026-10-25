"use client";

import { useEffect, useLayoutEffect, useRef, useState, type TouchEvent } from "react";
import { Ellipsis, RotateCcw } from "lucide-react";
import { FolioCompactSheet } from "./folio-compact-sheet";

export type FolioAlertRow = {
  key: string; eventId?: string; eventVersion?: number | string; eventType?: string;
  householdId?: string; actorUserId?: string; userDisposition?: string | null; userStateUpdatedAt?: string | null;
  title: string; detail: string; severity?: string; page?: string; planId?: string; goalId?: string;
  transactionId?: string; refundTransactionId?: string; uncategorizedTransactionIds?: string[];
  synthetic?: boolean; actionType?: string;
};
type HistoryRow = { event_id: string; event_version: number | string; fingerprint: string; event_type: string; title: string; summary: string; disposition: string; snoozed_until?: string | null; updated_at?: string | null; household_id?: string; actor_user_id?: string; can_restore: boolean };
type PendingDisposition = { tool: string; args: Record<string, unknown>; userId: string; householdId: string };

async function folioOperation(token: string, tool: string, args: Record<string, unknown>) {
  const response = await fetch("/api/folio", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-folio-api-generation": String(process.env.NEXT_PUBLIC_FOLIO_API_GENERATION || 1) }, body: JSON.stringify({ tool, args }), signal: AbortSignal.timeout(35000), cache: "no-store" });
  const data = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) { const error = new Error(String(data.error || "Could not update this alert.")); (error as Error & { status?: number }).status = response.status; throw error; }
  return data;
}

const dispositionLabel: Record<string, string> = { acknowledged: "Got it", dismissed: "Dismissed", snoozed: "Snoozed" };
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validVersion=(value:unknown)=>typeof value==="number"?Number.isSafeInteger(value)&&value>0:typeof value==="string"&&/^[1-9]\d*$/.test(value)&&Number.isSafeInteger(Number(value));
function readStoredPending(userId:string):Record<string,PendingDisposition>{try{const value=JSON.parse(sessionStorage.getItem(`folio-r3-alert-pending:${userId}`)||"{}");return value&&typeof value==="object"&&!Array.isArray(value)?value:{}}catch{return {}}}
function validPendingOperation(value:any,userId:string,householdId:string,eventId:string,eventVersion:string|number,tool:string):value is PendingDisposition {
  const args=value?.args;
  if(!value||value.userId!==userId||value.householdId!==householdId||value.tool!==tool||!args||typeof args!=='object'||Array.isArray(args)||args.event_id!==eventId||String(args.event_version)!==String(eventVersion)||typeof args.idempotency_key!=='string'||!uuidPattern.test(args.idempotency_key))return false;
  if(typeof args.expected_state_updated_at==='string'&&!Number.isFinite(Date.parse(args.expected_state_updated_at)))return false;
  if(args.expected_state_updated_at!==null&&typeof args.expected_state_updated_at!=='string')return false;
  if(tool==='restore_agent_event_v2')return args.expected_disposition==='dismissed';
  return ['acknowledged','dismissed','snoozed'].includes(args.disposition)&& (args.expected_disposition===null||['dismissed','expected','wrong','acknowledged','snoozed','acted','restored'].includes(args.expected_disposition))&&(args.disposition!=='snoozed'||args.snooze_days===7);
}

export function FolioAlertsSheet({ open, rows, token, userId, onClose, onOpenSource, onChanged }: {
  open: boolean; rows: FolioAlertRow[]; token: string; userId: string; onClose: () => void;
  onOpenSource: (row: FolioAlertRow) => void; onChanged: () => void;
}) {
  const [tab, setTab] = useState<"attention" | "history">("attention");
  const [selected, setSelected] = useState<FolioAlertRow | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [swipedId, setSwipedId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [historyStatus, setHistoryStatus] = useState("");
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const hiddenDisposition = useRef(new Map<string,{disposition:string;updatedAt:string;snoozedUntil:string|null}>());
  const staleEvents = useRef(new Set<string>());
  const conflictBaseline = useRef(new Map<string,string>());
  const pending = useRef(new Map<string, PendingDisposition>());
  const inFlight = useRef(new Set<string>());
  const expectedHousehold = useRef<string | null>(null);
  const previousUser = useRef(userId);
  if (previousUser.current !== userId) expectedHousehold.current = null;
  const visibleHousehold = rows.find(row => row.actorUserId === userId && typeof row.householdId === "string")?.householdId;
  if (visibleHousehold) expectedHousehold.current = visibleHousehold;
  const householdScope = visibleHousehold || expectedHousehold.current || "unknown-household";
  const contextGeneration = useRef(0);
  const context = useRef({ key: `${userId}:${token}:${householdScope}`, open, generation: 0 });
  const historyRequest = useRef(0);
  const previousHouseholdScope = useRef(householdScope);
  context.current = { ...context.current, key: `${userId}:${token}:${householdScope}`, open };
  useLayoutEffect(() => {
    contextGeneration.current += 1;
    context.current = { key: `${userId}:${token}:${householdScope}`, open, generation: contextGeneration.current };
    historyRequest.current += 1;
    setBusyId(null); setErrors({}); setHistory([]); setHistoryStatus("");
    if (previousUser.current !== userId) { expectedHousehold.current = null; pending.current.clear(); staleEvents.current.clear(); conflictBaseline.current.clear(); hiddenDisposition.current.clear(); previousUser.current = userId; setHiddenIds(new Set()); setSelected(null); }
    if (previousHouseholdScope.current !== householdScope) { previousHouseholdScope.current = householdScope; staleEvents.current.clear(); conflictBaseline.current.clear(); hiddenDisposition.current.clear(); setSelected(null); setMenuId(null); setSwipedId(null); setHiddenIds(new Set()); }
    if (!open) { setSelected(null); setMenuId(null); setSwipedId(null); }
  }, [open, userId, token, householdScope]);
  useLayoutEffect(() => {
    if (householdScope === "unknown-household") return;
    const stored=readStoredPending(userId);
    for(const [identity,operation] of Object.entries(stored)) {
      const args=operation?.args; if(!args||typeof args.event_id!=="string"||!(typeof args.event_version==="string"||Number.isSafeInteger(args.event_version)))continue;
      const valid=validPendingOperation(operation,userId,householdScope,args.event_id,args.event_version,operation.tool);
      if(valid&&(operation.tool==="apply_agent_event_disposition"||operation.tool==="restore_agent_event_v2"))pending.current.set(identity,operation);
    }
  }, [userId, householdScope]);
  const touchStart = useRef<{ id: string; x: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);

  async function loadHistory() {
    const captured = context.current.key, capturedGeneration = context.current.generation;
    const request = ++historyRequest.current;
    setHistoryStatus("Loading history…");
    try {
      const data = await folioOperation(token, "list_agent_event_history", {});
      if (context.current.key !== captured || context.current.generation !== capturedGeneration || !context.current.open || historyRequest.current !== request) return;
      const valid = Array.isArray(data.events) && uuidPattern.test(String(data.household_id||"")) && (!expectedHousehold.current || data.household_id === expectedHousehold.current) && data.actor_user_id === userId && data.events.every((item: any) => item && item.household_id === data.household_id && item.actor_user_id === userId && uuidPattern.test(String(item.event_id||"")) && validVersion(item.event_version) && ["dismissed","expected","wrong","acknowledged","snoozed","acted","restored"].includes(item.disposition) && typeof item.updated_at === "string" && Number.isFinite(Date.parse(item.updated_at)) && typeof item.can_restore === "boolean" && (!item.can_restore||item.disposition==="dismissed") && typeof item.title==="string" && typeof item.summary==="string");
      if (valid) { setHistory(data.events); setHistoryStatus(""); const ids=new Set(data.events.map((item:any)=>item.event_id));setErrors(current=>Object.fromEntries(Object.entries(current).filter(([id])=>!ids.has(id)))); }
      else { setHistory([]); setHistoryStatus("Saved alert history is unavailable."); }
    } catch (error) { if (context.current.key === captured && context.current.generation === capturedGeneration && context.current.open && historyRequest.current === request) setHistoryStatus((error as Error).message || "Saved alert history is unavailable."); }
  }
  useEffect(() => { if (open && tab === "history") void loadHistory(); }, [open, tab, token, userId, householdScope]);
  useEffect(() => {
    const changed=new Set<string>();
    const restoreHidden=new Set<string>();
    for(const row of rows){if(!row.eventId)continue;const hiddenKey=`${row.eventId}:${row.eventVersion}`;const expected=hiddenDisposition.current.get(hiddenKey);const snoozeExpired=expected?.snoozedUntil&&Number.isFinite(Date.parse(expected.snoozedUntil))&&Date.now()>=Date.parse(expected.snoozedUntil);if(expected&&row.actorUserId===userId&&row.householdId===householdScope&&(Boolean(snoozeExpired)||(Boolean(row.userStateUpdatedAt)&&row.userStateUpdatedAt!==expected.updatedAt))){hiddenDisposition.current.delete(hiddenKey);restoreHidden.add(hiddenKey);}if(!staleEvents.current.has(row.eventId))continue;const baseline=`${row.householdId}:${row.eventVersion}:${row.userDisposition??""}:${row.userStateUpdatedAt??""}`;if(conflictBaseline.current.get(row.eventId)!==baseline){staleEvents.current.delete(row.eventId);conflictBaseline.current.delete(row.eventId);changed.add(row.eventId);}}
    if(restoreHidden.size)setHiddenIds(current=>{const next=new Set(current);for(const id of restoreHidden)next.delete(id);return next;});
    if(changed.size)setErrors(current=>Object.fromEntries(Object.entries(current).filter(([id])=>!changed.has(id))));
  },[rows]);
  useEffect(() => { if (!selected && tab === "attention" && listRef.current) listRef.current.scrollTop = savedScroll.current; }, [selected, tab]);

  function saveOperation(row: FolioAlertRow, disposition: "acknowledged" | "dismissed" | "snoozed") {
    if (!row.eventId || row.eventVersion == null) return null;
    const householdId = row.householdId || "";
    const requestedIdentity = `${userId}:${householdId}:${row.eventId}:${String(row.eventVersion)}:${disposition}`;
    for (const [identity, operation] of pending.current) if (operation.userId === userId && operation.householdId === householdId && operation.args.event_id === row.eventId && String(operation.args.event_version) === String(row.eventVersion)) return { identity, operation };
    const stored=readStoredPending(userId);
    const retained = Object.entries(stored).find(([, operation]) => operation?.userId === userId && operation?.householdId === householdId && operation.args?.event_id === row.eventId && String(operation.args?.event_version) === String(row.eventVersion));
    const identity = retained?.[0] || requestedIdentity;
    const operation = retained?.[1] || { tool: "apply_agent_event_disposition", userId, householdId, args: { event_id: row.eventId, event_version: row.eventVersion, expected_disposition: row.userDisposition ?? null, expected_state_updated_at: row.userStateUpdatedAt ?? null, disposition, idempotency_key: crypto.randomUUID(), ...(disposition === "snoozed" ? { snooze_days: 7 } : {}) } };
    if (!validPendingOperation(operation,userId,householdId,row.eventId,row.eventVersion,"apply_agent_event_disposition")) { setErrors(current => ({ ...current, [row.eventId!]: "This response could not be safely retried. Refresh alerts before continuing." })); return null; }
    pending.current.set(identity, operation);
    stored[identity] = operation;
    try { sessionStorage.setItem(`folio-r3-alert-pending:${userId}`, JSON.stringify(stored)); } catch {}
    return { identity, operation };
  }
  function forgetOperation(identity: string, owner = userId) {
    pending.current.delete(identity);
    const stored=readStoredPending(owner);delete stored[identity];try{sessionStorage.setItem(`folio-r3-alert-pending:${owner}`,JSON.stringify(stored));}catch{}
  }
  async function dispose(row: FolioAlertRow, disposition: "acknowledged" | "dismissed" | "snoozed") {
    if (!row.eventId || row.eventVersion == null || row.householdId == null || row.actorUserId !== userId || staleEvents.current.has(row.eventId)) return;
    const saved = saveOperation(row, disposition); if (!saved) return;
    if (inFlight.current.has(saved.identity)) return;
    inFlight.current.add(saved.identity);
    const capturedContext = context.current.key, capturedGeneration = context.current.generation;
    setBusyId(row.eventId); setErrors(current => ({ ...current, [row.eventId!]: "" }));
    try {
      const effectiveDisposition = saved.operation.args.disposition as "acknowledged" | "dismissed" | "snoozed";
      const result = await folioOperation(token, saved.operation.tool, saved.operation.args);
      if (result.saved !== true || result.household_id !== row.householdId || result.actor_user_id !== userId || result.event_id !== row.eventId || String(result.event_version) !== String(row.eventVersion) || result.disposition !== effectiveDisposition || !result.user_state_updated_at) throw new Error("Folio could not verify the saved alert response. Refresh alerts before continuing.");
      forgetOperation(saved.identity, saved.operation.userId); if (context.current.key !== capturedContext || context.current.generation !== capturedGeneration || !context.current.open) return;
      const hiddenKey=`${row.eventId}:${row.eventVersion}`;hiddenDisposition.current.set(hiddenKey,{disposition:effectiveDisposition,updatedAt:result.user_state_updated_at,snoozedUntil:effectiveDisposition==="snoozed"&&typeof result.snoozed_until==="string"?result.snoozed_until:null});setHiddenIds(current => new Set(current).add(hiddenKey)); setSelected(null); setMenuId(null); setSwipedId(null); onChanged();
      if (tab === "history") await loadHistory();
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status !== undefined && status < 500) forgetOperation(saved.identity, saved.operation.userId);
      if (context.current.key !== capturedContext || context.current.generation !== capturedGeneration || !context.current.open) return;
      if(status===409){staleEvents.current.add(row.eventId!);conflictBaseline.current.set(row.eventId!,`${row.householdId}:${row.eventVersion}:${row.userDisposition??""}:${row.userStateUpdatedAt??""}`);}
      setErrors(current => ({ ...current, [row.eventId!]: status === 409 ? "This alert changed. Refresh it before responding." : (error as Error).message || "Could not save this response." }));
      onChanged();
    } finally { inFlight.current.delete(saved.identity); if (context.current.key === capturedContext && context.current.generation === capturedGeneration && context.current.open) setBusyId(null); }
  }
  async function restore(row: HistoryRow) {
    if (!row.can_restore || row.disposition !== "dismissed" || row.actor_user_id !== userId || !row.household_id || !row.updated_at) return;
    const identity = `${userId}:${row.household_id}:${row.event_id}:${String(row.event_version)}:restore`;
    if (inFlight.current.has(identity)) return;
    let operation = pending.current.get(identity);
    const stored=readStoredPending(userId);if (!operation) { operation = stored[identity] || { tool: "restore_agent_event_v2", userId, householdId: row.household_id, args: { event_id: row.event_id, event_version: row.event_version, expected_disposition: "dismissed", expected_state_updated_at: row.updated_at, idempotency_key: crypto.randomUUID() } }; pending.current.set(identity, operation); stored[identity] = operation; try { sessionStorage.setItem(`folio-r3-alert-pending:${userId}`, JSON.stringify(stored)); } catch {} }
    if (!validPendingOperation(operation,userId,row.household_id,row.event_id,row.event_version,"restore_agent_event_v2")) return;
    inFlight.current.add(identity);
    const capturedContext = context.current.key, capturedGeneration = context.current.generation;
    setBusyId(row.event_id); setErrors(current => ({ ...current, [row.event_id]: "" }));
    try {
      const result = await folioOperation(token, operation.tool, operation.args);
      if (result.restored !== true || result.household_id !== row.household_id || result.actor_user_id !== userId || result.event_id !== row.event_id || String(result.event_version) !== String(row.event_version) || result.disposition !== "restored" || !result.user_state_updated_at) throw new Error("Folio could not verify the restore. Refresh alerts before continuing.");
      forgetOperation(identity, operation.userId); if (context.current.key !== capturedContext || context.current.generation !== capturedGeneration || !context.current.open) return; setHiddenIds(current => { const next=new Set(current); next.delete(`${row.event_id}:${row.event_version}`); return next; }); onChanged(); await loadHistory();
    } catch (error) { const status = (error as Error & { status?: number }).status; if (status !== undefined && status < 500) forgetOperation(identity, operation.userId); if (context.current.key === capturedContext && context.current.generation === capturedGeneration && context.current.open) setErrors(current => ({ ...current, [row.event_id]: (error as Error).message || "Could not restore this alert." })); }
    finally { inFlight.current.delete(identity); if (context.current.key === capturedContext && context.current.generation === capturedGeneration && context.current.open) setBusyId(null); }
  }
  function backToList() { if (listRef.current) savedScroll.current = listRef.current.scrollTop; setSelected(null); }
  const active = rows.filter(row => !row.eventId || !hiddenIds.has(`${row.eventId}:${row.eventVersion}`));
  const hasPending = (row: FolioAlertRow) => [...pending.current.values()].some(operation => operation.userId === userId && operation.householdId===row.householdId && operation.args.event_id === row.eventId && String(operation.args.event_version) === String(row.eventVersion));
  const pendingOperation = (row: FolioAlertRow) => [...pending.current.values()].find(operation => operation.userId === userId && operation.householdId===row.householdId && operation.args.event_id === row.eventId && String(operation.args.event_version) === String(row.eventVersion));
  const operationInFlight = (row: FolioAlertRow) => [...pending.current.entries()].some(([key, operation]) => operation.userId === userId && operation.householdId===row.householdId && operation.args.event_id === row.eventId && String(operation.args.event_version) === String(row.eventVersion) && inFlight.current.has(key));
  const retryBlocked = (row:FolioAlertRow)=>Boolean(row.eventId&&staleEvents.current.has(row.eventId));
  const retry = (row: FolioAlertRow) => { const operation = row.eventId ? pendingOperation(row) : undefined; if (operation) void dispose(row, operation.args.disposition as "acknowledged" | "dismissed" | "snoozed"); };
  const historyRows = history;
  const beginSwipe = (event: TouchEvent, row: FolioAlertRow) => { if (row.eventId) touchStart.current = { id: row.eventId, x: event.touches[0]?.clientX ?? 0 }; };
  const endSwipe = (event: TouchEvent) => { const start = touchStart.current; if (!start) return; const delta = (event.changedTouches[0]?.clientX ?? start.x) - start.x; if (delta < -48) setSwipedId(start.id); else if (delta > 48) setSwipedId(null); touchStart.current = null; };

  return <FolioCompactSheet open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Alerts" description={selected ? "Alert details" : `${active.length} item${active.length === 1 ? "" : "s"} worth reviewing`} className="folio-alerts-sheet" dismissBlocked={Boolean(busyId)}>
    {selected ? <div className="folio-alert-detail">
      <button type="button" className="folio-alert-back" onClick={backToList}>← All alerts</button>
      <h3>{selected.title}</h3><p>{selected.detail}</p>
      {selected.synthetic && <p className="folio-alert-synthetic-note">Status notice · This item is for awareness.</p>}
      <button type="button" className="folio-alert-source" onClick={() => { onClose(); onOpenSource(selected); }}>Review source</button>
      {selected.eventId && <div className="folio-alert-detail-actions">
        {retryBlocked(selected)?<button type="button" onClick={onChanged}>Refresh alerts</button>:hasPending(selected) ? <button type="button" disabled={busyId === selected.eventId || operationInFlight(selected)} onClick={() => retry(selected)}>Retry {dispositionLabel[String(pendingOperation(selected)?.args.disposition)] || "response"}</button> : <>
          <button type="button" disabled={busyId === selected.eventId || hasPending(selected)} onClick={() => void dispose(selected, "acknowledged")}>Got it</button>
          <button type="button" disabled={busyId === selected.eventId || hasPending(selected)} onClick={() => void dispose(selected, "snoozed")}>Snooze 1 week</button>
          <button type="button" className="is-danger" disabled={busyId === selected.eventId || hasPending(selected)} onClick={() => void dispose(selected, "dismissed")}>Dismiss</button>
        </>}
      </div>}
      {selected.eventId && errors[selected.eventId] && <p role="alert">{errors[selected.eventId]}</p>}
    </div> : <>
      <div className="folio-alert-tabs" role="tablist" aria-label="Alerts"><button type="button" role="tab" aria-selected={tab === "attention"} onClick={() => { setTab("attention"); setMenuId(null); }}>Needs attention <span>{active.length}</span></button><button type="button" role="tab" aria-selected={tab === "history"} onClick={() => { setTab("history"); setMenuId(null); }}>History</button></div>
      {tab === "attention" ? <div ref={listRef} className="folio-alert-sheet-list">{active.length ? active.map(row => <article key={row.key} className={`folio-alert-sheet-row ${swipedId === row.eventId ? "is-swiped" : ""}`} onTouchStart={event => beginSwipe(event, row)} onTouchEnd={endSwipe}>
        <button className="folio-alert-sheet-row-main" type="button" onClick={() => { if (listRef.current) savedScroll.current = listRef.current.scrollTop; setSelected(row); setMenuId(null); }}><span className={`folio-alert-dot ${row.severity === "critical" ? "is-critical" : row.severity === "warning" ? "is-warning" : ""}`} aria-hidden="true" /><span><strong>{row.title}</strong><small>{row.detail}</small>{row.synthetic && <em>Status notice</em>}</span></button>
        {row.eventId ? <div className="folio-alert-sheet-row-actions"><button type="button" aria-label={`More actions for ${row.title}`} aria-expanded={menuId === row.eventId} onClick={() => setMenuId(menuId === row.eventId ? null : row.eventId!)}><Ellipsis aria-hidden="true" /></button>{menuId === row.eventId && <div role="group" aria-label={`Actions for ${row.title}`}>{retryBlocked(row)?<button type="button" onClick={onChanged}>Refresh alerts</button>:hasPending(row) ? <button type="button" disabled={busyId === row.eventId || operationInFlight(row)} onClick={() => retry(row)}>Retry {dispositionLabel[String(pendingOperation(row)?.args.disposition)] || "response"}</button> : <><button type="button" disabled={busyId === row.eventId} onClick={() => void dispose(row, "snoozed")}>Snooze</button><button type="button" disabled={busyId === row.eventId} onClick={() => void dispose(row, "dismissed")}>Dismiss</button></>}</div>}{swipedId === row.eventId && <button className="folio-alert-swipe-dismiss" type="button" disabled={busyId === row.eventId || hasPending(row) || retryBlocked(row)} onClick={() => void dispose(row, "dismissed")}>Dismiss</button>}{errors[row.eventId] && <span className="folio-alert-inline-error" role="alert">{errors[row.eventId]}</span>}</div> : <span className="folio-alert-no-actions" aria-hidden="true">·</span>}
      </article>) : <p className="folio-alert-empty">Everything looks on track.</p>}</div> : <div className="folio-alert-sheet-list">{historyStatus && !history.length ? <p className="folio-alert-empty" role="status">{historyStatus}</p> : historyRows.length ? historyRows.map(row => <article key={`${row.event_id}:${row.event_version}`} className="folio-alert-history-row"><div><strong>{row.title}</strong><small>{row.summary}</small><span>{dispositionLabel[row.disposition] || row.disposition}{row.snoozed_until ? ` · Until ${new Date(row.snoozed_until).toLocaleDateString()}` : ""}</span>{errors[row.event_id] && <small role="alert">{errors[row.event_id]}</small>}</div>{row.can_restore && row.disposition === "dismissed" && <button type="button" disabled={busyId === row.event_id} onClick={() => void restore(row)} aria-label={errors[row.event_id] ? `Retry restore ${row.title}` : `Restore ${row.title}`}><RotateCcw aria-hidden="true" />{errors[row.event_id] ? "Retry restore" : "Restore"}</button>}</article>) : <p className="folio-alert-empty">No saved alert history.</p>}</div>}
    </>}
  </FolioCompactSheet>;
}
