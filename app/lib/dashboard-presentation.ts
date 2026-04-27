import type { OperationsDashboard } from "./operational-core.server";

export interface DashboardNextAction {
  message: string;
  stage:
    | "ORDER"
    | "SUPPLY_CHECK"
    | "PURCHASE_NEED"
    | "PURCHASE_ORDER"
    | "GOODS_RECEIPT"
    | "INVENTORY_UPDATED";
}

export const dashboardFlowStages = [
  "Order",
  "Supply Check",
  "Purchase Need",
  "Purchase Order",
  "Goods Receipt",
  "Inventory Updated",
] as const;

export function getDashboardNextAction(
  dashboard: OperationsDashboard | null,
  options: { pendingShopifyOrderCount?: number } = {},
): DashboardNextAction {
  if ((options.pendingShopifyOrderCount ?? 0) > 0) {
    return {
      stage: "ORDER",
      message: `You have ${options.pendingShopifyOrderCount} Shopify ${
        options.pendingShopifyOrderCount === 1 ? "order" : "orders"
      } ready to import.`,
    };
  }

  if (!dashboard || dashboard.counts.operationsOrders === 0) {
    return {
      stage: "ORDER",
      message: "Create a demo order to start.",
    };
  }

  if (
    dashboard.operationsOrders.some((order) => order.status === "OPEN") ||
    dashboard.purchaseNeeds.length === 0 &&
      dashboard.purchaseOrders.length === 0 &&
      dashboard.goodsReceipts.length === 0
  ) {
    return {
      stage: "SUPPLY_CHECK",
      message: "Run supply check to identify missing stock.",
    };
  }

  if (dashboard.purchaseNeeds.some((need) => need.status === "OPEN")) {
    return {
      stage: "PURCHASE_NEED",
      message: "Create a purchase order for missing items.",
    };
  }

  if (dashboard.purchaseOrders.some((order) => order.status === "DRAFT")) {
    return {
      stage: "PURCHASE_ORDER",
      message: "Send the purchase order to the supplier.",
    };
  }

  if (
    dashboard.purchaseOrders.some((order) =>
      ["SENT", "PARTIALLY_RECEIVED"].includes(order.status),
    )
  ) {
    return {
      stage: "GOODS_RECEIPT",
      message: "Post goods receipt to update inventory.",
    };
  }

  return {
    stage: "INVENTORY_UPDATED",
    message: "Inventory updated.",
  };
}
