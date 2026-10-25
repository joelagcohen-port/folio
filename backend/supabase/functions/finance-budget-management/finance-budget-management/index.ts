import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { currentSessionActive } from "../_shared/current-session.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;

const responseHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  "content-type": "application/json",
  "cache-control": "no-store",
};

class SafeError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: responseHeaders,
    });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const authorization = request.headers.get("authorization");
    const userId = await authenticate(authorization);

    if (!userId) {
      return json({ error: "Unauthorized" }, 401);
    }

    const body: unknown = await request.json().catch(() => null);

    if (!isRecord(body)) {
      throw new SafeError("The request body must be a JSON object.");
    }

    const action = requiredString(body.action, "action", 40);
    if (action === "review_target_save") return await reviewBudgetTargetSave(userId, body);
    if (action === "confirm_target_save") return await confirmBudgetTargetSave(userId, body);
    if (action === "review_budget_move") return await reviewBudgetMove(userId, body);
    if (action === "confirm_budget_move") return await confirmBudgetMove(userId, body, false);
    if (action === "review_budget_move_undo") return await reviewBudgetMoveUndo(userId, body);
    if (action === "confirm_budget_move_undo") return await confirmBudgetMove(userId, body, true);
    if (["review_budget_rollover_edit", "confirm_budget_rollover_edit", "get_budget_rollover_state"].includes(action)) return await budgetRolloverEditAction(userId, body, action);
    if (["review_budget_rollover", "confirm_budget_rollover", "review_rollover_correction", "confirm_rollover_correction", "get_budget_rollover_capacity"].includes(action)) return await budgetRolloverAction(userId, body, action);
    const context = await householdContext(userId);

    if (action === "list") {
      assertOnlyKeys(body, ["action"]);
      return await listTargets(context.householdId);
    }

    if (action === "save") {
      assertOnlyKeys(body, [
        "action",
        "budget_target_id",
        "category",
        "emoji",
        "subcategory",
        "monthly_target_amount",
        "currency_code",
      ]);

      return await saveTarget(
        context.householdId,
        userId,
        body,
      );
    }

    if (action === "deactivate") {
      assertOnlyKeys(body, ["action", "budget_target_id"]);

      return await deactivateTarget(
        context.householdId,
        userId,
        body,
      );
    }

    if ([
      "reallocate",
      "guided_budget_reallocation_preview",
      "guided_budget_reallocation_commit",
    ].includes(action)) {
      const preview = action === "guided_budget_reallocation_preview";
      const committing = action === "guided_budget_reallocation_commit" || action === "reallocate";
      assertOnlyKeys(body, [
        "action",
        "from_budget_target_id",
        "to_budget_target_id",
        "expected_from_target",
        "expected_to_target",
        "amount",
        "confirm",
      ]);
      if (committing && body.confirm !== true) {
        throw new SafeError("Confirm the reviewed transfer before moving budget money.");
      }

      const fromTargetId = requiredUuid(body.from_budget_target_id, "from_budget_target_id");
      const toTargetId = requiredUuid(body.to_budget_target_id, "to_budget_target_id");
      const expectedFrom = requiredMoney(body.expected_from_target, "expected_from_target");
      const expectedTo = requiredMoney(body.expected_to_target, "expected_to_target");
      const amount = requiredMoney(body.amount, "amount");
      if (fromTargetId === toTargetId) throw new SafeError("Choose two different budget categories.");
      if (amount <= 0 || Math.abs(Number(body.amount) * 100 - Math.round(Number(body.amount) * 100)) > 0.00001) {
        throw new SafeError("Enter a valid transfer amount with at most two decimal places.");
      }

      const { data: targets, error: targetsError } = await serviceClient()
        .from("finance_budget_targets")
        .select("budget_target_id, category, monthly_target_amount, currency_code, active")
        .eq("household_id", context.householdId)
        .eq("active", true)
        .in("budget_target_id", [fromTargetId, toTargetId]);
      if (targetsError) {
        console.error("Could not verify budget transfer targets", targetsError.message);
        throw new SafeError("Budget details could not be verified.", 500);
      }
      const from = (targets ?? []).find((target) => target.budget_target_id === fromTargetId);
      const to = (targets ?? []).find((target) => target.budget_target_id === toTargetId);
      if (!from || !to) throw new SafeError("One of these active budget targets is no longer available. Refresh Budget and try again.", 409);
      const fromTarget = Number(from.monthly_target_amount);
      const toTarget = Number(to.monthly_target_amount);
      if (!Number.isFinite(fromTarget) || !Number.isFinite(toTarget) || from.currency_code !== "USD" || to.currency_code !== "USD") {
        throw new SafeError("This experience currently supports USD budgets only.", 422);
      }
      if (fromTarget !== expectedFrom || toTarget !== expectedTo) {
        throw new SafeError("A budget target changed since this preview. Refresh Budget and review a new preview.", 409);
      }
      if (amount > fromTarget) throw new SafeError("The source target cannot go below zero.", 422);

      const proposal = {
        from_budget_target_id: fromTargetId,
        to_budget_target_id: toTargetId,
        expected_from_target: fromTarget,
        expected_to_target: toTarget,
        amount,
        from_category: from.category,
        to_category: to.category,
      };
      if (preview) return json({ proposal });

      const { data, error } = await serviceClient().rpc("reallocate_budget_targets", {
        p_household_id: context.householdId,
        p_actor_id: userId,
        p_from_target_id: fromTargetId,
        p_to_target_id: toTargetId,
        p_expected_from: expectedFrom,
        p_expected_to: expectedTo,
        p_amount: amount,
      });
      if (error) throw new SafeError(error.message || "Could not move money between these budgets.", 409);
      const transfer = Array.isArray(data) ? data[0] : data;
      if (!isRecord(transfer)) throw new SafeError("Folio could not verify the budget transfer.", 500);
      return json({ saved: true, transfer });
    }

    if (action === "apply_plan_suggestion") {
      assertOnlyKeys(body, ["action", "confirm", "plan_id", "plan_version", "state_version", "financial_revision", "recommendation_id", "category_id", "expected_target", "proposed_target", "potential_reduction"]);
      if (body.confirm !== true) throw new SafeError("Confirm this category change before applying it.");
      const planVersion = body.plan_version;
      if (!Number.isInteger(planVersion) || Number(planVersion) < 1) throw new SafeError("Refresh Planning before applying this suggestion.", 409);
      const { data, error } = await serviceClient().rpc("apply_financial_plan_budget_adjustment", {
        p_household_id: context.householdId,
        p_user_id: userId,
        p_plan_id: requiredUuid(body.plan_id, "plan_id"),
        p_plan_version: Number(planVersion),
        p_state_version: requiredString(body.state_version, "state_version", 160),
        p_financial_revision: requiredString(body.financial_revision, "financial_revision", 160),
        p_recommendation_id: requiredString(body.recommendation_id, "recommendation_id", 160),
        p_category_id: requiredUuid(body.category_id, "category_id"),
        p_expected_target: requiredMoney(body.expected_target, "expected_target"),
        p_proposed_target: requiredMoney(body.proposed_target, "proposed_target"),
        p_potential_reduction: requiredMoney(body.potential_reduction, "potential_reduction"),
      });
      if (error) throw new SafeError(error.message || "This suggestion is no longer current. Refresh Planning.", 409);
      return json(data);
    }

    if (action === "reject_plan_suggestion") {
      assertOnlyKeys(body, ["action", "plan_id", "plan_version", "state_version", "financial_revision", "recommendation_id", "category_id", "scope"]);
      const planVersion = body.plan_version;
      if (!Number.isInteger(planVersion) || Number(planVersion) < 1) throw new SafeError("Refresh Planning before responding to this suggestion.", 409);
      const scope = requiredString(body.scope, "scope", 20);
      if (!["decline", "this_month", "plan_duration", "permanent"].includes(scope)) throw new SafeError("Choose a valid response.");
      const { data, error } = await serviceClient().rpc("reject_financial_plan_budget_suggestion", {
        p_household_id: context.householdId,
        p_user_id: userId,
        p_plan_id: requiredUuid(body.plan_id, "plan_id"),
        p_plan_version: Number(planVersion),
        p_state_version: requiredString(body.state_version, "state_version", 160),
        p_financial_revision: requiredString(body.financial_revision, "financial_revision", 160),
        p_recommendation_id: requiredString(body.recommendation_id, "recommendation_id", 160),
        p_category_id: requiredUuid(body.category_id, "category_id"),
        p_scope: scope,
      });
      if (error) throw new SafeError(error.message || "This suggestion is no longer current. Refresh Planning.", 409);
      return json(data);
    }

    throw new SafeError("Unknown action.");
  } catch (error) {
    if (error instanceof SafeError) {
      return json(error.code ? { error: error.message, code: error.code } : { error: error.message }, error.status);
    }

    console.error(
      "Budget management failed",
      error instanceof Error ? error.message : error,
    );

    return json(
      { error: "The budget operation could not be completed." },
      500,
    );
  }
});

