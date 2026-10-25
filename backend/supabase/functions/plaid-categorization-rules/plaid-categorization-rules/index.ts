import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { currentSessionActive } from "../_shared/current-session.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { categorizationRuleMatches } from "../_shared/categorization-rules.ts";

type Row = Record<string, any>;
type Context = { userId: string; householdId: string; role: string };
type Rule = {
  rule_id: string | number;
  match_text: string;
  match_field: "any" | "name" | "merchant_name" | "original_description";
  match_type: "contains" | "exact" | "prefix";
  category: string;
  subcategory?: string | null;
  transfer_network?: string | null;
  transfer_direction?: string | null;
  priority: number;
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const options = { auth: { persistSession: false, autoRefreshToken: false } };
const MAX_ROWS = 20000;
const allowedFields = new Set([
  "action", "household_id", "rule_id", "match_text", "match_field",
  "match_type", "category", "subcategory", "transfer_network",
  "transfer_direction", "priority", "apply_to_existing",
]);

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return json({}, 204);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Sign in required.");

    let body: Row;
    try {
      body = await request.json();
    } catch {
      throw new HttpError(400, "Invalid JSON.");
    }
    if (!isRecord(body)) throw new HttpError(400, "Expected an object.");
    if (Object.keys(body).some((key) => !allowedFields.has(key))) {
      throw new HttpError(400, "Unknown input field.");
    }

    const action = text(body.action, "action", 40);
    if (!["list", "save", "deactivate", "review_zelle"].includes(action)) {
      throw new HttpError(400, "Invalid action.");
    }

    const context = await authenticate(authorization, optionalUuid(body.household_id));
    const db = serviceClient();

    if (action === "list") {
      const { data, error } = await db
        .from("transaction_categorization_rules")
        .select("rule_id,match_text,match_field,match_type,category,subcategory,transfer_network,transfer_direction,priority,active,created_at,updated_at")
        .eq("household_id", context.householdId)
        .eq("active", true)
        .order("priority", { ascending: true })
        .order("created_at", { ascending: true });
      check(error, "Could not list categorization rules.");
      return json({ household_id: context.householdId, rules: data ?? [] });
    }

    if (action === "review_zelle") {
      const transactions = (await loadTransactions(db, context.householdId))
        .filter((row) => [row.name, row.merchant_name, row.original_description]
          .some((value) => normalize(value).includes("zelle")))
        .filter((row) => {
          const category = normalize(row.user_category);
          return !category || category === "zelle transfer" || category === "uncategorized";
        })
        .sort((a, b) => String(b.transaction_date).localeCompare(String(a.transaction_date)))
        .slice(0, 25);
      return json({ household_id: context.householdId, transactions });
    }

    if (action === "deactivate") {
      if (context.role !== "owner") throw new HttpError(403, "Only the household owner can deactivate rules.");
      const ruleId = ruleIdInput(body.rule_id);
      const { data: rule, error: readError } = await db
        .from("transaction_categorization_rules")
        .select("rule_id,match_text,category,active")
        .eq("household_id", context.householdId)
        .eq("rule_id", ruleId)
        .maybeSingle();
      check(readError, "Could not read the categorization rule.");
      if (!rule) throw new HttpError(404, "Categorization rule not found.");

      const { error } = await db
        .from("transaction_categorization_rules")
        .update({ active: false, updated_by: context.userId, updated_at: new Date().toISOString() })
        .eq("household_id", context.householdId)
        .eq("rule_id", ruleId);
      check(error, "Could not deactivate the categorization rule.");
      await audit(db, context, "categorization_rule.deactivated", String(ruleId), {
        category: rule.category,
      });
      return json({ rule: { ...rule, active: false }, transactions_changed: false });
    }

    const requestedRuleId = optionalRuleId(body.rule_id);
    const matchText = text(body.match_text, "match_text", 120);
    const matchField = enumText(body.match_field ?? "any", "match_field", [
      "any", "name", "merchant_name", "original_description",
    ]) as Rule["match_field"];
    const matchType = enumText(body.match_type ?? "contains", "match_type", [
      "contains", "exact", "prefix",
    ]) as Rule["match_type"];
    const categoryInput = text(body.category, "category", 80);
    const subcategory = optionalText(body.subcategory, 80);
    const transferNetwork = optionalText(body.transfer_network, 30);
    const transferDirection = body.transfer_direction === undefined
      ? undefined
      : enumText(body.transfer_direction, "transfer_direction", ["sent", "received", "unknown"]);
    const priority = integer(body.priority, 100, 1, 10000);
    const applyToExisting = body.apply_to_existing !== false;

    const { data: categoryRows, error: categoryError } = await db
      .from("finance_categories")
      .select("category_name")
      .eq("household_id", context.householdId)
      .eq("active", true);
    check(categoryError, "Could not validate the category.");
    const categoryRow = (categoryRows ?? []).find(
      (row: Row) => normalize(row.category_name) === normalize(categoryInput),
    );
    if (!categoryRow) throw new HttpError(400, "Choose an active category from the household category catalog.");

    const now = new Date().toISOString();
    const values: Row = {
      household_id: context.householdId,
      match_text: matchText.trim(),
      match_field: matchField,
      match_type: matchType,
      category: categoryRow.category_name,
      subcategory: subcategory ?? null,
      transfer_network: transferNetwork ?? null,
      transfer_direction: transferDirection ?? null,
      priority,
      active: true,
      updated_by: context.userId,
      updated_at: now,
    };

    let saved: Row;
    let created = false;
    if (requestedRuleId) {
      const { data: existing, error: existingError } = await db
        .from("transaction_categorization_rules")
        .select("rule_id")
        .eq("household_id", context.householdId)
        .eq("rule_id", requestedRuleId)
        .maybeSingle();
      check(existingError, "Could not verify the categorization rule.");
      if (!existing) throw new HttpError(404, "Categorization rule not found.");
      const { data, error } = await db
        .from("transaction_categorization_rules")
        .update(values)
        .eq("household_id", context.householdId)
        .eq("rule_id", requestedRuleId)
        .select()
        .single();
      if (error?.code === "23505") throw new HttpError(409, "An active rule with the same match already exists.");
      check(error, "Could not update the categorization rule.");
      saved = data;
    } else {
      const { data, error } = await db
        .from("transaction_categorization_rules")
        .insert({ ...values, created_by: context.userId, created_at: now })
        .select()
        .single();
      if (error?.code === "23505") throw new HttpError(409, "An active rule with the same match already exists.");
      check(error, "Could not create the categorization rule.");
      saved = data;
      created = true;
    }

    let matchedTransactions = 0;
    if (applyToExisting) {
      matchedTransactions = await applyRuleToExisting(db, context.householdId, saved as Rule);
    }
    await audit(db, context, created ? "categorization_rule.created" : "categorization_rule.updated", String(saved.rule_id), {
      category: saved.category,
      applied_to_existing: applyToExisting,
      matched_transactions: matchedTransactions,
    });
    return json({ created, rule: saved, matched_transactions: matchedTransactions });
  } catch (error) {
    console.error("Categorization rule operation failed", error instanceof Error ? error.message : error);
    const status = error instanceof HttpError ? error.status : 500;
    return json({ error: error instanceof HttpError ? error.message : "Could not manage categorization rules." }, status);
  }
});

