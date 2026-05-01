import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  calculateMaterialDemand,
  commitMrpRunNeeds,
  createBom,
  createDemoKitBom,
  createDemoKitItems,
  createProductionNeedsFromMrp,
  createPurchaseNeedsFromMrp,
  ensureItemForShopifyVariant,
  loadBomList,
  previewDemoKitMrp,
  validateBom,
  updateItemClassification,
} from "../../app/lib/material-planning.server";
import {
  createInventoryAdjustment,
  importShopifyOrder,
  runSupplyCheck,
  type TenantContext,
} from "../../app/lib/operational-core.server";
import {
  assignPreferredSupplierToPurchaseNeed,
  assignSupplierToPurchaseNeed,
  createSupplier,
  linkSupplierToItem,
  listPurchaseNeedsBoard,
  listSupplierItemLinks,
  markPurchaseNeedReadyForPo,
  preparePurchaseOrderDraftPreview,
  setSupplierActive,
  updateSupplier,
} from "../../app/lib/purchase-needs.server";

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

  it("creates demo kit items idempotently", async () => {
    await createDemoKitItems(pool, ctx);
    await createDemoKitItems(pool, ctx);

    const result = await pool.query<{
      item_count: string;
      assembly_count: string;
      purchasable_count: string;
    }>(
      `
        select
          count(*)::text as item_count,
          count(*) filter (where sku = 'DEMO-KIT' and item_type = 'assembly' and is_producible = true)::text as assembly_count,
          count(*) filter (where sku in ('BOX', 'COMPONENT-A', 'MANUAL') and is_purchasable = true)::text as purchasable_count
        from public.items
        where tenant_id = $1
          and sku in ('DEMO-KIT', 'BOX', 'COMPONENT-A', 'MANUAL')
      `,
      [ctx.tenantId],
    );

    expect(result.rows[0]).toEqual({
      item_count: "4",
      assembly_count: "1",
      purchasable_count: "3",
    });
  });

  it("creates demo kit BOM idempotently and loads parent lines", async () => {
    await createDemoKitBom(pool, ctx);
    await createDemoKitBom(pool, ctx);

    const boms = await loadBomList(pool, ctx);
    const demoBom = boms.find((bom) => bom.parentSku === "DEMO-KIT");

    expect(demoBom).toBeTruthy();
    expect(demoBom?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ componentSku: "BOX", quantity: 1 }),
        expect.objectContaining({ componentSku: "COMPONENT-A", quantity: 2 }),
        expect.objectContaining({ componentSku: "MANUAL", quantity: 1 }),
      ]),
    );

    const counts = await pool.query<{
      bom_count: string;
      line_count: string;
    }>(
      `
        select
          count(distinct boms.id)::text as bom_count,
          count(bom_lines.id)::text as line_count
        from public.boms
        join public.items
          on items.id = boms.parent_item_id
        left join public.bom_lines
          on bom_lines.bom_id = boms.id
        where boms.tenant_id = $1
          and items.sku = 'DEMO-KIT'
      `,
      [ctx.tenantId],
    );

    expect(counts.rows[0]).toEqual({
      bom_count: "1",
      line_count: "3",
    });
  });

  it("rejects active BOMs when the parent is not producible", async () => {
    const parent = await ensureItemForShopifyVariant(pool, ctx, {
      shopifyVariantId: "gid://shopify/ProductVariant/non-producible-parent",
      sku: "NON-PRODUCIBLE",
    });
    const component = await ensureItemForShopifyVariant(pool, ctx, {
      shopifyVariantId: "gid://shopify/ProductVariant/non-producible-component",
      sku: "NON-PRODUCIBLE-COMP",
      isSellable: false,
    });

    await updateItemClassification(pool, ctx, {
      itemId: component.itemId,
      itemType: "component",
    });

    await expect(
      createBom(pool, ctx, {
        parentItemId: parent.itemId,
        lines: [{ componentItemId: component.itemId, quantity: 1 }],
      }),
    ).rejects.toThrow("active_bom_parent_not_producible");
  });

  it("validates duplicate, invalid quantity, and cycle BOM lines", async () => {
    const assemblyA = await ensureItemForShopifyVariant(pool, ctx, {
      shopifyVariantId: "gid://shopify/ProductVariant/cycle-a",
      sku: "CYCLE-A",
    });
    const assemblyB = await ensureItemForShopifyVariant(pool, ctx, {
      shopifyVariantId: "gid://shopify/ProductVariant/cycle-b",
      sku: "CYCLE-B",
    });

    await updateItemClassification(pool, ctx, {
      itemId: assemblyA.itemId,
      itemType: "assembly",
    });
    await updateItemClassification(pool, ctx, {
      itemId: assemblyB.itemId,
      itemType: "assembly",
    });

    const invalid = await validateBom(pool, ctx, {
      parentItemId: assemblyA.itemId,
      lines: [
        { componentItemId: assemblyB.itemId, quantity: 0 },
        { componentItemId: assemblyB.itemId, quantity: 1 },
      ],
    });

    expect(invalid.valid).toBe(false);
    expect(invalid.errors).toEqual(
      expect.arrayContaining(["invalid_quantity", "duplicate_component_line"]),
    );

    await createBom(pool, ctx, {
      parentItemId: assemblyA.itemId,
      lines: [{ componentItemId: assemblyB.itemId, quantity: 1 }],
    });

    await expect(
      createBom(pool, ctx, {
        parentItemId: assemblyB.itemId,
        lines: [{ componentItemId: assemblyA.itemId, quantity: 1 }],
      }),
    ).rejects.toThrow("bom_cycle_detected");
  });

  it("previews MRP demand for one Demo Kit", async () => {
    await createDemoKitBom(pool, ctx);
    await createInventoryAdjustment(pool, ctx, {
      shopifyVariantId: "demo-variant:component-a",
      sku: "COMPONENT-A",
      title: "Component A",
      quantityDelta: 1,
      reason: "MRP preview partial availability test",
    });

    const preview = await previewDemoKitMrp(pool, ctx, 1);
    const counts = await pool.query<{
      mrp_run_count: string;
      mrp_run_line_count: string;
      purchase_need_count: string;
      production_need_count: string;
    }>(
      `
        select
          (select count(*)::text from public.mrp_runs where tenant_id = $1) as mrp_run_count,
          (select count(*)::text from public.mrp_run_lines where tenant_id = $1) as mrp_run_line_count,
          (select count(*)::text from public.purchase_needs where tenant_id = $1) as purchase_need_count,
          (select count(*)::text from public.production_needs where tenant_id = $1) as production_need_count
      `,
      [ctx.tenantId],
    );

    expect(preview?.parent).toEqual(
      expect.objectContaining({
        sku: "DEMO-KIT",
        requiredQuantity: 1,
        shortageQuantity: 1,
        action: "produce",
      }),
    );
    expect(preview?.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sku: "BOX",
          requiredQuantity: 1,
          shortageQuantity: 1,
          action: "purchase",
        }),
        expect.objectContaining({
          sku: "COMPONENT-A",
          requiredQuantity: 2,
          availableQuantity: 1,
          shortageQuantity: 1,
          action: "purchase",
        }),
        expect.objectContaining({
          sku: "MANUAL",
          requiredQuantity: 1,
          shortageQuantity: 1,
          action: "purchase",
        }),
      ]),
    );
    expect(counts.rows[0]).toEqual({
      mrp_run_count: "1",
      mrp_run_line_count: "4",
      purchase_need_count: "0",
      production_need_count: "0",
    });
  });

  it("commits purchase and production needs from a completed MRP Preview idempotently", async () => {
    await createDemoKitBom(pool, ctx);
    await createInventoryAdjustment(pool, ctx, {
      shopifyVariantId: "demo-variant:component-a",
      sku: "COMPONENT-A",
      title: "Component A",
      quantityDelta: 1,
      reason: "MRP commit partial availability test",
    });

    const preview = await previewDemoKitMrp(pool, ctx, 1);

    expect(preview?.mrpRunId).toBeTruthy();

    const first = await commitMrpRunNeeds(pool, ctx, {
      mrpRunId: preview!.mrpRunId!,
    });
    const second = await commitMrpRunNeeds(pool, ctx, {
      mrpRunId: preview!.mrpRunId!,
    });
    const counts = await pool.query<{
      purchase_need_count: string;
      production_need_count: string;
      purchase_order_count: string;
      production_order_table_exists: string | null;
    }>(
      `
        select
          (select count(*)::text from public.purchase_needs where tenant_id = $1) as purchase_need_count,
          (select count(*)::text from public.production_needs where tenant_id = $1) as production_need_count,
          (select count(*)::text from public.purchase_orders where tenant_id = $1) as purchase_order_count,
          to_regclass('public.production_orders')::text as production_order_table_exists
      `,
      [ctx.tenantId],
    );

    expect(first.purchaseNeeds).toHaveLength(3);
    expect(first.productionNeeds).toHaveLength(1);
    expect(first.purchaseNeeds.every((need) => !need.alreadyCommitted)).toBe(
      true,
    );
    expect(first.productionNeeds.every((need) => !need.alreadyCommitted)).toBe(
      true,
    );
    expect(second.purchaseNeeds).toHaveLength(3);
    expect(second.productionNeeds).toHaveLength(1);
    expect(second.purchaseNeeds.every((need) => need.alreadyCommitted)).toBe(
      true,
    );
    expect(second.productionNeeds.every((need) => need.alreadyCommitted)).toBe(
      true,
    );
    expect(counts.rows[0]).toEqual({
      purchase_need_count: "3",
      production_need_count: "1",
      purchase_order_count: "0",
      production_order_table_exists: null,
    });
  });

  it("can commit purchase and production needs through separate MRP services", async () => {
    await createDemoKitBom(pool, ctx);
    const preview = await previewDemoKitMrp(pool, ctx, 1);

    const purchaseResult = await createPurchaseNeedsFromMrp(pool, ctx, {
      mrpRunId: preview!.mrpRunId!,
    });
    const productionResult = await createProductionNeedsFromMrp(pool, ctx, {
      mrpRunId: preview!.mrpRunId!,
    });

    expect(purchaseResult.purchaseNeeds).toHaveLength(3);
    expect(productionResult.productionNeeds).toHaveLength(1);
  });

  it("assigns suppliers and groups ready purchase needs into a PO draft preview", async () => {
    await createDemoKitBom(pool, ctx);
    const preview = await previewDemoKitMrp(pool, ctx, 1);
    await commitMrpRunNeeds(pool, ctx, {
      mrpRunId: preview!.mrpRunId!,
    });
    const supplier = await createSupplier(pool, ctx, {
      name: "Demo Components Supplier",
      email: "buyer@example.com",
    });
    const needs = await pool.query<{ id: string }>(
      `
        select id
        from public.purchase_needs
        where tenant_id = $1
        order by created_at asc
      `,
      [ctx.tenantId],
    );

    expect(needs.rows).toHaveLength(3);

    for (const need of needs.rows) {
      await assignSupplierToPurchaseNeed(pool, ctx, {
        purchaseNeedId: need.id,
        supplierId: supplier.id,
        rememberForItem: true,
      });
      await markPurchaseNeedReadyForPo(pool, ctx, {
        purchaseNeedId: need.id,
      });
    }

    const previewGroups = await preparePurchaseOrderDraftPreview(pool, ctx);
    const counts = await pool.query<{ purchase_order_count: string }>(
      `
        select count(*)::text as purchase_order_count
        from public.purchase_orders
        where tenant_id = $1
      `,
      [ctx.tenantId],
    );

    expect(previewGroups.groups).toHaveLength(1);
    expect(previewGroups.groups[0]).toEqual(
      expect.objectContaining({
        supplierName: "Demo Components Supplier",
        supplierEmail: "buyer@example.com",
        needCount: 3,
      }),
    );
    expect(previewGroups.groups[0]!.lines).toHaveLength(3);
    expect(counts.rows[0]).toEqual({ purchase_order_count: "0" });
  });

  it("rejects inactive suppliers for purchase need assignment", async () => {
    await createDemoKitBom(pool, ctx);
    const preview = await previewDemoKitMrp(pool, ctx, 1);
    const committed = await commitMrpRunNeeds(pool, ctx, {
      mrpRunId: preview!.mrpRunId!,
    });
    const inactiveSupplier = await createSupplier(pool, ctx, {
      name: "Inactive Supplier",
    });

    await setSupplierActive(pool, ctx, {
      supplierId: inactiveSupplier.id,
      active: false,
    });

    await expect(
      assignSupplierToPurchaseNeed(pool, ctx, {
        purchaseNeedId: committed.purchaseNeeds[0]!.id,
        supplierId: inactiveSupplier.id,
      }),
    ).rejects.toThrow("supplier_inactive");
  });

  it("updates suppliers, links preferred item suppliers, and assigns the preferred supplier to a purchase need", async () => {
    await createDemoKitBom(pool, ctx);
    const preview = await previewDemoKitMrp(pool, ctx, 1);
    await commitMrpRunNeeds(pool, ctx, {
      mrpRunId: preview!.mrpRunId!,
    });
    const supplier = await createSupplier(pool, ctx, {
      name: "Preferred Box Supplier",
      email: "old@example.com",
    });
    const updated = await updateSupplier(pool, ctx, {
      supplierId: supplier.id,
      name: "Preferred Box Supplier",
      email: "new@example.com",
    });
    const boxNeed = await pool.query<{ id: string; item_id: string }>(
      `
        select id, item_id
        from public.purchase_needs
        where tenant_id = $1
          and sku = 'BOX'
        limit 1
      `,
      [ctx.tenantId],
    );

    await linkSupplierToItem(pool, ctx, {
      supplierId: supplier.id,
      itemId: boxNeed.rows[0]!.item_id,
      supplierSku: "SUP-BOX",
      purchaseUnit: "pcs",
      isPreferred: true,
    });

    const links = await listSupplierItemLinks(pool, ctx);
    const boardBeforeAssignment = await listPurchaseNeedsBoard(pool, ctx, {
      filter: "open",
    });
    const boxBoardNeed = boardBeforeAssignment.purchaseNeeds.find(
      (need) => need.id === boxNeed.rows[0]!.id,
    );

    await assignPreferredSupplierToPurchaseNeed(pool, ctx, {
      purchaseNeedId: boxNeed.rows[0]!.id,
    });

    const boardAfterAssignment = await listPurchaseNeedsBoard(pool, ctx, {
      filter: "open",
    });
    const assignedBoxNeed = boardAfterAssignment.purchaseNeeds.find(
      (need) => need.id === boxNeed.rows[0]!.id,
    );
    const counts = await pool.query<{ purchase_order_count: string }>(
      `
        select count(*)::text as purchase_order_count
        from public.purchase_orders
        where tenant_id = $1
      `,
      [ctx.tenantId],
    );

    expect(updated.email).toBe("new@example.com");
    expect(links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          supplierName: "Preferred Box Supplier",
          itemSku: "BOX",
          supplierSku: "SUP-BOX",
          isPreferred: true,
          active: true,
        }),
      ]),
    );
    expect(boxBoardNeed).toEqual(
      expect.objectContaining({
        recommendedSupplierId: supplier.id,
        recommendedSupplierName: "Preferred Box Supplier",
      }),
    );
    expect(assignedBoxNeed).toEqual(
      expect.objectContaining({
        assignedSupplierId: supplier.id,
        assignedSupplierName: "Preferred Box Supplier",
      }),
    );
    expect(counts.rows[0]).toEqual({ purchase_order_count: "0" });
  });

  it("runs demo kit supply check without duplicate purchase or production needs", async () => {
    await createDemoKitBom(pool, ctx);

    const imported = await importShopifyOrder(pool, {
      shopDomain: testShopDomain,
      shopifyOrderId: "gid://shopify/Order/demo-kit-mrp",
      shopifyOrderName: "#DEMO-KIT-MRP",
      lines: [
        {
          shopifyVariantId: "demo-variant:demo-kit",
          sku: "DEMO-KIT",
          title: "Demo Kit",
          quantity: 1,
        },
      ],
    });
    const first = await runSupplyCheck(pool, ctx, imported.operationsOrderId);
    const second = await runSupplyCheck(pool, ctx, imported.operationsOrderId);
    const counts = await pool.query<{
      production_need_count: string;
      purchase_need_count: string;
    }>(
      `
        select
          (select count(*)::text from public.production_needs where tenant_id = $1) as production_need_count,
          (select count(*)::text from public.purchase_needs where tenant_id = $1) as purchase_need_count
      `,
      [ctx.tenantId],
    );

    expect(first.createdProductionNeeds).toHaveLength(1);
    expect(first.createdPurchaseNeeds).toHaveLength(3);
    expect(second.createdProductionNeeds).toHaveLength(0);
    expect(second.createdPurchaseNeeds).toHaveLength(0);
    expect(counts.rows[0]).toEqual({
      production_need_count: "1",
      purchase_need_count: "3",
    });
  });
});
