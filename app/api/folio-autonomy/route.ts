import { callFolioOperation, isRecord } from '../../folio-server';
import { folioClientNeedsUpdate, folioUpdateRequiredResponse } from '../../folio-version.ts';

const allowed = new Set(['get_autonomy_state', 'set_autonomy_mode', 'save_autonomy_policy', 'authorize_autonomy_policy', 'undo_autonomy_action', 'run_autonomy_dry_run', 'snooze_autonomy_suggestion']);
const headers = { 'cache-control': 'no-store' };

export async function POST(request: Request) {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return Response.json({ error: 'Sign in required.' }, { status: 401, headers });
  const body = await request.json().catch(() => null);
  if (!isRecord(body) || typeof body.operation !== 'string' || !allowed.has(body.operation)) {
    return Response.json({ error: 'Unsupported autonomy operation.' }, { status: 400, headers });
  }
  if (body.operation !== 'get_autonomy_state' && folioClientNeedsUpdate(request)) return folioUpdateRequiredResponse();
  const args = isRecord(body.args) ? body.args : {};
  if (body.operation === 'set_autonomy_mode' && (!Number.isInteger(args.expected_version) || Number(args.expected_version) < 0 || !['recommend', 'ask', 'auto'].includes(String(args.mode)))) {
    return Response.json({ error: 'Refresh and review how Folio can help.' }, { status: 400, headers });
  }
  if (body.operation === 'get_autonomy_state' && args.period_key !== undefined && (typeof args.period_key !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(args.period_key))) {
    return Response.json({ error: 'Choose a valid month.' }, { status: 400, headers });
  }
  if (body.operation === 'snooze_autonomy_suggestion' && args.action_type !== 'reallocate_budget') return Response.json({ error: 'This suggestion is unavailable.' }, { status: 400, headers });
  const result = await callFolioOperation(body.operation, args, authorization);
  return Response.json(result.data, { status: result.status, headers });
}