async function listTargets(householdId: string): Promise<Response> {
  const db = serviceClient();
  const [targetsResult, categoriesResult] = await Promise.all([
    db
      .from("finance_budget_targets")
      .select(
        "budget_target_id, category, subcategory, monthly_target_amount, currency_code, active, created_at, updated_at, version",
      )
      .eq("household_id", householdId)
      .eq("active", true)
      .order("category", { ascending: true })
      .order("subcategory", { ascending: true, nullsFirst: true }),
    db
      .from("finance_categories")
      .select(
        "category_id, system_key, category_type, group_name, category_name, emoji, sort_order, excluded_from_budget, excluded_from_cash_flow, version",
      )
      .eq("household_id", householdId)
      .eq("category_type", "expense")
      .eq("active", true)
      .eq("excluded_from_budget", false)
      .order("sort_order", { ascending: true }),
  ]);

  if (targetsResult.error || categoriesResult.error) {
    console.error(
      "Could not list budget data",
      targetsResult.error?.message ?? categoriesResult.error?.message,
    );
    throw new SafeError("Could not list budget targets.", 500);
  }

  const categories = categoriesResult.data ?? [];
  const versionedCategories = categories.map((category) => ({ ...category, category_version: category.version }));
  const categoryByName = new Map(
    versionedCategories.map((category) => [
      normalize(category.category_name),
      category,
    ]),
  );

  const targets = (targetsResult.data ?? []).map((target) => ({
    ...target,
    category_id: categoryByName.get(normalize(target.category))?.category_id ?? null,
    category_version: categoryByName.get(normalize(target.category))?.category_version ?? null,
  }));

  return json({ targets, categories: versionedCategories });
}

