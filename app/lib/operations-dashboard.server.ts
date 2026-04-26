import {
  getFoundationDatabasePool,
  type QueryExecutor,
} from "./foundation-db.server";
import {
  getOperationsDashboard,
  getTenantContextByShopDomain,
} from "./operational-core.server";
import {
  PgTenantBootstrapStore,
  bootstrapTenantFromShopifySession,
} from "./tenant-bootstrap.server";

export async function loadDashboardForShop(input: {
  shopDomain: string;
  accessToken?: string;
  scopes?: string | null;
  db?: QueryExecutor | null;
}) {
  const db = input.db === undefined ? getFoundationDatabasePool() : input.db;

  if (!db) {
    return {
      configured: false as const,
      shopDomain: input.shopDomain,
      dashboard: null,
    };
  }

  if (!input.accessToken) {
    throw new Error("Shopify session did not include an access token");
  }

  await bootstrapTenantFromShopifySession(new PgTenantBootstrapStore(db), {
    shopDomain: input.shopDomain,
    accessToken: input.accessToken,
    scopes: input.scopes ?? "",
  });

  const ctx = await getTenantContextByShopDomain(db, input.shopDomain);
  const dashboard = await getOperationsDashboard(db, ctx);

  return {
    configured: true as const,
    shopDomain: input.shopDomain,
    dashboard,
  };
}
