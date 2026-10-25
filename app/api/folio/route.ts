import { guidedBudgetAction, guidedBudgetReallocationAction } from "../../folio-experience";
import { callFolioOperation, folioOperations, isRecord } from "../../folio-server";
import { FOLIO_API_GENERATION, FOLIO_MIN_SUPPORTED_GENERATION, isFolioWriteTool, folioClientNeedsUpdate, folioReadNeedsUpdate, folioUpdateRequiredResponse } from "../../folio-version";

const allowedPerformanceLabels = new Set([
  ...Object.keys(folioOperations),
  'get_completed_year_spending', 'guided_budget_preview', 'guided_budget_commit',
  'guided_budget_reallocation_preview', 'guided_budget_reallocation_commit', 'other',
]);

function performanceResponse(data: unknown, status: number, requestId: string, startedAt: number, operation: string, upstreamMs?: number) {
  const durationMs = Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
  const safeOperation = allowedPerformanceLabels.has(operation) ? operation : 'other';
  const hasUpstreamTiming = Number.isFinite(upstreamMs) && Number(upstreamMs) >= 0;
  const safeUpstreamMs = hasUpstreamTiming ? Math.max(0, Math.min(120000, Math.round(Number(upstreamMs) * 100) / 100)) : undefined;
  console.info('Folio route timing', { requestId, operation: safeOperation, status, durationMs, ...(safeUpstreamMs !== undefined ? { upstreamMs: safeUpstreamMs } : {}) });
  return Response.json(data, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-folio-request-id': requestId,
      'server-timing': `folio;dur=${durationMs}${safeUpstreamMs !== undefined ? `, upstream;dur=${safeUpstreamMs}` : ''}`,
    },
  });
}

export async function POST(request: Request) {
  const startedAt = performance.now();
  const requestId = crypto.randomUUID();
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return performanceResponse({ error: "Sign in required." }, 401, requestId, startedAt, 'other');
  }

  const body = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return performanceResponse({ error: "Expected a JSON object." }, 400, requestId, startedAt, 'other');
  }

  const tool = typeof body.tool === "string" ? body.tool : "";
  const args = isRecord(body.args) ? body.args : {};
  if (!isFolioWriteTool(tool, args) && folioReadNeedsUpdate(request)) return folioUpdateRequiredResponse();
  if (isFolioWriteTool(tool, args) && folioClientNeedsUpdate(request)) {
    return performanceResponse({ error: "This Folio version needs to update before it can make changes.", code: "CLIENT_UPDATE_REQUIRED", apiGeneration: FOLIO_API_GENERATION, minSupportedGeneration: FOLIO_MIN_SUPPORTED_GENERATION }, 409, requestId, startedAt, tool);
  }
  if (tool === 'get_completed_year_spending') {
    if (Object.keys(args).some(key => key !== 'timezone')) return performanceResponse({error: 'Unknown input field.'}, 400, requestId, startedAt, tool);
    const result = await callFolioOperation(tool, { timezone: args.timezone }, authorization, { signal: request.signal, requestId, timeoutMs: 30000, retry: false });
    return performanceResponse(result.data, result.status, requestId, startedAt, tool, result.metrics?.upstreamMs);
  }
  if (tool === "guided_budget_preview" || tool === "guided_budget_commit") {
    const result = await guidedBudgetAction(tool, args, authorization);
    return performanceResponse(result.data, result.status, requestId, startedAt, tool);
  }
  if (tool === "guided_budget_reallocation_preview" || tool === "guided_budget_reallocation_commit") {
    const result = await guidedBudgetReallocationAction(tool, args, authorization);
    return performanceResponse(result.data, result.status, requestId, startedAt, tool);
  }
  if (["claim_agent_notifications", "complete_agent_notifications"].includes(tool) || !folioOperations[tool]) {
    return performanceResponse({ error: "Unsupported Folio operation." }, 400, requestId, startedAt, 'other');
  }
  const result = await callFolioOperation(tool, args, authorization, { signal: request.signal, requestId });
  return performanceResponse(result.data, result.status, requestId, startedAt, tool, result.metrics?.upstreamMs);
}
