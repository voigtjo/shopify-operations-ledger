import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve("supabase/migrations/20260428090000_item_bom_mrp_foundation.sql"),
  "utf8",
).toLowerCase();
const mrpPreviewMigration = readFileSync(
  resolve("supabase/migrations/20260501100000_mrp_preview_runs.sql"),
  "utf8",
).toLowerCase();
const mrpCommitMigration = readFileSync(
  resolve("supabase/migrations/20260501110000_mrp_commit_needs.sql"),
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

  it("adds preview-only MRP run tables with canonical statuses and actions", () => {
    expect(mrpPreviewMigration).toContain("create table public.mrp_runs");
    expect(mrpPreviewMigration).toContain("create table public.mrp_run_lines");
    expect(mrpPreviewMigration).toContain("status in ('draft', 'running', 'completed', 'failed', 'cancelled')");
    expect(mrpPreviewMigration).toContain("recommended_action in ('none', 'reserve', 'purchase', 'produce', 'review')");
    expect(mrpPreviewMigration).not.toContain("purchase_needs");
    expect(mrpPreviewMigration).not.toContain("production_needs");
  });

  it("links explicit MRP commit output to needs without adding orders", () => {
    expect(mrpCommitMigration).toContain("alter table public.purchase_needs");
    expect(mrpCommitMigration).toContain("alter table public.production_needs");
    expect(mrpCommitMigration).toContain("mrp_run_line_id");
    expect(mrpCommitMigration).toContain("'open'");
    expect(mrpCommitMigration).toContain("'pending'");
    expect(mrpCommitMigration).toContain("purchase_needs_active_mrp_source_uidx");
    expect(mrpCommitMigration).toContain("production_needs_pending_mrp_source_uidx");
    expect(mrpCommitMigration).not.toContain("create table public.purchase_orders");
    expect(mrpCommitMigration).not.toContain("create table public.production_orders");
  });
});