async function saveTarget(
  householdId: string,
  userId: string,
  body: JsonRecord,
): Promise<Response> {
  const targetId = optionalUuid(
    body.budget_target_id,
    "budget_target_id",
  );

  const categoryInput = requiredString(
    body.category,
    "category",
    80,
  );

  const subcategory = optionalString(
    body.subcategory,
    "subcategory",
    80,
  );

  const monthlyTargetAmount = requiredMoney(
    body.monthly_target_amount,
    "monthly_target_amount",
  );

  const currencyCode = optionalString(
    body.currency_code,
    "currency_code",
    3,
  )?.toUpperCase() ?? "USD";

  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    throw new SafeError("Invalid currency_code.");
  }

  const db = serviceClient();
  const { data: categoryRows, error: categoryError } = await db
    .from("finance_categories")
    .select("category_id,category_name,emoji")
    .eq("household_id", householdId)
    .eq("category_type", "expense")
    .eq("active", true)
    .eq("excluded_from_budget", false);

  if (categoryError) {
    console.error("Could not validate budget category", categoryError.message);
    throw new SafeError("Could not validate the budget category.", 500);
  }

  const categoryRow = (categoryRows ?? []).find(
    (row) => normalize(row.category_name) === normalize(categoryInput),
  );

  if (!categoryRow) {
    throw new SafeError(
      "Choose an active expense category from the household budget catalog.",
    );
  }

  let emoji = categoryRow.emoji;
  if (body.emoji !== undefined) {
    emoji = requiredString(body.emoji, "emoji", 16);
    const { error: emojiError } = await db
      .from("finance_categories")
      .update({ emoji })
      .eq("household_id", householdId)
      .eq("category_id", categoryRow.category_id);

    if (emojiError) {
      console.error("Could not update budget category icon", emojiError.message);
      throw new SafeError("Could not update the budget category icon.", 500);
    }
  }

  const category = categoryRow.category_name;
  let existingId = targetId;

  if (targetId) {
    const { data, error } = await db
      .from("finance_budget_targets")
      .select("budget_target_id")
      .eq("household_id", householdId)
      .eq("budget_target_id", targetId)
      .eq("active", true)
      .maybeSingle();

    if (error) {
      console.error("Could not verify budget target", error.message);
      throw new SafeError("Could not verify the budget target.", 500);
    }

    if (!data) {
      throw new SafeError("The active budget target was not found.", 404);
    }
  } else {
    const { data, error } = await db
      .from("finance_budget_targets")
      .select("budget_target_id, category, subcategory")
      .eq("household_id", householdId)
      .eq("active", true)
      .limit(500);

    if (error) {
      console.error("Could not check existing targets", error.message);
      throw new SafeError("Could not check existing budget targets.", 500);
    }

    const normalizedCategory = normalize(category);
    const normalizedSubcategory = normalize(subcategory ?? "");

    const match = (data ?? []).find((target) =>
      normalize(target.category) === normalizedCategory &&
      normalize(target.subcategory ?? "") === normalizedSubcategory
    );

    existingId = match?.budget_target_id;
  }

  const values = {
    category,
    subcategory,
    monthly_target_amount: monthlyTargetAmount,
    currency_code: currencyCode,
    updated_by: userId,
  };

  if (existingId) {
    const { data, error } = await db
      .from("finance_budget_targets")
      .update(values)
      .eq("household_id", householdId)
      .eq("budget_target_id", existingId)
      .eq("active", true)
      .select(
        "budget_target_id, category, subcategory, monthly_target_amount, currency_code, active, created_at, updated_at",
      )
      .single();

    if (error) {
      console.error("Could not update budget target", error.message);
      throw new SafeError("Could not update the budget target.", 500);
    }

    return json({ saved: true, created: false, target: { ...data, emoji } });
  }

  const { data, error } = await db
    .from("finance_budget_targets")
    .insert({
      household_id: householdId,
      ...values,
      created_by: userId,
    })
    .select(
      "budget_target_id, category, subcategory, monthly_target_amount, currency_code, active, created_at, updated_at",
    )
    .single();

  if (error) {
    console.error("Could not create budget target", error.message);

    if (error.code === "23505") {
      throw new SafeError(
        "An active target already exists for this category and subcategory.",
        409,
      );
    }

    throw new SafeError("Could not create the budget target.", 500);
  }

  return json({ saved: true, created: true, target: { ...data, emoji } });
}

