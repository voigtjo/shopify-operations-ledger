import { describe, expect, it } from "vitest";

import { getDashboardNextAction } from "../../app/lib/dashboard-presentation";
import type { OperationsDashboard } from "../../app/lib/operational-core.server";

type DashboardFixture = Omit<Partial<OperationsDashboard>, "counts"> & {
  counts?: Partial<OperationsDashboard["counts"]>;
};

function dashboard(
  partial: DashboardFixture = {},
): OperationsDashboard {
  return {
    tenant: {
      id: "tenant-1",
      primaryShopDomain: "operations-ledger-dev.myshopify.com",
      status: "ACTIVE",
    },
    counts: {
      operationsOrders: 0,
      purchaseNeeds: 0,
      purchaseOrders: 0,
      goodsReceipts: 0,
      inventoryMovements: 0,
      ...partial.counts,
    },
    operationsOrders: partial.operationsOrders ?? [],
    purchaseNeeds: partial.purchaseNeeds ?? [],
    purchaseOrders: partial.purchaseOrders ?? [],
    goodsReceipts: partial.goodsReceipts ?? [],
    inventoryMovements: partial.inventoryMovements ?? [],
  };
}

describe("dashboard presentation helpers", () => {
  it("prioritizes real Shopify orders ready to import", () => {
    expect(
      getDashboardNextAction(null, { pendingShopifyOrderCount: 2 }),
    ).toEqual({
      stage: "ORDER",
      message: "You have 2 Shopify orders ready to import.",
    });
  });

  it("starts with demo order creation", () => {
    expect(getDashboardNextAction(null)).toEqual({
      stage: "ORDER",
      message: "Create a demo order to start.",
    });
  });

  it("asks for supply check after an open order exists", () => {
    expect(
      getDashboardNextAction(
        dashboard({
          counts: { operationsOrders: 1 },
          operationsOrders: [
            {
              id: "order-1",
              orderNumber: "DEV-OPS-1001",
              status: "OPEN",
              originType: "SHOPIFY_ORDER",
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      ),
    ).toMatchObject({ stage: "SUPPLY_CHECK" });
  });

  it("moves through procurement and receipt actions", () => {
    expect(
      getDashboardNextAction(
        dashboard({
          counts: { operationsOrders: 1, purchaseNeeds: 1 },
          purchaseNeeds: [
            {
              id: "need-1",
              operationsOrderId: "order-1",
              operationsOrderNumber: "DEV-OPS-1001",
              sku: "OPS-KIT-DEMO",
              title: "Operations Demo Kit",
              quantityRequired: 3,
              quantityReserved: 0,
              quantityNeeded: 3,
              quantityCovered: 0,
              status: "OPEN",
              supplierName: null,
            },
          ],
        }),
      ),
    ).toMatchObject({ stage: "PURCHASE_NEED" });

    expect(
      getDashboardNextAction(
        dashboard({
          counts: { operationsOrders: 1, purchaseNeeds: 1, purchaseOrders: 1 },
          purchaseOrders: [
            {
              id: "po-1",
              supplierName: "Development Demo Supplier",
              poNumber: null,
              status: "DRAFT",
              currency: "EUR",
              relatedNeedTitle: "Operations Demo Kit",
              relatedOrderNumber: "DEV-OPS-1001",
              lineCount: 1,
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      ),
    ).toMatchObject({ stage: "PURCHASE_ORDER" });

    expect(
      getDashboardNextAction(
        dashboard({
          counts: { operationsOrders: 1, purchaseNeeds: 1, purchaseOrders: 1 },
          purchaseOrders: [
            {
              id: "po-1",
              supplierName: "Development Demo Supplier",
              poNumber: null,
              status: "SENT",
              currency: "EUR",
              relatedNeedTitle: "Operations Demo Kit",
              relatedOrderNumber: "DEV-OPS-1001",
              lineCount: 1,
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      ),
    ).toMatchObject({ stage: "GOODS_RECEIPT" });
  });
});
