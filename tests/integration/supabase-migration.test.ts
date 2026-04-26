import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve("supabase/migrations/20260426143000_foundation_tables.sql"),
  "utf8",
).toLowerCase();

const tenantOwnedTables = [
  "shopify_installations",
  "tenant_settings",
  "integration_events",
  "app_users",
  "roles",
  "jobs",
];

const requiredTables = [
  "tenants",
  ...tenantOwnedTables,
  "audit_events",
  "permissions",
  "role_permissions",
  "user_roles",
];

describe("Supabase foundation migration", () => {
  it("creates the required foundation tables only", () => {
    for (const table of requiredTables) {
      expect(migration).toContain(`create table public.${table}`);
    }

    expect(migration).not.toContain("operations_orders");
    expect(migration).not.toContain("purchase_orders");
    expect(migration).not.toContain("shipments");
    expect(migration).not.toContain("production_orders");
    expect(migration).not.toContain("accounting_event");
  });

  it("adds tenant_id to tenant-owned foundation tables", () => {
    for (const table of tenantOwnedTables) {
      const tableBlock = migration.match(
        new RegExp(`create table public\\.${table} \\([\\s\\S]*?\\n\\);`),
      )?.[0];

      expect(tableBlock, `${table} table block`).toBeDefined();
      expect(tableBlock).toContain("tenant_id uuid not null");
      expect(tableBlock).toContain("references public.tenants(id)");
    }
  });

  it("captures webhook idempotency and job scheduling indexes", () => {
    expect(migration).toContain("integration_events_external_event_id_uidx");
    expect(migration).toContain("integration_events_payload_dedup_idx");
    expect(migration).toContain("unique (tenant_id, job_type, idempotency_key)");
    expect(migration).toContain("jobs_status_run_after_idx");
  });
});