async function deactivateTarget(
  householdId: string,
  userId: string,
  body: JsonRecord,
): Promise<Response> {
  const targetId = requiredUuid(
    body.budget_target_id,
    "budget_target_id",
  );

  const db = serviceClient();

  const { data: existing, error: readError } = await db
    .from("finance_budget_targets")
    .select(
      "budget_target_id, category, subcategory, monthly_target_amount, currency_code",
    )
    .eq("household_id", householdId)
    .eq("budget_target_id", targetId)
    .eq("active", true)
    .maybeSingle();

  if (readError) {
    console.error("Could not read budget target", readError.message);
    throw new SafeError("Could not verify the budget target.", 500);
  }

  if (!existing) {
    throw new SafeError("The active budget target was not found.", 404);
  }

  const { error: updateError } = await db
    .from("finance_budget_targets")
    .update({
      active: false,
      updated_by: userId,
    })
    .eq("household_id", householdId)
    .eq("budget_target_id", targetId)
    .eq("active", true);

  if (updateError) {
    console.error("Could not deactivate budget target", updateError.message);
    throw new SafeError("Could not deactivate the budget target.", 500);
  }

  return json({
    deactivated: true,
    target: existing,
  });
}

async function authenticate(
  authorization: string | null,
): Promise<string | null> {
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const client = createClient(
    required("SUPABASE_URL"),
    required("SUPABASE_ANON_KEY"),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );

  const { data, error } = await client.auth.getUser(
    authorization.slice(7),
  );

  if (error || !data.user?.id) return null;
  if (!await currentSessionActive(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), authorization)) return null;
  return data.user.id;
}

async function householdContext(
  userId: string,
): Promise<{ householdId: string; role: string }> {
  const { data, error } = await serviceClient()
    .from("finance_household_members")
    .select("household_id, role")
    .eq("user_id", userId)
    .limit(2);

  if (error) {
    console.error("Could not verify household membership", error.message);
    throw new SafeError(
      "Could not verify household membership.",
      500,
    );
  }

  if (!data?.length) {
    throw new SafeError(
      "Your signed-in account is not a household member.",
      403,
    );
  }

  if (data.length !== 1) {
    throw new SafeError(
      "Multiple household memberships require household selection support.",
      409,
    );
  }

  return {
    householdId: data[0].household_id,
    role: data[0].role,
  };
}

async function explicitHousehold(userId: string, value: unknown): Promise<string> {
  const householdId = requiredUuid(value, "household_id");
  const { data, error } = await serviceClient().from("finance_household_members")
    .select("household_id").eq("household_id", householdId).eq("user_id", userId).maybeSingle();
  if (error) throw new SafeError("Could not verify household membership.", 503);
  if (!data) throw new SafeError("Your signed-in account is not a member of this household.", 403);
  return householdId;
}

async function reviewBudgetTargetSave(userId: string, body: JsonRecord): Promise<Response> {
  assertOnlyKeys(body, ["action", "household_id", "category_id", "budget_target_id", "subcategory", "currency_code", "monthly_target_amount", "emoji"]);
  const householdId = await explicitHousehold(userId, body.household_id);
  const categoryId = requiredUuid(body.category_id, "category_id");
  const targetId = optionalUuid(body.budget_target_id, "budget_target_id");
  const amount = requiredCents(body.monthly_target_amount, "monthly_target_amount");
  const emoji = body.emoji === null ? null : requiredString(body.emoji, "emoji", 32);
  const request: JsonRecord = { category_id: categoryId, ...(targetId ? { budget_target_id: targetId } : {}), monthly_target_amount: amount, emoji };
  if (targetId) {
    if (body.currency_code !== undefined || body.subcategory !== undefined) throw new SafeError("Target currency and subcategory are fixed.");
  } else {
    request.currency_code = requiredString(body.currency_code, "currency_code", 3);
    request.subcategory = body.subcategory === undefined || body.subcategory === null || body.subcategory === "" ? null : requiredString(body.subcategory, "subcategory", 80);
    if (!/^[A-Z]{3}$/.test(String(request.currency_code))) throw new SafeError("Choose a valid currency code.");
  }
  let result: { data: unknown; error: { code?: string; message?: string } | null };
  try {
    result = await serviceClient().rpc("finance_review_budget_target_save", {
      p_household_id: householdId, p_actor_user_id: userId, p_request: request,
    });
  } catch (error) {
    console.error("Budget target review transport failed", error instanceof Error ? error.message : error);
    throw new SafeError("The review could not be loaded.", 503);
  }
  const { data, error } = result;
  if (error) throw budgetRpcError(error, false);
  if (!isRecord(data) || !isRecord(data.review)) throw new SafeError("Folio could not verify the budget target review.", 503);
  return json(data);
}

