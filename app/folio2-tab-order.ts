import type { Folio2Root } from './folio2-navigation';

export const DEFAULT_FOLIO2_TAB_ORDER: Folio2Root[] = ['home','activity','transactions','accounts','plan'];
export const DEFAULT_FOLIO2_WIDGET_ORDER = ['running-spend','net-worth','cash-flow','budgets','subscriptions'] as const;
export type Folio2WidgetId = (typeof DEFAULT_FOLIO2_WIDGET_ORDER)[number];
const VALID_ROOTS=new Set<Folio2Root>(DEFAULT_FOLIO2_TAB_ORDER);
const VALID_WIDGETS=new Set<string>(DEFAULT_FOLIO2_WIDGET_ORDER);
export function parseFolio2TabOrder(value:unknown):Folio2Root[]{
  const rows=Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):[];
  const parsed=rows.filter((item):item is Folio2Root=>VALID_ROOTS.has(item as Folio2Root));
  return [...new Set(parsed),...DEFAULT_FOLIO2_TAB_ORDER.filter((root)=>!parsed.includes(root))];
}
export function parseFolio2WidgetOrder(value:unknown):Folio2WidgetId[]{
  const rows=Array.isArray(value)?value.filter((item):item is Folio2WidgetId=>typeof item==='string'&&VALID_WIDGETS.has(item)):[];
  return [...new Set<Folio2WidgetId>(rows),...DEFAULT_FOLIO2_WIDGET_ORDER.filter((widget)=>!rows.includes(widget))];
}
