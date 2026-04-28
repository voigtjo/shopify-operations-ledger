import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve("supabase/migrations/20260428090000_item_bom_mrp_foundation.sql"),
  "utf8",
).toLowerCase();

describe("item, BOM, and MRP foundation migration", () => {
  it("creates item and BOM foundation tables", () => {
    for (const table of ["items", "boms", "bom_lines", "production_needs"]) {
      expect(migration).toContain(`create table public.${table}`);
    }
  });

  it("keeps tenant ownership and controlled item types", () => {
    expect(migration).toContain("tenant_id uuid not null references public.tenants(id)");
    expect(migration).toContain("'product'");
    expect(migration).toContain("'component'");
    expect(migration).toContain("'raw_material'");
    expect(migration).toContain("'assembly'");
  });

  it("maps Shopify variants one-to-one to items", () => {
    expect(migration).toContain("unique (tenant_id, shopify_variant_id)");
  });

  it("links order lines and purchase needs to items", () => {
    expect(migration).toContain("alter table public.operations_order_lines");
    expect(migration).toContain("add column item_id uuid null references public.items(id)");
    expect(migration).toContain("alter table public.purchase_needs");
    expect(migration).toContain("purchase_needs_active_line_item_uidx");
  });

  it("adds idempotent pending production needs", () => {
    expect(migration).toContain("production_needs_pending_reference_item_uidx");
    expect(migration).toContain("'pending'");
  });
});
