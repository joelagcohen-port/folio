"use client";
import { useEffect, useRef, useState } from "react";
import { FolioCompactSheet } from "./folio-compact-sheet";

export type FolioFilterDraft = { focus: "all"; month: string; category: string; months: Array<{value:string;label:string}>; categories: Array<{value:string;label:string}>; accounts: Array<{id:string;label:string}>; accountIds: string[] };
export function FolioFilterSheet({ open, request, onClose, onApply }: { open:boolean; request:FolioFilterDraft|null; onClose:()=>void; onApply:(draft:FolioFilterDraft)=>void }) {
  const [draft,setDraft]=useState<FolioFilterDraft|null>(request);const previousSignature=useRef("");const currentDraft=useRef<FolioFilterDraft|null>(draft);currentDraft.current=draft;
  const signature=request?JSON.stringify(request):"";
  useEffect(()=>{if(!open){previousSignature.current="";setDraft(request);currentDraft.current=request;return;}if(request&&signature!==previousSignature.current){previousSignature.current=signature;setDraft(request);currentDraft.current=request;}},[signature,request,open]);
  return <FolioCompactSheet open={open} onOpenChange={next=>{if(!next)onClose();}} title="Transaction filters" description="Choose month, category, and accounts">
    {draft&&<div className="folio-filter-sheet-body">
      <label>Month<select aria-label="Month" value={draft.month} onChange={event=>setDraft({...draft,month:event.target.value})}>{draft.months.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label>Category<select aria-label="Category" value={draft.category} onChange={event=>setDraft({...draft,category:event.target.value})}>{draft.categories.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <fieldset><legend>Accounts</legend>{draft.accounts.length?draft.accounts.map(account=><label key={account.id}><input type="checkbox" checked={draft.accountIds.includes(account.id)} onChange={event=>setDraft({...draft,accountIds:event.target.checked?[...new Set([...draft.accountIds,account.id])]:draft.accountIds.filter(id=>id!==account.id)})}/><span>{account.label}</span></label>):<p>No connected accounts are available.</p>}</fieldset>
      <div className="folio-filter-sheet-actions"><button type="button" className="is-primary" onClick={()=>{onApply(draft);currentDraft.current=null;previousSignature.current="";setDraft(null);}}>Apply filters</button></div>
    </div>}
  </FolioCompactSheet>;
}
