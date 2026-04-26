# Operations Ledger Project Foundation

## Source of truth

Operations Ledger is implemented against the authoritative specification in `../operations-ledger-spec`.

The reference app at `../quote-approval-app` may be inspected for already solved Shopify, Supabase and role patterns. It is reference only and must not be modified while implementing Operations Ledger.

The reference specification at `../quote-approval-spec` is background only and is not authoritative for this app.

## Current phase

Current implementation phase: Phase 1, project foundation.

Phase 1 keeps the Shopify React Router scaffold working while establishing development documentation, baseline checks and test structure. It must not add Supabase, Operations Ledger domain tables or product workflow logic.

## Baseline checks

Run these checks from the app directory:

```bash
cd /Users/jvoigt/Projects/shopify-apps/operations-ledger
npm run lint
npm run build
npm run typecheck
npm test
npx prisma validate
npx prisma migrate status
```

## Test layout

Tests are organized by intent:

- `tests/unit`: fast isolated tests with no Shopify Admin, Supabase or network dependency.
- `tests/integration`: tests for local service/database boundaries once those exist.
- `tests/e2e`: browser or end-to-end journeys once the app has product flows.
- `tests/fixtures`: reusable test data.

## Shopify dev preview

Run the Shopify dev preview from the app directory:

```bash
cd /Users/jvoigt/Projects/shopify-apps/operations-ledger
npm run dev
```

Then use the Shopify CLI preview prompt to open the app in the Operations Ledger Dev store. Stop the server with `q` in the Shopify CLI terminal when verification is complete.

The scaffold currently uses Prisma with SQLite for Shopify session storage. Supabase/Postgres migration work belongs to Phase 2.
