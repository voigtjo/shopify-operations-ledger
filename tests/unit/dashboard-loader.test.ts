import { describe, expect, it, vi } from "vitest";

import { loadDashboardForShop } from "../../app/lib/operations-dashboard.server";

vi.mock("../../app/lib/token-encryption.server", () => ({
  encryptAccessToken: (token: string) => `encrypted:${token}`,
}));

class DashboardBootstrapDb {
  tenants = new Map<string, { id: string; primary_shop_domain: string; status: string }>();
  installations = new Map<string, { id: string; tenant_id: string }>();
  settings = new Map<string, Map<string, unknown>>();
  roles = new Map<string, Set<string>>();
  onboarding = new Set<string>();

  async query<T = unknown>(sql: string, params: readonly unknown[] = []) {
    const normalizedSql = sql.toLowerCase();

    if (normalizedSql.includes("insert into public.tenants")) {
      const shopDomain = String(params[0]);
      const existing = this.tenants.get(shopDomain);

      if (existing) {
        existing.status = "ACTIVE";
        return { rows: [{ id: existing.id }] as T[] };
      }

      const tenant = {
        id: `tenant-${this.tenants.size + 1}`,
        primary_shop_domain: shopDomain,
        status: "ACTIVE",
      };
      this.tenants.set(shopDomain, tenant);

      return { rows: [{ id: tenant.id }] as T[] };
    }

    if (normalizedSql.includes("insert into public.shopify_installations")) {
      const tenantId = String(params[0]);
      const shopDomain = String(params[1]);
      const existing = this.installations.get(shopDomain);
      const installation = {
        id: existing?.id ?? `installation-${this.installations.size + 1}`,
        tenant_id: tenantId,
      };

      this.installations.set(shopDomain, installation);

      return { rows: [{ id: installation.id }] as T[] };
    }

    if (normalizedSql.includes("insert into public.tenant_settings")) {
      const tenantId = String(params[0]);
      const key = String(params[1]);
      const tenantSettings = this.settings.get(tenantId) ?? new Map();

      tenantSettings.set(key, params[2]);
      this.settings.set(tenantId, tenantSettings);

      return { rows: [] as T[] };
    }

    if (normalizedSql.includes("insert into public.roles")) {
      const tenantId = String(params[0]);
      const roleCode = String(params[1]);
      const roles = this.roles.get(tenantId) ?? new Set<string>();

      roles.add(roleCode);
      this.roles.set(tenantId, roles);

      return { rows: [] as T[] };
    }

    if (normalizedSql.includes("insert into public.tenant_onboarding")) {
      this.onboarding.add(String(params[0]));

      return { rows: [] as T[] };
    }

    if (
      normalizedSql.includes("select id, primary_shop_domain, status") &&
      normalizedSql.includes("from public.tenants")
    ) {
      const tenant = [...this.tenants.values()].find(
        (candidate) => candidate.id === params[0],
      );

      return { rows: (tenant ? [tenant] : []) as T[] };
    }

    if (
      normalizedSql.includes("select id") &&
      normalizedSql.includes("from public.tenants")
    ) {
      const tenant = this.tenants.get(String(params[0]));

      return { rows: (tenant ? [{ id: tenant.id }] : []) as T[] };
    }

    if (normalizedSql.includes("as operations_orders")) {
      return {
        rows: [
          {
            operations_orders: "0",
            purchase_needs: "0",
            purchase_orders: "0",
            goods_receipts: "0",
            inventory_movements: "0",
          },
        ] as T[],
      };
    }

    if (normalizedSql.includes("from public.operations_orders")) {
      return { rows: [] as T[] };
    }

    if (normalizedSql.includes("from public.purchase_needs")) {
      return { rows: [] as T[] };
    }

    if (normalizedSql.includes("from public.purchase_orders")) {
      return { rows: [] as T[] };
    }

    if (normalizedSql.includes("from public.goods_receipts")) {
      return { rows: [] as T[] };
    }

    if (normalizedSql.includes("from public.inventory_movements")) {
      return { rows: [] as T[] };
    }

    throw new Error(`Unhandled test query: ${sql}`);
  }
}

describe("Operations Ledger dashboard loader helper", () => {
  it("returns a disconnected state when the Operations DB is not configured", async () => {
    await expect(
      loadDashboardForShop({
        shopDomain: "operations-ledger-dev.myshopify.com",
        db: null,
      }),
    ).resolves.toEqual({
      configured: false,
      shopDomain: "operations-ledger-dev.myshopify.com",
      dashboard: null,
    });
  });

  it("bootstraps tenant data before reading the dashboard after DB reset", async () => {
    const db = new DashboardBootstrapDb();

    const result = await loadDashboardForShop({
      shopDomain: "operations-ledger-dev.myshopify.com",
      accessToken: "fresh-token",
      scopes: "write_products",
      db,
    });

    expect(result.configured).toBe(true);
    expect(result.dashboard?.tenant).toMatchObject({
      primaryShopDomain: "operations-ledger-dev.myshopify.com",
      status: "ACTIVE",
    });
    expect(db.tenants.size).toBe(1);
    expect(db.installations.size).toBe(1);
    expect(db.settings.get("tenant-1")?.size).toBe(7);
    expect(db.roles.get("tenant-1")?.size).toBe(8);
    expect(db.onboarding.has("tenant-1")).toBe(true);
  });
});
