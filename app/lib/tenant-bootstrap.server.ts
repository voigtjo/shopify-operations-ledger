import { encryptAccessToken } from "./token-encryption.server";
import {
  isFoundationDatabaseConfigured,
  type QueryExecutor,
  withFoundationTransaction,
} from "./foundation-db.server";

export const DEFAULT_TENANT_SETTINGS = {
  "inventory.negative_stock_policy": "BLOCK",
  "fulfillment.partial_shipment_policy": "ALLOW",
  "fulfillment.partial_shipment_requires_approval": false,
  "procurement.overdelivery_policy": "REQUIRE_APPROVAL",
  "accounting.export_mode": "CSV",
  "sync.shopify_inventory_writeback": false,
  "sync.shopify_fulfillment_writeback": false,
} as const;

export const DEFAULT_ROLE_CODES = [
  { code: "OWNER", name: "Owner" },
  { code: "ADMIN", name: "Admin" },
  { code: "OPERATOR", name: "Operator" },
  { code: "BUYER", name: "Buyer" },
  { code: "WAREHOUSE", name: "Warehouse" },
  { code: "PRODUCTION", name: "Production" },
  { code: "APPROVER", name: "Approver" },
  { code: "VIEWER", name: "Viewer" },
] as const;

export interface ShopifyTenantBootstrapInput {
  shopDomain: string;
  accessToken: string;
  scopes: string;
  shopName?: string | null;
}

export interface TenantBootstrapResult {
  tenantId: string;
  installationId: string;
}

export interface TenantBootstrapStore {
  findOrCreateActiveTenant(shopDomain: string): Promise<{ id: string }>;
  upsertActiveInstallation(input: {
    tenantId: string;
    shopDomain: string;
    shopName: string | null;
    accessTokenEncrypted: string;
    scopes: string;
  }): Promise<{ id: string }>;
  ensureDefaultSettings(
    tenantId: string,
    settings: typeof DEFAULT_TENANT_SETTINGS,
  ): Promise<void>;
  ensureDefaultRoles(
    tenantId: string,
    roles: typeof DEFAULT_ROLE_CODES,
  ): Promise<void>;
  ensureOnboardingStarted(tenantId: string): Promise<void>;
  markShopUninstalled(shopDomain: string): Promise<void>;
}

export class PgTenantBootstrapStore implements TenantBootstrapStore {
  constructor(private readonly db: QueryExecutor) {}

  async findOrCreateActiveTenant(shopDomain: string) {
    const result = await this.db.query<{ id: string }>(
      `
        insert into public.tenants (primary_shop_domain, status, plan_code)
        values ($1, 'ACTIVE', 'DEV')
        on conflict (primary_shop_domain)
        do update set status = 'ACTIVE', updated_at = now()
        returning id
      `,
      [shopDomain],
    );

    return result.rows[0]!;
  }

  async upsertActiveInstallation(input: {
    tenantId: string;
    shopDomain: string;
    shopName: string | null;
    accessTokenEncrypted: string;
    scopes: string;
  }) {
    const result = await this.db.query<{ id: string }>(
      `
        insert into public.shopify_installations (
          tenant_id,
          shop_domain,
          shop_name,
          access_token_encrypted,
          scopes,
          status
        )
        values ($1, $2, $3, $4, $5, 'ACTIVE')
        on conflict (shop_domain)
        do update set
          tenant_id = excluded.tenant_id,
          shop_name = excluded.shop_name,
          access_token_encrypted = excluded.access_token_encrypted,
          scopes = excluded.scopes,
          status = 'ACTIVE',
          uninstalled_at = null
        returning id
      `,
      [
        input.tenantId,
        input.shopDomain,
        input.shopName,
        input.accessTokenEncrypted,
        input.scopes,
      ],
    );

    return result.rows[0]!;
  }

  async ensureDefaultSettings(
    tenantId: string,
    settings: typeof DEFAULT_TENANT_SETTINGS,
  ) {
    for (const [key, value] of Object.entries(settings)) {
      await this.db.query(
        `
          insert into public.tenant_settings (tenant_id, key, value)
          values ($1, $2, $3::jsonb)
          on conflict (tenant_id, key) do nothing
        `,
        [tenantId, key, JSON.stringify(value)],
      );
    }
  }