async function authenticate(authorization: string, requestedHousehold?: string): Promise<Context> {
  const auth = createClient(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), options);
  const { data, error } = await auth.auth.getUser(authorization.slice(7));
  if (error || !data.user) throw new HttpError(401, "Sign in required.");
  if (!await currentSessionActive(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), authorization)) throw new HttpError(401, "Sign in required.");
  let query = serviceClient().from("finance_household_members")
    .select("household_id,role").eq("user_id", data.user.id);
  if (requestedHousehold) query = query.eq("household_id", requestedHousehold);
  const { data: memberships, error: membershipError } = await query.limit(2);
  check(membershipError, "Could not verify household access.");
  if (!memberships?.length) throw new HttpError(403, "No access to this household.");
  if (memberships.length !== 1) throw new HttpError(400, "Select a household using household_id.");
  return { userId: data.user.id, householdId: memberships[0].household_id, role: memberships[0].role };
}

async function loadTransactions(db: any, householdId: string): Promise<Row[]> {
  const { data: items, error: itemError } = await db.from("plaid_items")
    .select("item_id").eq("household_id", householdId);
  check(itemError, "Could not read household connections.");
  const itemIds = (items ?? []).map((row: Row) => row.item_id);
  if (!itemIds.length) return [];
  const rows: Row[] = [];
  let lastId: string | undefined;
  while (true) {
    let query = db.from("plaid_transactions")
      .select("transaction_id,item_id,account_id,transaction_date,name,merchant_name,original_description,amount,iso_currency_code,pending,user_category,user_subcategory,transfer_network,transfer_direction")
      .in("item_id", itemIds).order("transaction_id").limit(500);
    if (lastId) query = query.gt("transaction_id", lastId);
    const { data, error } = await query;
    check(error, "Could not read household transactions.");
    if (!data?.length) break;
    rows.push(...data);
    if (rows.length > MAX_ROWS) throw new HttpError(422, "Too many transactions to apply this rule safely.");
    lastId = data[data.length - 1].transaction_id;
  }
  return rows;
}