async function confirmBudgetTargetSave(userId: string, body: JsonRecord): Promise<Response> {
  assertOnlyKeys(body, ["action", "household_id", "review", "idempotency_key", "confirm"]);
  const householdId = await explicitHousehold(userId, body.household_id);
  if (body.confirm !== true) throw new SafeError("Confirm the reviewed budget change before saving.");
  if (!isRecord(body.review)) throw new SafeError("The budget review is missing.");
  const idempotencyKey = requiredUuid(body.idempotency_key, "idempotency_key");
  let result: { data: unknown; error: { code?: string; message?: string } | null };
  try {
    result = await serviceClient().rpc("finance_confirm_budget_target_save", {
      p_household_id: householdId, p_actor_user_id: userId, p_idempotency_key: idempotencyKey,
      p_review: body.review, p_confirm: true,
    });
  } catch (error) {
    console.error("Budget target confirmation transport failed", error instanceof Error ? error.message : error);
    throw new SafeError("The save outcome is unknown. Retry this exact request.", 503, "UNKNOWN_OUTCOME");
  }
  const { data, error } = result;
  if (error) throw budgetRpcError(error, true);
  if (!isRecord(data) || data.saved !== true || typeof data.receipt_id !== "string") {
    throw new SafeError("The save outcome is unknown. Retry this exact request.", 503, "UNKNOWN_OUTCOME");
  }
  return json(data);
}

async function reviewBudgetMove(userId: string, body: JsonRecord): Promise<Response> {
  assertOnlyKeys(body, ["action", "household_id", "from_budget_target_id", "to_budget_target_id", "amount", "expected_from_target_version", "expected_to_target_version", "expected_from_category_version", "expected_to_category_version"]);
  const householdId = await explicitHousehold(userId, body.household_id);
  const fromId = requiredUuid(body.from_budget_target_id, "from_budget_target_id");
  const toId = requiredUuid(body.to_budget_target_id, "to_budget_target_id");
  const amount = requiredCents(body.amount, "amount");
  const expectedFromVersion = requiredVersion(body.expected_from_target_version, "expected_from_target_version");
  const expectedToVersion = requiredVersion(body.expected_to_target_version, "expected_to_target_version");
  const expectedFromCategoryVersion = requiredVersion(body.expected_from_category_version, "expected_from_category_version");
  const expectedToCategoryVersion = requiredVersion(body.expected_to_category_version, "expected_to_category_version");
  if (fromId === toId || amount <= 0) throw new SafeError("Choose different categories and a positive amount.");
  return await callMoveRpc("finance_review_budget_move", {
    p_household_id: householdId, p_actor_user_id: userId, p_from_target_id: fromId, p_to_target_id: toId, p_amount: amount,
    p_expected_from_version: expectedFromVersion, p_expected_to_version: expectedToVersion,
    p_expected_from_category_version: expectedFromCategoryVersion, p_expected_to_category_version: expectedToCategoryVersion,
  }, false, true);
}

async function reviewBudgetMoveUndo(userId: string, body: JsonRecord): Promise<Response> {
  assertOnlyKeys(body, ["action", "household_id", "move_id"]);
  const householdId = await explicitHousehold(userId, body.household_id);
  const moveId = requiredUuid(body.move_id, "move_id");
  return await callMoveRpc("finance_review_budget_move_undo", { p_household_id: householdId, p_actor_user_id: userId, p_move_id: moveId }, false, true);
}

async function confirmBudgetMove(userId: string, body: JsonRecord, undo: boolean): Promise<Response> {
  assertOnlyKeys(body, ["action", "household_id", "review", "idempotency_key", "confirm"]);
  const householdId = await explicitHousehold(userId, body.household_id);
  if (body.confirm !== true) throw new SafeError("Confirm the reviewed budget move before saving.");
  if (!isRecord(body.review)) throw new SafeError("The budget move review is missing.");
  const key = requiredUuid(body.idempotency_key, "idempotency_key");
  const name = undo ? "finance_confirm_budget_move_undo" : "finance_confirm_budget_move";
  return await callMoveRpc(name, { p_household_id: householdId, p_actor_user_id: userId, p_idempotency_key: key, p_review: body.review, p_confirm: true }, true, false);
}

