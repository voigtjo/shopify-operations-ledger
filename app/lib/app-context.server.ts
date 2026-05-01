import { getFoundationDatabasePool } from "./foundation-db.server";
import { getTenantContextByShopDomain } from "./operational-core.server";
import {
  PgTenantBootstrapStore,
  bootstrapTenantFromShopifySession,
} from "./tenant-bootstrap.server";
import { authenticate } from "../shopify.server";

export async function requirePlanningContext(request: Request) {
  const { session } = await authenticate.admin(request);
  const pool = getFoundationDatabasePool();

  if (!pool) {
    return {
      configured: false as const,
      shopDomain: session.shop,
      pool: null,
      ctx: null,
    };
  }

  if (!session.accessToken) {
    throw new Error("Shopify session did not include an access token");
  }

  await bootstrapTenantFromShopifySession(new PgTenantBootstrapStore(pool), {
    shopDomain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope ?? "",
  });

  const ctx = await getTenantContextByShopDomain(pool, session.shop);

  return {
    configured: true as const,
    shopDomain: session.shop,
    pool,
    ctx,
  };
}