async function applyRuleToExisting(db: any, householdId: string, rule: Rule): Promise<number> {
  const { data: activeRules, error: ruleError } = await db
    .from("transaction_categorization_rules")
    .select("rule_id,match_text,match_field,match_type,category,subcategory,transfer_network,transfer_direction,priority")
    .eq("household_id", householdId)
    .eq("active", true)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });
  check(ruleError, "Could not evaluate categorization rule priority.");

  // Match the same first-rule-wins behavior used during future Plaid syncs.
  // Saving a lower-priority overlapping rule cannot override the current winner.
  const matches = (await loadTransactions(db, householdId)).filter((row) => {
    const winner = (activeRules ?? []).find((candidate: Rule) => categorizationRuleMatches(row, candidate));
    return String(winner?.rule_id) === String(rule.rule_id);
  });
  const changes: Row = { user_category: rule.category, user_subcategory: rule.subcategory ?? null };
  if (rule.transfer_network) changes.transfer_network = rule.transfer_network;
  if (rule.transfer_direction) changes.transfer_direction = rule.transfer_direction;
  for (let offset = 0; offset < matches.length; offset += 200) {
    const chunk = matches.slice(offset, offset + 200);
    const ids = chunk.map((row) => row.transaction_id);
    const itemIds = [...new Set(chunk.map((row) => row.item_id))];
    const { error } = await db.from("plaid_transactions").update(changes)
      .in("item_id", itemIds).in("transaction_id", ids);
    check(error, "Could not apply the rule to existing transactions.");
  }
  return matches.length;
}

async function audit(db: any, context: Context, action: string, entityId: string, metadata: Row) {
  const { error } = await db.from("finance_audit_events").insert({
    household_id: context.householdId,
    actor_user_id: context.userId,
    action,
    entity_type: "categorization_rule",
    entity_id: entityId,
    metadata,
  });
  check(error, "The rule changed, but its audit event could not be recorded.");
}

function serviceClient() {
  return createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), options);
}
function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new HttpError(500, "Server configuration is incomplete.");
  return value;
}
function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new HttpError(400, `Invalid ${name}.`);
  }
  return value.trim();
}
function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, "optional text", max);
}
function enumText(value: unknown, name: string, values: string[]): string {
  const result = text(value, name, 80);
  if (!values.includes(result)) throw new HttpError(400, `Invalid ${name}.`);
  return result;
}
function uuid(value: unknown, name: string): string {
  const result = text(value, name, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) {
    throw new HttpError(400, `Invalid ${name}.`);
  }
  return result;
}
function optionalUuid(value: unknown, name = "household_id"): string | undefined {
  return value === undefined ? undefined : uuid(value, name);
}
function ruleIdInput(value: unknown): string | number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string") throw new HttpError(400, "Invalid rule_id.");
  const result = value.trim();
  if (/^[1-9][0-9]*$/.test(result)) return result;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) return result;
  throw new HttpError(400, "Invalid rule_id.");
}
function optionalRuleId(value: unknown): string | number | undefined {
  return value === undefined ? undefined : ruleIdInput(value);
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new HttpError(400, "Invalid priority.");
  }
  return Number(value);
}
function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}
function check(error: any, message: string) {
  if (error) throw new HttpError(500, message);
}
function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}