async function callMoveRpc(name: string, args: JsonRecord, writing: boolean, reviewing: boolean): Promise<Response> {
  let result: { data: unknown; error: { code?: string; message?: string } | null };
  try { result = await serviceClient().rpc(name, args); }
  catch (error) {
    console.error("Budget move RPC transport failed", error instanceof Error ? error.message : error);
    throw new SafeError(writing ? "The move outcome is unknown. Retry this exact request." : "The budget move could not be reviewed.", 503, writing ? "UNKNOWN_OUTCOME" : undefined);
  }
  if (result.error) throw budgetMoveRpcError(result.error, writing);
  if (!isRecord(result.data)) throw new SafeError(writing ? "The move outcome is unknown. Retry this exact request." : "The budget move review could not be verified.", 503, writing ? "UNKNOWN_OUTCOME" : undefined);
  if (reviewing && !isRecord(result.data.review)) throw new SafeError("The budget move review could not be verified.", 503);
  const bound = reviewing && isRecord(result.data.review) ? result.data.review : result.data;
  if (bound.household_id !== args.p_household_id || bound.actor_user_id !== args.p_actor_user_id) {
    throw new SafeError(writing ? "The move outcome is unknown. Retry this exact request." : "The budget move review could not be verified.", 503, writing ? "UNKNOWN_OUTCOME" : undefined);
  }
  if (writing && (result.data.saved !== true || typeof result.data.receipt_id !== "string" || typeof result.data.move_id !== "string")) {
    throw new SafeError("The move outcome is unknown. Retry this exact request.", 503, "UNKNOWN_OUTCOME");
  }
  return json(result.data);
}

function budgetMoveRpcError(error: { code?: string; message?: string }, writing: boolean): SafeError {
  const code = String(error.code ?? "");
  if (["40001", "23505", "P0002"].includes(code)) return new SafeError("The budget targets changed since review. Review the move again.", 409, "STALE_REVIEW");
  if (["22023", "22P02", "22003", "23502", "23514"].includes(code)) return new SafeError("The budget move request is invalid.", 400, "INVALID_REQUEST");
  if (code === "42501") return new SafeError("Household membership could not be verified.", 403);
  console.error("Budget move candidate RPC failed", error.message ?? code);
  return new SafeError(writing ? "The move outcome is unknown. Retry this exact request." : "The budget move could not be reviewed.", 503, writing ? "UNKNOWN_OUTCOME" : undefined);
}

function requiredVersion(value: unknown, name: string): string {
  const raw = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,18}$/.test(raw) || BigInt(raw) > 9223372036854775807n) {
    throw new SafeError(`Invalid ${name}.`);
  }
  return raw;
}

function budgetRpcError(error: { code?: string; message?: string }, writing: boolean): SafeError {
  const code = String(error.code ?? "");
  if (["40001", "23505", "P0002"].includes(code)) return new SafeError("The budget target changed since review. Review it again.", 409, "STALE_REVIEW");
  if (["22023", "22P02", "22003", "23502", "23514"].includes(code)) return new SafeError("The budget target request is invalid.", 400, "INVALID_REQUEST");
  if (code === "42501") return new SafeError("Household membership could not be verified.", 403);
  if (code === "25001") return new SafeError("The budget operation could not be safely completed.", 503, writing ? "UNKNOWN_OUTCOME" : undefined);
  console.error("Budget target candidate RPC failed", error.message ?? code);
  return new SafeError(writing ? "The save outcome is unknown. Retry this exact request." : "The review could not be loaded.", 503, writing ? "UNKNOWN_OUTCOME" : undefined);
}

function requiredCents(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 999999999999.99) {
    throw new SafeError(`Invalid ${name}.`);
  }
  const cents = value * 100;
  const nearest = Math.round(cents);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(cents)) * 2;
  if (!Number.isSafeInteger(nearest) || Math.abs(cents - nearest) > tolerance) {
    throw new SafeError(`Enter ${name} with at most two decimal places.`);
  }
  return value;
}

function serviceClient() {
  return createClient(
    required("SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}

function required(name: string): string {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error("Server configuration is incomplete.");
  }

  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value);
}

function assertOnlyKeys(
  body: JsonRecord,
  allowed: string[],
): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new SafeError("Unknown request field.");
  }
}

function requiredString(
  value: unknown,
  name: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > maximumLength
  ) {
    throw new SafeError(`Invalid ${name}.`);
  }

  return value.trim();
}

function optionalString(
  value: unknown,
  name: string,
  maximumLength: number,
): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > maximumLength
  ) {
    throw new SafeError(`Invalid ${name}.`);
  }

  return value.trim();
}

function requiredMoney(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 999999999999.99
  ) {
    throw new SafeError(`Invalid ${name}.`);
  }

  return Math.round(value * 100) / 100;
}

