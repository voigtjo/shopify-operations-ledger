import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TENANT_SETTINGS,
  PgTenantBootstrapStore,
  bootstrapTenantFromShopifySession,
} from "../../app/lib/tenant-bootstrap.server";

const connectionString = process.env.OPERATIONS_LEDGER_DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;
const testShopDomain = "phase3-bootstrap-test.myshopify.com";

let pool: pg.Pool;

async function deleteTestShop() {
  await pool.query(
    "delete from public.shopify_installations where shop_domain = $1",
    [testShopDomain],
  );
  await pool.query(
    "delete from public.tenants where primary_shop_domain = $1",
    [testShopDomain],
  );
}

describeIfDatabase("tenant bootstrap Postgres integration", () => {
  beforeAll(() => {
    process.env.OPERATIONS_LEDGER_TOKEN_ENCRYPTION_KEY ??=
      "test-encryption-key";
    pool = new pg.Pool({ connectionString });
  });

  beforeEach(async () => {
    await deleteTestShop();
  });

  afterAll(async () => {
    await deleteTestShop();
    await pool.end();
  });

  it("creates, reuses and uninstalls tenant bootstrap records", async () => {
    const store = new PgTenantBootstrapStore(pool);

    const first = await bootstrapTenantFromShopifySession(store, {
      shopDomain: testShopDomain,
      accessToken: "first-token",
      scopes: "write_products",
    });
    const second = await bootstrapTenantFromShopifySession(store, {
      shopDomain: testShopDomain,
      accessToken: "second-token",
      scopes: "write_products,write_orders",
    });

    expect(second).toEqual(first);

    const tenantResult = await pool.query<{
      status: string;
      tenant_settings_count: string;
      role_count: string;
      onboarding_status: string;
    }>(
      `
        select
          tenants.status,
          (select count(*)::text from public.tenant_settings where tenant_id = tenants.id) as tenant_settings_count,
          (select count(*)::text from public.roles where tenant_id = tenants.id) as role_count,
          (select status from public.tenant_onboarding where tenant_id = tenants.id) as onboarding_status
        from public.tenants
        where tenants.primary_shop_domain = $1
      `,
      [testShopDomain],
    );
    const installationResult = await pool.query<{
      status: string;
      access_token_encrypted: string;
    }>(
      `
        select status, access_token_encrypted
        from public.shopify_installations
        where shop_domain = $1
      `,
      [testShopDomain],
    );

    expect(tenantResult.rows[0]).toMatchObject({
      status: "ACTIVE",
      tenant_settings_count: String(Object.keys(DEFAULT_TENANT_SETTINGS).length),
      role_count: "8",
      onboarding_status: "STARTED",
    });
    expect(installationResult.rows[0]?.status).toBe("ACTIVE");
    expect(installationResult.rows[0]?.access_token_encrypted).not.toContain(
      "second-token",
    );

    await store.markShopUninstalled(testShopDomain);

    const uninstallResult = await pool.query<{
      tenant_status: string;
      installation_status: string;
      uninstalled_at: Date | null;
    }>(
      `
        select
          tenants.status as tenant_status,
          shopify_installations.status as installation_status,
          shopify_installations.uninstalled_at
        from public.shopify_installations
        join public.tenants on tenants.id = shopify_installations.tenant_id
        where shopify_installations.shop_domain = $1
      `,
      [testShopDomain],
    );

    expect(uninstallResult.rows[0]).toMatchObject({
      tenant_status: "UNINSTALLED",
      installation_status: "UNINSTALLED",
    });
    expect(uninstallResult.rows[0]?.uninstalled_at).toBeInstanceOf(Date);
  });
});
