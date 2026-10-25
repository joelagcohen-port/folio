import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import {
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
} from "npm:jose@5.9.6"

const transactionWebhooks = new Set([
  "SYNC_UPDATES_AVAILABLE",
  "DEFAULT_UPDATE",
  "INITIAL_UPDATE",
  "HISTORICAL_UPDATE",
  "TRANSACTIONS_REMOVED",
])
const recurringWebhooks = new Set(["RECURRING_TRANSACTIONS_UPDATE"])

const verificationKeys = new Map<string, Record<string, unknown>>()

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 })
  }

  try {
    const rawBody = await request.text()
    const verified = await verifyPlaidWebhook(
      rawBody,
      request.headers.get("plaid-verification"),
    )
    if (!verified) {
      return Response.json({ error: "Invalid webhook signature" }, { status: 401 })
    }

    let payload: unknown
    try { payload = JSON.parse(rawBody) } catch {
      return Response.json({ error: "Invalid webhook payload" }, { status: 400 })
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return Response.json({ error: "Invalid webhook payload" }, { status: 400 })
    }

    const webhookType = optionalString((payload as any).webhook_type)
    const webhookCode = optionalString((payload as any).webhook_code)
    const itemId = optionalString((payload as any).item_id)

    if (!webhookCode || !((webhookType === "TRANSACTIONS" && transactionWebhooks.has(webhookCode)) || (webhookType === "TRANSACTIONS" && recurringWebhooks.has(webhookCode)))) {
      return Response.json({ received: true, action: "ignored" })
    }

    if (!itemId) {
      return Response.json({ error: "Missing item_id" }, { status: 400 })
    }

    const supabaseUrl = required("SUPABASE_URL")
    const supabase = createClient(
      supabaseUrl,
      required("SUPABASE_SERVICE_ROLE_KEY"),
      {
        auth: { persistSession: false },
        global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) }) },
      },
    )
    // The JWT signing input excludes the signature bytes; ECDSA permits
    // alternate valid encodings for the same signed claims.
    const receiptHash = await sha256Hex(verified.signedJwt.split(".").slice(0, 2).join("."))
    const { data, error } = await supabase.rpc("finance_ingest_plaid_webhook", {
      p_receipt_hash: receiptHash,
      p_item_id: itemId,
      p_webhook_type: webhookType,
      p_webhook_code: webhookCode,
    })
    if (error) throw new Error("webhook_ingest_failed")
    return Response.json(data ?? { received: true, action: "accepted" })
  } catch (error) {
    console.error("Plaid webhook failed", { code: "webhook_processing_failed" })
    return Response.json({ error: "Webhook processing failed" }, { status: 500 })
  }
})

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

async function verifyPlaidWebhook(
  rawBody: string,
  signedJwt: string | null,
): Promise<{ signedJwt: string } | null> {
  if (!signedJwt) return null

  try {
    const header = decodeProtectedHeader(signedJwt)
    if (header.alg !== "ES256" || !header.kid) return null

    let jwk = verificationKeys.get(header.kid)
    if (!jwk) {
      const response = await fetch(
        "https://production.plaid.com/webhook_verification_key/get",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(5000),
          body: JSON.stringify({
            client_id: required("PLAID_CLIENT_ID").trim(),
            secret: required("PLAID_SECRET").trim(),
            key_id: header.kid,
          }),
        },
      )
      if (!response.ok) return null
      const data = await response.json()
      if (!data?.key || data.key.alg !== "ES256") return null
      jwk = data.key
      verificationKeys.set(header.kid, jwk)
    }

    const key = await importJWK(jwk, "ES256")
    const { payload } = await jwtVerify(signedJwt, key, {
      algorithms: ["ES256"],
      maxTokenAge: "5 min",
    })
    const claimedHash = optionalString(payload.request_body_sha256)
    if (!claimedHash) return null

    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(rawBody),
    )
    const actualHash = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")

    return constantTimeEqual(actualHash, claimedHash) ? { signedJwt } : null
  } catch {
    return null
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let result = 0
  for (let index = 0; index < left.length; index++) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return result === 0
}

function required(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`Missing server secret: ${name}`)
  return value
}

