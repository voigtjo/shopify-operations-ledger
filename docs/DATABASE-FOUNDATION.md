# Database Foundation

## Current architecture

Phase 2 introduces Supabase local migrations for the Operations Ledger foundation schema while leaving the existing Shopify React Router scaffold intact.

The app still uses Prisma with SQLite for Shopify session storage:

- Prisma schema: `prisma/schema.prisma`
- Local SQLite database: `prisma/dev.sqlite`
- Existing Shopify session table: `Session`

The Operations Ledger foundation schema is versioned separately as Supabase/Postgres SQL:

- Supabase config: `supabase/config.toml`
- Migrations: `supabase/migrations/`

This keeps the Shopify template working while preparing the Postgres schema that future phases will use.

Phase 3 adds a minimal Node/Postgres access layer for tenant bootstrap. It uses `pg` against the local Supabase Postgres URL and does not replace Prisma session storage.

## Why Supabase migrations are separate from Prisma for now

The scaffold already depends on Prisma session storage for Shopify OAuth/session handling. Switching the scaffold datasource to Postgres in Phase 2 would be a broader runtime change than required.

Supabase migrations are the source of truth for Operations Ledger application tables. Prisma remains responsible only for the current scaffold session table until a later phase deliberately changes the app database access layer.

## Local Supabase setup

Install the Supabase CLI and ensure Docker is available, then run:

```bash
cd /Users/jvoigt/Projects/shopify-apps/operations-ledger
supabase start
npm run db:reset
npm run db:status
```

`npm run db:reset` rebuilds the local Supabase database and applies migrations from `supabase/migrations`.

## Added foundation tables

The initial migration creates:

- `tenants`
- `shopify_installations`
- `tenant_settings`
- `integration_events`
- `audit_events`
- `app_users`
- `roles`
- `permissions`
- `role_permissions`
- `user_roles`
- `jobs`
- `tenant_onboarding`

No Operations Orders, procurement, fulfillment, production or accounting tables are introduced in Phase 2.

## Tenant isolation stance

Tenant-owned tables include `tenant_id` and supporting indexes. The global `permissions` table intentionally has no `tenant_id` because permission codes are shared application constants. Join tables inherit tenant scope through `roles` and `app_users`.

Supabase Row Level Security is not enabled in this phase. The spec requires service-level tenant isolation first; RLS can be added after tenant context and service boundaries are stable.

## Verification

Automated tests currently verify that the migration contains the required foundation tables, tenant columns and selected idempotency indexes.

Full local database verification is pending until Supabase CLI and Docker are installed on this machine.

## Tenant bootstrap environment

To write tenant bootstrap data during Shopify Admin preview, set:

```bash
export OPERATIONS_LEDGER_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
export OPERATIONS_LEDGER_TOKEN_ENCRYPTION_KEY="$(openssl rand -hex 32)"
```

`OPERATIONS_LEDGER_DATABASE_URL` is separate from Prisma so the Shopify session scaffold remains on SQLite. `OPERATIONS_LEDGER_TOKEN_ENCRYPTION_KEY` is required whenever tenant bootstrap writes Shopify installation tokens, because access tokens must be encrypted at rest.

If `OPERATIONS_LEDGER_DATABASE_URL` is not set, Shopify preview still works and tenant bootstrap is skipped.