function optionalUuid(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return requiredUuid(value, name);
}

function requiredUuid(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) {
    throw new SafeError(`Invalid ${name}.`);
  }

  return value;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

async function budgetRolloverAction(userId: string, body: JsonRecord, action: string): Promise<Response> {
  const writing = action.startsWith("confirm_");
  const reviewing = action.startsWith("review_");
  const correction = action.includes("correction");
  const fields = writing ? ["review_id", "idempotency_key", "confirm"] : reviewing
    ? correction ? ["budget_target_id", "setting_version"] : ["budget_target_id", "category_id", "enabled", "timezone"]
    : ["budget_target_id", "month"];
  assertOnlyKeys(body, ["action", "household_id", ...fields]);
  const householdId = await explicitHousehold(userId, body.household_id);
  const args: JsonRecord = { h: householdId, a: userId };
  let name: string;
  let targetId: string | undefined;
  let reviewId: string | undefined;
  if (writing) {
    if (body.confirm !== true) throw new SafeError("Confirm the reviewed rollover change before saving.");
    reviewId = requiredUuid(body.review_id, "review_id");
    args.r = reviewId; args.k = requiredUuid(body.idempotency_key, "idempotency_key"); args.confirmed = true;
    name = correction ? "finance_confirm_budget_rollover_correction" : "finance_confirm_budget_rollover";
  } else {
    targetId = requiredUuid(body.budget_target_id, "budget_target_id"); args.t = targetId;
    if (reviewing && correction) {
      if (!Number.isSafeInteger(body.setting_version) || Number(body.setting_version) < 1) throw new SafeError("An exact rollover setting version is required.");
      args.v = body.setting_version; name = "finance_review_budget_rollover_correction";
    } else if (reviewing) {
      if (typeof body.enabled !== "boolean") throw new SafeError("Choose the rollover setting explicitly.");
      args.c = requiredUuid(body.category_id, "category_id"); args.enabled = body.enabled; args.tz = requiredString(body.timezone, "timezone", 100);
      try { new Intl.DateTimeFormat("en-US", { timeZone: String(args.tz) }); } catch { throw new SafeError("Choose a valid timezone."); }
      name = "finance_review_budget_rollover";
    } else {
      const month = requiredString(body.month, "month", 10);
      if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(month)) throw new SafeError("A calendar month start is required.");
      args.m = month; name = "finance_get_budget_rollover_capacity";
    }
  }
  let result: { data: unknown; error: { code?: string; message?: string } | null };
  const unknown = () => new SafeError(writing ? "The save outcome is unknown. Retry this exact request." : "Rollover could not be verified.", 503, writing ? "UNKNOWN_OUTCOME" : undefined);
  try { result = await serviceClient().rpc(name, args); } catch { throw unknown(); }
  if (result.error) {
    if (result.error.code === "42501") throw new SafeError("Household membership is required.", 403);
    if (result.error.code === "22023") throw new SafeError("The rollover request is invalid.", 400);
    if (["40001", "23505"].includes(result.error.code ?? "")) throw new SafeError("Rollover or its sources changed. Review again.", 409);
    if (result.error.code === "P0002") throw new SafeError("Rollover accounting is unavailable until its source history is resolved.", 409);
    throw unknown();
  }
  const data = result.data;
  if (!isRecord(data)) throw unknown();
  const expectedKind = correction ? "rollover_correction" : "rollover_setting";
  if (writing || reviewing) {
    if (!isRecord(data.review) || data.review.kind !== expectedKind || data.review.household_id !== householdId || data.review.actor_user_id !== userId || typeof data.review.budget_target_id !== "string") throw unknown();
    if (reviewing && (data.review.budget_target_id !== targetId || typeof data.review_id !== "string")) throw unknown();
    if (writing && (data.saved !== true || data.household_id !== householdId || data.actor_user_id !== userId || data.review_id !== reviewId || data.budget_target_id !== data.review.budget_target_id)) throw unknown();
    if (correction) {
      if (!Array.isArray(data.review.periods) || data.review.periods.length === 0 || !data.review.periods.every((entry) => isRecord(entry) && typeof entry.month === "string" && /^\d{4}-(0[1-9]|1[0-2])-01$/.test(entry.month) && rolloverEvidence(entry.before, householdId, String((data.review as JsonRecord).budget_target_id)) && rolloverEvidence(entry.after, householdId, String((data.review as JsonRecord).budget_target_id)) && Number.isSafeInteger(entry.opening_delta_cents) && (entry.closing_delta_cents === null || Number.isSafeInteger(entry.closing_delta_cents))) || data.review.original_history_preserved !== true || !Number.isSafeInteger(data.review.current_available_delta_cents)) throw unknown();
    } else if (typeof data.review.after_enabled !== "boolean" || data.review.base_target_unchanged !== true || data.review.history_preserved !== true || data.review.negative_carry !== false || data.review.currency_code !== "USD" || !Number.isSafeInteger(data.review.base_target_cents) || typeof data.review.effective_month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(data.review.effective_month)) throw unknown();
  } else if (data.status === "available") {
    if (data.household_id !== householdId || data.budget_target_id !== targetId || data.month !== body.month || data.currency_code !== "USD" || ![data.base_target_cents,data.opening_carry_cents,data.spent_cents,data.available_cents,data.remaining_cents].every(Number.isSafeInteger)) throw unknown();
  } else if (data.status === "closed") {
    if (!isRecord(data.evidence) || data.evidence.household_id !== householdId || data.evidence.budget_target_id !== targetId || data.evidence.month !== body.month) throw unknown();
  } else if (data.status !== "unavailable" || typeof data.reason !== "string") throw unknown();
  return json(data);
}

