import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve("supabase/migrations/20260426170000_core_operational_slice.sql"),
  "utf8",
).toLowerCase();

const coreTables = [
  "shopify_order_refs",
  "operations_orders",
  "operations_order_lines",
  "suppliers",
  "purchase_needs",
  "purchase_orders",
  "purchase_order_lines",
  "goods_receipts",
  "goods_receipt_lines",
  "inventory_movements",
  "domain_events",
  "idempotency_keys",
];

describe("core operational migration", () => {
  it("creates the Part 1 operational tables", () => {
    for (const table of coreTables) {
      expect(migration).toContain(`create table public.${table}`);
    }
  });

  it("keeps tenant ownership on operational tables", () => {
    for (const table of coreTables) {
      const tableBlock = migration.match(
        new RegExp(`create table public\\.${table} \\([\\s\\S]*?\\n\\);`),
      )?.[0];

      expect(tableBlock, `${table} table block`).toBeDefined();
      expect(tableBlock).toContain("tenant_id uuid not null");
      expect(tableBlock).toContain("references public.tenants(id)");
    }
  });

  it("does not introduce out-of-scope Phase 5+ tables", () => {
    expect(migration).not.toContain("fulfillment_plans");
    expect(migration).not.toContain("shipments");
    expect(migration).not.toContain("exception_cases");
    expect(migration).not.toContain("approval_tasks");
    expect(migration).not.toContain("production_orders");
    expect(migration).not.toContain("accounting_event_candidates");
  });

  it("adds idempotency and ledger indexes", () => {
    expect(migration).toContain("shopify_order_refs");
    expect(migration).toContain("unique (tenant_id, shopify_order_id)");
    expect(migration).toContain("purchase_needs_active_line_uidx");
    expect(migration).toContain("inventory_movements_source_idx");
    expect(migration).toContain("unique (tenant_id, key)");
  });
});
