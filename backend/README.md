# Supabase function source inventory

`edge-functions.json` is an inventory of twelve selected function source
closures. Seven runtime-source snapshots (six app-facing closures and the
Plaid webhook handler) were retrieved read-only from the configured Supabase
project. Five additional closures come from reviewed source-candidate
snapshots. This export does not assert deployment status for any function and
does not configure a target project.

Each function directory preserves its original relative-import layout. The
`entrypoint` field in the JSON inventory is the normalized path relative to
this repository; it contains no project references or runtime file paths.

## Runtime requirements

These are Deno/Supabase Edge Function sources, not a ready-to-deploy Supabase
project. Before deployment, independently check each function's current JWT
verification policy, permissions, schema/RPC dependencies, remote imports, and
environment configuration. This inventory intentionally does not infer
authentication settings or provide a `supabase/config.toml`.

Common server-side runtime settings include `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. Other functions require
Plaid credentials, `MASSIVE_API_KEY` for market history, feature flags, or
`FOLIO_PUBLIC_URL` for push links/VAPID. Assistant signature verification reads
public P-256 verification JWKs from `FOLIO_ASSISTANT_VERIFY_KEYS_JSON`, a JSON
object keyed by key ID. Configure a matching key ID for the signing key; the
verification setting must contain public coordinates only, never the private
`d` value. Missing or invalid verification configuration produces an empty key
registry, so signatures fail closed. The full variable names are listed per
function in `edge-functions.json`; `.env.example` contains empty placeholders.
Never expose these values in a browser bundle or commit a populated env file.

## Deliberate omissions

The export excludes production and historical SQL migrations, schema dumps,
database rows, project configuration, upload wrappers, generated deploy
manifests, and optional function families not directly required by the
included app paths. Functions depend on existing tables, views, RPCs, RLS
policies, and service configuration that are not bootstrapped here. A fresh
project will not run without an independently prepared compatible schema.