function rolloverEvidence(value: unknown, householdId: string, targetId: string): boolean {
  if (!isRecord(value) || typeof value.closed !== "boolean" || !Number.isSafeInteger(value.opening_carry_cents) || Number(value.opening_carry_cents)<0) return false;
  if (!value.closed) return true;
  return value.household_id===householdId && value.budget_target_id===targetId && value.currency_code==="USD" && [value.base_target_cents,value.eligible_spend_cents,value.closing_carry_cents].every(Number.isSafeInteger) && Number(value.closing_carry_cents)>=0 && typeof value.source_fingerprint==="string";
}

async function budgetRolloverEditAction(userId: string, body: JsonRecord, action: string): Promise<Response> {
  const writing=action==="confirm_budget_rollover_edit",reading=action==="get_budget_rollover_state";
  assertOnlyKeys(body,["action","household_id",...(writing?["review_id","idempotency_key","confirm"]:reading?["budget_target_id","month"]:["budget_target_id","category_id","monthly_target_amount","emoji","enabled","timezone"])]);
  const h=await explicitHousehold(userId,body.household_id),args:JsonRecord={h,a:userId};let name:string;
  if(writing){if(body.confirm!==true)throw new SafeError("Confirm the reviewed budget edit.");args.r=requiredUuid(body.review_id,"review_id");args.k=requiredUuid(body.idempotency_key,"idempotency_key");args.confirmed=true;name="finance_confirm_budget_rollover_edit";}
  else if(reading){args.t=requiredUuid(body.budget_target_id,"budget_target_id");args.m=requiredString(body.month,"month",10);if(!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(String(args.m)))throw new SafeError("Choose a calendar month.");name="finance_get_budget_rollover_state";}
  else {if(typeof body.enabled!=="boolean")throw new SafeError("Choose rollover explicitly.");args.request={budget_target_id:requiredUuid(body.budget_target_id,"budget_target_id"),category_id:requiredUuid(body.category_id,"category_id"),monthly_target_amount:requiredCents(body.monthly_target_amount,"monthly_target_amount"),emoji:requiredString(body.emoji,"emoji",32)};args.enabled=body.enabled;args.tz=requiredString(body.timezone,"timezone",100);name="finance_review_budget_rollover_edit";}
  const unknown=()=>new SafeError(writing?"The save outcome is unknown. Retry this exact request.":"The budget edit could not be verified.",503,writing?"UNKNOWN_OUTCOME":undefined);
  let result;try{result=await serviceClient().rpc(name,args);}catch{throw unknown();}
  if(result.error){const code=result.error.code;if(code==="42501")throw new SafeError("Household membership required.",403);if(code==="22023")throw new SafeError("The request is invalid.",400);if(["40001","P0002","23505"].includes(code))throw new SafeError("Budget or rollover changed. Review current values.",409);throw unknown();}
  const d=result.data;if(!isRecord(d))throw unknown();
  if(reading){if(d.household_id!==h||d.actor_user_id!==userId||d.budget_target_id!==args.t||typeof d.setting_available!=="boolean")throw unknown();if(d.setting_available&&(!isRecord(d.setting)||typeof d.setting.enabled!=="boolean"||typeof d.current_enabled!=="boolean"||!Number.isSafeInteger(d.setting.version)||!isRecord(d.capacity)))throw unknown();}
  else if(writing){if(d.kind!=="rollover_budget_edit"||d.saved!==true||d.household_id!==h||d.actor_user_id!==userId||d.review_id!==args.r||typeof d.receipt_id!=="string"||typeof d.rollover_enabled!=="boolean")throw unknown();}
  else if(typeof d.review_id!=="string"||!isRecord(d.review)||d.review.household_id!==h||d.review.actor_user_id!==userId||d.review.budget_target_id!==body.budget_target_id||d.rollover_enabled!==body.enabled||!Number.isSafeInteger(d.setting_version))throw unknown();
  return json(d);
}

