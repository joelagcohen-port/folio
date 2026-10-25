# Folio

Folio is a household finance dashboard that brings account activity, budgets,
cash flow, and planning tools together in one place. Its interface pairs day-to-day
transaction review with longer-range views of recurring activity, goals, and
scenarios. Supported financial actions use review and confirmation flows.

## What it includes

- Accounts, balances, transaction history, categorization, and transaction review.
- Budgets, spending trends, cash-flow views, and recurring-activity insights.
- Savings and debt goals, planning scenarios, and rental reporting.
- Optional assistant coaching, alerts, scheduled reviews, and push notifications.

Live data and optional integrations require compatible services and configuration;
this portfolio snapshot does not include seeded financial records.

## Architecture

- `app/` contains the React dashboard shell, API routes, and client-side finance
  workflows. `public/dashboard.html` and `public/folio*` provide the interactive
  dashboard assets.
- `components/`, `hooks/`, and `lib/` hold reusable UI, calculations, and
  route-shared server helpers.
- `backend/supabase/functions/` contains twelve selected, isolated Supabase
  Edge Function source closures. The entrypoint and source provenance inventory
  is `backend/edge-functions.json`.
- The web build uses React, TypeScript, Vite/Vinext, and the Cloudflare Vite
  plugin. Edge Functions use the Deno/Supabase runtime.

## Run the web app locally

Requirements: Node.js 22.13 or newer and pnpm.

```sh
pnpm install
cp .env.example .env.local
pnpm dev
```

Create a production web bundle with `pnpm build`. The local auth shim is
loopback-only and intended for UI development; it is not production
authentication. Production hosting must provide a trusted auth adapter that
validates users and sets the server-side identity expected by the API routes.

## Backend and configuration

The backend export is a curated source snapshot, not a turnkey deployment or
fresh-project bootstrap. It includes six read-only current app-facing function
snapshots, a read-only Plaid webhook snapshot, and five reviewed source-candidate
closures. Candidate source is not a deployment-status claim. See
[`backend/README.md`](backend/README.md) for details.

Database schema, migrations, rows, RLS policies, and Supabase deployment
configuration are intentionally omitted. Functions depend on compatible tables,
views, RPCs, and service settings, so a new Supabase project will not run from
this repository alone. Independently review schema, permissions, JWT settings,
and secrets before deploying any function.

`.env.example` contains names with empty values and safe non-secret defaults.
Keep credentials in ignored local env files or a deployment secret manager;
never use `NEXT_PUBLIC_` or `VITE_` prefixes for private values. Optional flows
may require OpenAI, Plaid, and market-data-provider accounts. Push delivery
requires `FOLIO_PUBLIC_URL`, validated as HTTPS except for HTTP loopback
development. Server-side calendar calculations default to UTC; browser dates
use the browser's configured time zone.

## Portfolio export

This repository is a sanitized snapshot. It excludes Git history, private
handoffs, historical screenshots and validation captures, release archives,
generated build output, local runtime state, deployment-specific configuration,
and live financial data. No license is declared here.