  async ensureDefaultRoles(tenantId: string, roles: typeof DEFAULT_ROLE_CODES) {
    for (const role of roles) {
      await this.db.query(
        `
          insert into public.roles (tenant_id, code, name, is_system)
          values ($1, $2, $3, true)
          on conflict (tenant_id, code) do nothing
        `,
        [tenantId, role.code, role.name],
      );
    }
  }

  async ensureOnboardingStarted(tenantId: string) {
    await this.db.query(
      `
        insert into public.tenant_onboarding (tenant_id, status, current_step)
        values ($1, 'STARTED', 'WELCOME')
        on conflict (tenant_id) do nothing
      `,
      [tenantId],
    );
  }

  async markShopUninstalled(shopDomain: string) {
    const installationResult = await this.db.query<{ tenant_id: string }>(
      `
        update public.shopify_installations
        set status = 'UNINSTALLED',
            uninstalled_at = coalesce(uninstalled_at, now())
        where shop_domain = $1
        returning tenant_id
      `,
      [shopDomain],
    );

    const tenantId = installationResult.rows[0]?.tenant_id;

    if (!tenantId) {
      return;
    }

    await this.db.query(
      `
        update public.jobs
        set status = 'CANCELLED',
            updated_at = now()
        where tenant_id = $1
          and status in ('QUEUED', 'RUNNING')
      `,
      [tenantId],
    );

    const activeInstallationResult = await this.db.query<{ count: string }>(
      `
        select count(*)::text as count
        from public.shopify_installations
        where tenant_id = $1
          and status = 'ACTIVE'
      `,
      [tenantId],
    );

    if (activeInstallationResult.rows[0]?.count === "0") {
      await this.db.query(
        `
          update public.tenants
          set status = 'UNINSTALLED',
              updated_at = now()
          where id = $1
        `,
        [tenantId],
      );
    }
  }
}

export async function bootstrapTenantFromShopifySession(
  store: TenantBootstrapStore,
  input: ShopifyTenantBootstrapInput,
): Promise<TenantBootstrapResult> {
  const shopDomain = input.shopDomain.trim().toLowerCase();
  const tenant = await store.findOrCreateActiveTenant(shopDomain);
  const installation = await store.upsertActiveInstallation({
    tenantId: tenant.id,
    shopDomain,
    shopName: input.shopName ?? null,
    accessTokenEncrypted: encryptAccessToken(input.accessToken),
    scopes: input.scopes,
  });

  await store.ensureDefaultSettings(tenant.id, DEFAULT_TENANT_SETTINGS);
  await store.ensureDefaultRoles(tenant.id, DEFAULT_ROLE_CODES);
  await store.ensureOnboardingStarted(tenant.id);

  return {
    tenantId: tenant.id,
    installationId: installation.id,
  };
}

export async function bootstrapTenantForAuthenticatedShop(input: {
  shopDomain: string;
  accessToken?: string;
  scopes?: string | null;
}) {
  if (!isFoundationDatabaseConfigured()) {
    return { skipped: true, reason: "foundation_database_not_configured" };
  }

  if (!input.accessToken) {
    throw new Error("Shopify session did not include an access token");
  }

  const accessToken = input.accessToken;

  const result = await withFoundationTransaction(async (db) => {
    const store = new PgTenantBootstrapStore(db);

    return bootstrapTenantFromShopifySession(store, {
      shopDomain: input.shopDomain,
      accessToken,
      scopes: input.scopes ?? "",
    });
  });

  return { skipped: false, result };
}

export async function markShopifyInstallationUninstalled(shopDomain: string) {
  if (!isFoundationDatabaseConfigured()) {
    return { skipped: true, reason: "foundation_database_not_configured" };
  }

  await withFoundationTransaction(async (db) => {
    const store = new PgTenantBootstrapStore(db);
    await store.markShopUninstalled(shopDomain.trim().toLowerCase());
  });

  return { skipped: false };
}
