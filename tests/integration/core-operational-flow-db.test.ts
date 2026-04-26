import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createInventoryAdjustment,
  createPurchaseOrderFromNeeds,
  createSupplier,
  getInventoryBalance,
  importShopifyOrder,
  postGoodsReceipt,
  runSupplyCheck,
  sendPurchaseOrder,
  type TenantContext,
} from "../../app/lib/operational-core.server";

const connectionString = process.env.OPERATIONS_LEDGER_DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;
const testShopDomain = "phase4-core-test.myshopify.com";

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

async function purchaseNeedIdsForOrder(operationsOrderId: string) {
  const result = await pool.query<{ id: string }>(
    `
      select id
      from public.purchase_needs
      where tenant_id = $1
        and operations_order_id = $2
      order by created_at
    `,
    [ctx.tenantId, operationsOrderId],
  );

  return result.rows.map((row) => row.id);
}

describeIfDatabase("core operational flow against local Supabase", () => {
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

  it("imports a Shopify order idempotently into an Operations Order", async () => {
    const first = await importShopifyOrder(pool, {
      shopDomain: testShopDomain,
      shopifyOrderId: "gid://shopify/Order/import-1",
      shopifyOrderName: "#1001",
      lines: [
        {
          shopifyVariantId: "gid://shopify/ProductVariant/import-a",
          sku: "IMPORT-A",
          title: "Import A",
          quantity: 2,
        },
        {
          shopifyVariantId: "gid://shopify/ProductVariant/import-b",
          sku: "IMPORT-B",
          title: "Import B",
          quantity: 3,
        },
      ],
    });
    const second = await importShopifyOrder(pool, {
      shopDomain: testShopDomain,
      shopifyOrderId: "gid://shopify/Order/import-1",
      shopifyOrderName: "#1001",
      lines: [
        {
          shopifyVariantId: "gid://shopify/ProductVariant/import-a",
          sku: "IMPORT-A",
          title: "Import A",
          quantity: 2,
        },
      ],
    });
    const counts = await pool.query<{
      order_count: string;
      line_count: string;
    }>(
      `
        select
          (select count(*)::text from public.operations_orders where tenant_id = $1) as order_count,
          (select count(*)::text from public.operations_order_lines where tenant_id = $1) as line_count
      `,
      [ctx.tenantId],
    );

    expect(first).toMatchObject({ status: "OPEN", alreadyImported: false });
    expect(second).toMatchObject({
      operationsOrderId: first.operationsOrderId,
      alreadyImported: true,
    });
    expect(counts.rows[0]).toEqual({ order_count: "1", line_count: "2" });
  });

  it("reserves enough stock without creating purchase needs", async () => {
    await createInventoryAdjustment(pool, ctx, {
      shopifyVariantId: "gid://shopify/ProductVariant/enough",
      sku: "ENOUGH-001",
      title: "Enough Stock",
      quantityDelta: 15,
      reason: "Test opening balance",
    });
    const imported = await importShopifyOrder(pool, {
      shopDomain: testShopDomain,
      shopifyOrderId: "gid://shopify/Order/enough",
      shopifyOrderName: "#1002",
      lines: [
        {
          shopifyVariantId: "gid://shopify/ProductVariant/enough",
          sku: "ENOUGH-001",
          title: "Enough Stock",
          quantity: 10,
        },
      ],
    });

    const supplyCheck = await runSupplyCheck(pool, ctx, imported.operationsOrderId);
    const repeatedSupplyCheck = await runSupplyCheck(
      pool,
      ctx,
      imported.operationsOrderId,
    );
    const balance = await getInventoryBalance(pool, ctx, {
      shopifyVariantId: "gid://shopify/ProductVariant/enough",
    });
    const reservationCount = await pool.query<{ count: string }>(
      `
        select count(*)::text as count
        from public.inventory_movements
        where tenant_id = $1
          and movement_type = 'RESERVATION_CREATED'
      `,
      [ctx.tenantId],
    );

    expect(supplyCheck.status).toBe("SUPPLY_READY");
    expect(supplyCheck.lines[0]).toMatchObject({
      reserved: 10,
      missing: 0,
      supplyStatus: "RESERVED",
    });
    expect(repeatedSupplyCheck.createdPurchaseNeeds).toHaveLength(0);
    expect(reservationCount.rows[0]?.count).toBe("1");
    expect(balance).toEqual({
      physicalQuantity: 15,
      reservedQuantity: 10,
      availableQuantity: 5,
    });
  });

  it("creates one purchase need for partial stock and stays idempotent", async () => {
    await createInventoryAdjustment(pool, ctx, {
      shopifyVariantId: "gid://shopify/ProductVariant/partial",
      sku: "PARTIAL-001",
      title: "Partial Stock",
      quantityDelta: 4,
      reason: "Test opening balance",
    });
    const imported = await importShopifyOrder(pool, {
      shopDomain: testShopDomain,
      shopifyOrderId: "gid://shopify/Order/partial",
      shopifyOrderName: "#1003",
      lines: [
        {
          shopifyVariantId: "gid://shopify/ProductVariant/partial",
          sku: "PARTIAL-001",
          title: "Partial Stock",
          quantity: 10,
        },
      ],
    });

    const supplyCheck = await runSupplyCheck(pool, ctx, imported.operationsOrderId);
    const repeatedSupplyCheck = await runSupplyCheck(
      pool,
      ctx,
      imported.operationsOrderId,
    );
    const needResult = await pool.query<{
      count: string;
      quantity_needed: string;
      status: string;
    }>(
      `
        select count(*)::text as count,
               max(quantity_needed)::text as quantity_needed,
               max(status) as status
        from public.purchase_needs
        where tenant_id = $1
      `,
      [ctx.tenantId],
    );

    expect(supplyCheck.status).toBe("SUPPLY_PENDING");
    expect(supplyCheck.lines[0]).toMatchObject({
      reserved: 4,
      missing: 6,
      supplyStatus: "PARTIALLY_RESERVED",
    });
    expect(supplyCheck.createdPurchaseNeeds).toHaveLength(1);
    expect(repeatedSupplyCheck.createdPurchaseNeeds).toHaveLength(0);
    expect(needResult.rows[0]).toEqual({
      count: "1",
      quantity_needed: "6.0000",
      status: "OPEN",
    });
  });

  it("creates a PO from a need and posts goods receipt into inventory", async () => {
    const imported = await importShopifyOrder(pool, {
      shopDomain: testShopDomain,
      shopifyOrderId: "gid://shopify/Order/procure",
      shopifyOrderName: "#1004",
      lines: [
        {
          shopifyVariantId: "gid://shopify/ProductVariant/procure",
          sku: "PROCURE-001",
          title: "Procured Stock",
          quantity: 10,
        },
      ],
    });
    await runSupplyCheck(pool, ctx, imported.operationsOrderId);
    const purchaseNeedIds = await purchaseNeedIdsForOrder(imported.operationsOrderId);
    const supplier = await createSupplier(pool, ctx, {
      name: "Core Supplier GmbH",
      email: "supplier@example.com",
    });
    const purchaseOrder = await createPurchaseOrderFromNeeds(pool, ctx, {
      supplierId: supplier.supplierId,
      purchaseNeedIds,
      currency: "EUR",
      idempotencyKey: "test:create-po:procure",
    });
    const repeatedPurchaseOrder = await createPurchaseOrderFromNeeds(pool, ctx, {
      supplierId: supplier.supplierId,
      purchaseNeedIds,
      currency: "EUR",
      idempotencyKey: "test:create-po:procure",
    });
    const sentPurchaseOrder = await sendPurchaseOrder(
      pool,
      ctx,
      purchaseOrder.purchaseOrderId,
    );
    const repeatedSentPurchaseOrder = await sendPurchaseOrder(
      pool,
      ctx,
      purchaseOrder.purchaseOrderId,
    );
    const purchaseOrderLine = await pool.query<{ id: string }>(
      `
        select id
        from public.purchase_order_lines
        where tenant_id = $1
          and purchase_order_id = $2
        limit 1
      `,
      [ctx.tenantId, purchaseOrder.purchaseOrderId],
    );
    const goodsReceipt = await postGoodsReceipt(pool, ctx, {
      purchaseOrderId: purchaseOrder.purchaseOrderId,
      lines: [
        {
          purchaseOrderLineId: purchaseOrderLine.rows[0]!.id,
          quantityReceived: 10,
        },
      ],
      idempotencyKey: "test:goods-receipt:procure",
    });
    const repeatedGoodsReceipt = await postGoodsReceipt(pool, ctx, {
      purchaseOrderId: purchaseOrder.purchaseOrderId,
      lines: [
        {
          purchaseOrderLineId: purchaseOrderLine.rows[0]!.id,
          quantityReceived: 10,
        },
      ],
      idempotencyKey: "test:goods-receipt:procure",
    });
    const balance = await getInventoryBalance(pool, ctx, {
      shopifyVariantId: "gid://shopify/ProductVariant/procure",
    });
    const needResult = await pool.query<{ status: string; quantity_covered: string }>(
      `
        select status, quantity_covered::text
        from public.purchase_needs
        where tenant_id = $1
          and id = $2
      `,
      [ctx.tenantId, purchaseNeedIds[0]],
    );
    const recordCounts = await pool.query<{
      purchase_orders: string;
      goods_receipts: string;
      goods_receipt_lines: string;
      goods_receipt_movements: string;
    }>(
      `
        select
          (select count(*)::text from public.purchase_orders where tenant_id = $1) as purchase_orders,
          (select count(*)::text from public.goods_receipts where tenant_id = $1) as goods_receipts,
          (select count(*)::text from public.goods_receipt_lines where tenant_id = $1) as goods_receipt_lines,
          (
            select count(*)::text
            from public.inventory_movements
            where tenant_id = $1
              and movement_type = 'GOODS_RECEIPT'
          ) as goods_receipt_movements
      `,
      [ctx.tenantId],
    );
    const eventCounts = await pool.query<{ event_type: string; count: string }>(
      `
        select event_type, count(*)::text as count
        from public.domain_events
        where tenant_id = $1
          and event_type in (
            'PURCHASE_ORDER_CREATED',
            'PURCHASE_ORDER_SENT',
            'GOODS_RECEIVED',
            'INVENTORY_MOVEMENT_CREATED'
          )
        group by event_type
      `,
      [ctx.tenantId],
    );
    const eventCountByType = new Map(
      eventCounts.rows.map((row) => [row.event_type, row.count]),
    );

    expect(purchaseOrder.status).toBe("DRAFT");
    expect(repeatedPurchaseOrder).toMatchObject({
      purchaseOrderId: purchaseOrder.purchaseOrderId,
      status: "DRAFT",
      alreadyCreated: true,
    });
    expect(sentPurchaseOrder.status).toBe("SENT");
    expect(repeatedSentPurchaseOrder).toMatchObject({
      purchaseOrderId: purchaseOrder.purchaseOrderId,
      status: "SENT",
      alreadySent: true,
    });
    expect(goodsReceipt.purchaseOrderStatus).toBe("FULLY_RECEIVED");
    expect(repeatedGoodsReceipt).toMatchObject({
      goodsReceiptId: goodsReceipt.goodsReceiptId,
      purchaseOrderStatus: "FULLY_RECEIVED",
      alreadyPosted: true,
    });
    expect(needResult.rows[0]).toEqual({
      status: "COVERED",
      quantity_covered: "10.0000",
    });
    expect(balance).toEqual({
      physicalQuantity: 10,
      reservedQuantity: 0,
      availableQuantity: 10,
    });
    expect(recordCounts.rows[0]).toEqual({
      purchase_orders: "1",
      goods_receipts: "1",
      goods_receipt_lines: "1",
      goods_receipt_movements: "1",
    });
    expect(eventCountByType.get("PURCHASE_ORDER_CREATED")).toBe("1");
    expect(eventCountByType.get("PURCHASE_ORDER_SENT")).toBe("1");
    expect(eventCountByType.get("GOODS_RECEIVED")).toBe("1");
    expect(eventCountByType.get("INVENTORY_MOVEMENT_CREATED")).toBe("1");
  });
});
