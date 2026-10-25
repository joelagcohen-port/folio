# Portfolio export audit

This inventory documents the sanitized snapshot; it is not a security
certification.

Included files: **396 total** (391 text/source files and five PNG icons).

## Included

- Folio React app, API routes, shared UI components, calculations, and static
  dashboard assets.
- Portable Vite/Vinext/Cloudflare web build configuration and dependency lock.
- Twelve isolated Supabase Edge Function source closures, with entrypoints and
  source provenance listed in `backend/edge-functions.json`.
- Empty/generic service placeholders in `.env.example`.

## Excluded

- Git history and repository metadata.
- Production and historical SQL migrations, schema dumps, database rows, RLS
  policies, and deployment/project configuration.
- Upload wrappers, release archives, private handoffs, screenshots, validation
  captures, and operational logs.
- `node_modules`, caches, generated output, local runtime state, credentials,
  and user-specific identity or financial data.

## Sanitization and checks

- Assistant prompt and login examples are generalized; no seeded financial
  records are included.
- Push links and VAPID subjects use validated `FOLIO_PUBLIC_URL` configuration
  and fail closed when it is absent or invalid.
- Embedded assistant verification-key registries were removed from all copied
  closures. Public verification JWKs now come from the empty-by-default
  `FOLIO_ASSISTANT_VERIFY_KEYS_JSON` setting; the parser rejects private key
  material and accepts only valid ES256 public P-256 keys. Missing or malformed
  configuration yields no trusted keys.
- Source-specific timezone defaults are generalized to UTC.
- Pre-write and post-write scans covered all included text files for private
  deployment hosts, owner-name patterns, UUIDs, non-example emails,
  credential-shaped tokens, Plaid sandbox tokens, card-like numbers, and
  source-specific timezone literals. No matches remained.
- All 391 included relative source imports resolve within the export; a
  TypeScript/JavaScript syntax parse found zero syntax errors.
- Five selected PNG icons were checked for embedded metadata.

The Edge Function source is not a fresh-backend bootstrap: compatible schema,
RLS policies, RPCs, secrets, JWT settings, and service dependencies must be
prepared and independently reviewed before deployment. See `README.md` and
`backend/README.md`.
