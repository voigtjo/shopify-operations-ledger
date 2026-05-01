import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { PlanningEmptyState } from "../components/PlanningEmptyState";
import { requirePlanningContext } from "../lib/app-context.server";
import { listPurchaseOrders } from "../lib/purchase-orders.server";
import { formatStatus } from "../lib/ui-format";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const context = await requirePlanningContext(request);

  if (!context.configured) {
    return {
      configured: false as const,
      purchaseOrders: [],
    };
  }

  return {
    configured: true as const,
    purchaseOrders: await listPurchaseOrders(context.pool, context.ctx),
  };
};

export default function PurchaseOrdersIndex() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading="Purchase Orders">
      <s-section heading="Purchase Order Lifecycle">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Purchase Orders are created from ready purchase needs. This slice
            supports draft, sent, acknowledged, and cancelled states only.
          </s-paragraph>
          {!data.configured && (
            <PlanningEmptyState>
              Database connection is not configured.
            </PlanningEmptyState>
          )}
          {data.configured && data.purchaseOrders.length === 0 && (
            <PlanningEmptyState>
              No purchase orders yet. Prepare PO drafts from ready purchase
              needs first.
            </PlanningEmptyState>
          )}
          {data.purchaseOrders.map((order) => (
            <s-box
              key={order.id}
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-stack direction="block" gap="small">
                <s-paragraph>
                  <s-link href={`/app/purchase-orders/${order.id}`}>
                    {order.displayNumber}
                  </s-link>
                  <s-text> - {order.supplierName}</s-text>
                  <s-text> - {formatStatus(order.status)}</s-text>
                </s-paragraph>
                <s-paragraph>
                  {order.lineCount} line{order.lineCount === 1 ? "" : "s"} -{" "}
                  {order.sourceNeedCount} source need
                  {order.sourceNeedCount === 1 ? "" : "s"} - created{" "}
                  {new Date(order.createdAt).toLocaleString()}
                </s-paragraph>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}
