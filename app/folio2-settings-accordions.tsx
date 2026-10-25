'use client';
import { Bell, Fingerprint, LayoutDashboard, Link2, ListOrdered, Palette, RefreshCw, ScanEye, Settings, Sparkles } from 'lucide-react';
type InitialScreen='overview'|'history';
type Props={
  onAppearance:()=>void;onTabOrder:()=>void;onReorderWidgets:()=>void;
  onAssistant:(screen:InitialScreen)=>void;onNotifications:()=>void;onRules:()=>void;
  onAccounts:()=>void;onRefresh:()=>void;onPasskeys:()=>void;onAccountSignIn:()=>void;onDiagnostics:()=>void;
};
export function Folio2SettingsAccordions(props:Props){
  return <div className="folio2-settings-accordions">
    <details><summary><Palette size={18} aria-hidden="true"/><span><strong>Personalize</strong><small>Appearance, navigation, and layout</small></span></summary>
      <button className="dashboard-menu-row" type="button" onClick={props.onAppearance}><Palette size={18} aria-hidden="true"/><span className="dashboard-menu-label">Appearance</span><span aria-hidden="true">›</span></button>
      <button className="dashboard-menu-row" type="button" onClick={props.onTabOrder}><ListOrdered size={18} aria-hidden="true"/><span className="dashboard-menu-label">Customize tab order</span><span aria-hidden="true">›</span></button>
      <button className="dashboard-menu-row" type="button" onClick={props.onReorderWidgets}><LayoutDashboard size={18} aria-hidden="true"/><span className="dashboard-menu-label">Reorder widgets</span><span aria-hidden="true">›</span></button>
    </details>
    <details><summary><Sparkles size={18} aria-hidden="true"/><span><strong>Folio Assistant</strong><small>Intelligence, recommendations, automatic actions</small></span></summary>
      <button className="dashboard-menu-row" type="button" onClick={()=>props.onAssistant('overview')}><Sparkles size={18} aria-hidden="true"/><span className="dashboard-menu-label">Automatic actions &amp; permissions</span><span aria-hidden="true">›</span></button>
      <button className="dashboard-menu-row" type="button" onClick={()=>props.onAssistant('history')}><Settings size={18} aria-hidden="true"/><span className="dashboard-menu-label">Activity/history</span><span aria-hidden="true">›</span></button>
    </details>
    <details><summary><Bell size={18} aria-hidden="true"/><span><strong>Notifications &amp; rules</strong><small>Alerts, categorization, and refunds</small></span></summary>
      <button className="dashboard-menu-row" type="button" onClick={props.onNotifications}><Bell size={18} aria-hidden="true"/><span className="dashboard-menu-label">Notifications</span><span aria-hidden="true">›</span></button>
      <button className="dashboard-menu-row" type="button" onClick={props.onRules}><Settings size={18} aria-hidden="true"/><span className="dashboard-menu-label">Transaction rules and refund preference</span><span aria-hidden="true">›</span></button>
    </details>
    <details><summary><Link2 size={18} aria-hidden="true"/><span><strong>Data &amp; connections</strong><small>Connected accounts and data refresh</small></span></summary>
      <button className="dashboard-menu-row" type="button" onClick={props.onAccounts}><Link2 size={18} aria-hidden="true"/><span className="dashboard-menu-label">Connected accounts</span><span aria-hidden="true">›</span></button>
      <button className="dashboard-menu-row" type="button" onClick={props.onRefresh}><RefreshCw size={18} aria-hidden="true"/><span className="dashboard-menu-label">Data refresh and repair</span><span aria-hidden="true">›</span></button>
    </details>
    <details><summary><Fingerprint size={18} aria-hidden="true"/><span><strong>Security &amp; advanced</strong><small>Sign-in, diagnostics, and controls</small></span></summary>
      <button className="dashboard-menu-row" type="button" onClick={props.onPasskeys}><Fingerprint size={18} aria-hidden="true"/><span className="dashboard-menu-label">Face ID/passkeys</span><span aria-hidden="true">›</span></button>
      <button className="dashboard-menu-row" type="button" onClick={props.onAccountSignIn}><Settings size={18} aria-hidden="true"/><span className="dashboard-menu-label">Account sign-in</span><span aria-hidden="true">›</span></button>
      <button className="dashboard-menu-row" type="button" onClick={props.onDiagnostics}><ScanEye size={18} aria-hidden="true"/><span className="dashboard-menu-label">Advanced diagnostics</span><span aria-hidden="true">›</span></button>
    </details>
    <aside className="folio2-settings-personal-note"><strong>Your settings are personal where appropriate</strong><p>Appearance, tab order, and notifications apply to the individual user. Financial budgets and authorized household actions remain household-scoped.</p></aside>
  </div>;
}
