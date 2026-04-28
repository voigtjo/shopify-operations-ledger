import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve("supabase/migrations/20260427090000_operational_case_foundation.sql"),
  "utf8",
).toLowerCase();

const caseTables = [
  "operation_cases",
  "case_events",
  "case_comments",
  "case_tasks",
  "case_decisions",
  "case_links",
];

describe("operational case foundation migration", () => {
  it("creates tenant-scoped case foundation tables", () => {
    for (const table of caseTables) {
      expect(migration).toContain(`create table public.${table}`);
      const tableBlock = migration.match(
        new RegExp(`create table public\\.${table} \\([\\s\\S]*?\\n\\);`),
      )?.[0];

      expect(tableBlock, `${table} table block`).toBeDefined();
      expect(tableBlock).toContain("tenant_id uuid not null");
      expect(tableBlock).toContain("references public.tenants(id)");
    }
  });

  it("adds controlled case, task, and decision statuses", () => {
    expect(migration).toContain("'waiting_for_decision'");
    expect(migration).toContain("'urgent'");
    expect(migration).toContain("'approve_purchase'");
    expect(migration).toContain("'resolve_discrepancy'");
    expect(migration).toContain("'done'");
  });

  it("links Operations Orders to Operation Cases", () => {
    expect(migration).toContain("alter table public.operations_orders");
    expect(migration).toContain("add column operation_case_id uuid null");
    expect(migration).toContain("operations_orders_operation_case_idx");
  });

  it("adds idempotent ledger and object-link protections", () => {
    expect(migration).toContain("case_events_idempotency_uidx");
    expect(migration).toContain("case_links_relation_uidx");
  });
});
