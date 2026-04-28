import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  calculateMaterialDemand,
  createBom,
  ensureItemForShopifyVariant,
  updateItemClassification,
} from "../../app/lib/material-planning.server";
import {
  createInventoryAdjustment,
  importShopifyOrder,
  runSupplyCheck,
  type TenantContext,
} from "../../app/lib/operational-core.server";

const connectionString = process.env.OPERATIONS_LEDGER_DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;
const testShopDomain = "phase-item-bom-mrp.myshopify.com";

let pool: pg.Pool;
let ctx: TenantContext;

async function deleteTestTenant() {
  await pool.query(
    "delete from public.tenants where primary_shop_domain = $1",
    [testShopDomain],
  );
}

async function createTestTenant() {
  const result = await pool.query<{ id: string }>(
    `
      insert into public.tenants (primary_shop_domain, status, plan_code)
      values ($1, 'ACTIVE', 'DEV')
      returning id
    `,
    [testShopDomain],
  );

  ctx = { tenantId: result.rows[0]!.id, shopDomain: testShopDomain };
}

describeIfDatabase("item, BOM, and MRP foundation against local Supabase", () => {
  beforeAll(() => {
    pool = new pg.Pool({ connectionString });
  });

  beforeEach(async () => {
    await deleteTestTenant();
    await createTestTenant();
  });

  afterAll(async () => {
    await deleteTestTenant();
    await pool.end();
  });

  it("explodes assembly BOM demand into production and component shortages", async () => {
    const assembly = await ensureItemForShopifyVariant(pool, ctx, {
      shopifyVariantId: "gid://shopify/ProductVariant/assembly-kit",
      sku: "ASSEMBLY-KIT",
    });
    const component = await ensureItemForShopifyVariant(pool, ctx, {
      shopifyVariantId: "gid://shopify/ProductVariant/component-screw",
      sku: "COMP-SCREW",
      isSellable: false,
    });

    await updateItemClassification(pool, ctx, {
      itemId: assembly.itemId,
      itemType: "assembly",
    });
    await updateItemClassification(pool, ctx, {
      itemId: component.itemId,
      itemType: "raw_material",
    });
    await createBom(pool, ctx, {
      parentItemId: assembly.itemId,
      lines: [{ componentItemId: component.itemId, quantity: 3 }],
    });

    const imported = await importShopifyOrder(pool, {
      shopDomain: testShopDomain,
      shopifyOrderId: "gid://shopify/Order/mrp-assembly",
      shopifyOrderName: "#MRP-1",
      lines: [
        {
          shopifyVariantId: "gid://shopify/ProductVariant/assembly-kit",
          sku: "ASSEMBLY-KIT",
          title: "Assembly Kit",
          quantity: 2,
        },
      ],
    });
    const demand = await calculateMaterialDemand(
      pool,
      ctx,
      imported.operationsOrderId,
    );

    expect(demand).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: assembly.itemId,
          demandType: "production",
          requiredQuantity: 2,
          shortageQuantity: 2,
        }),
        expect.objectContaining({
          itemId: component.itemId,
          demandType: "component",
          requiredQuantity: 6,
          shortageQuantity: 6,
        }),
      ]),
    );
  });

  it("creates production and purchase needs from MRP shortages idempotently", async () => {
    const assembly = await ensureItemForShopifyVariant(pool, ctx, {
      shopifyVariantId: "gid://shopify/ProductVariant/assembly-mixed",
      sku: "ASSEMBLY-MIXED",
    });
    const component = await ensureItemForShopifyVariant(pool, ctx, {
      shopifyVariantId: "gid://shopify/ProductVariant/component-mixed",
      sku: "COMP-MIXED",
      isSellable: false,
    });

    await updateItemClassification(pool, ctx, {
      itemId: assembly.itemId,
      itemType: "assembly",
    });
    await updateItemClassification(pool, ctx, {
      itemId: component.itemId,
      itemType: "raw_material",
    });
    await createBom(pool, ctx, {
      parentItemId: assembly.itemId,
      lines: [{ componentItemId: component.itemId, quantity: 3 }],
    });
    await createInventoryAdjustment(pool, ctx, {
      shopifyVariantId: "gid://shopify/ProductVariant/component-mixed",
      sku: "COMP-MIXED",
      title: "Component Mixed",
      quantityDelta: 1,
      reason: "MRP mixed stock test",
    });

    const imported = await importShopifyOrder(pool, {
      shopDomain: testShopDomain,
      shopifyOrderId: "gid://shopify/Order/mrp-mixed",
      shopifyOrderName: "#MRP-2",
      lines: [
        {
          shopifyVariantId: "gid://shopify/ProductVariant/assembly-mixed",
          sku: "ASSEMBLY-MIXED",
          title: "Assembly Mixed",
          quantity: 2,
        },
      ],
    });
    const first = await runSupplyCheck(pool, ctx, imported.operationsOrderId);
    const second = await runSupplyCheck(pool, ctx, imported.operationsOrderId);
    const counts = await pool.query<{
      production_need_count: string;
      purchase_need_count: string;
      component_shortage: string;
    }>(
      `
        select
          (select count(*)::text from public.production_needs where tenant_id = $1) as production_need_count,
          (select count(*)::text from public.purchase_needs where tenant_id = $1) as purchase_need_count,
          (select max(quantity_needed)::text from public.purchase_needs where tenant_id = $1) as component_shortage
      `,
      [ctx.tenantId],
    );

    expect(first.status).toBe("SUPPLY_PENDING");
    expect(first.createdProductionNeeds).toHaveLength(1);
    expect(first.createdPurchaseNeeds).toHaveLength(1);
    expect(second.createdProductionNeeds).toHaveLength(0);
    expect(second.createdPurchaseNeeds).toHaveLength(0);
    expect(counts.rows[0]).toEqual({
      production_need_count: "1",
      purchase_need_count: "1",
      component_shortage: "5.0000",
    });
  });

  it("creates a purchase need for raw material direct demand", async () => {
    const raw = await ensureItemForShopifyVariant(pool, ctx, {
      shopifyVariantId: "gid://shopify/ProductVariant/raw-direct",
      sku: "RAW-DIRECT",
      isSellable: false,
    });

    await updateItemClassification(pool, ctx, {
      itemId: raw.itemId,
      itemType: "raw_material",
    });

    const imported = await importShopifyOrder(pool, {
      shopDomain: testShopDomain,
      shopifyOrderId: "gid://shopify/Order/raw-direct",
      shopifyOrderName: "#MRP-3",
      lines: [
        {
          shopifyVariantId: "gid://shopify/ProductVariant/raw-direct",
          sku: "RAW-DIRECT",
          title: "Raw Direct",
          quantity: 4,
        },
      ],
    });
    const result = await runSupplyCheck(pool, ctx, imported.operationsOrderId);

    expect(result.createdPurchaseNeeds).toHaveLength(1);
    expect(result.createdProductionNeeds).toHaveLength(0);
  });
});
