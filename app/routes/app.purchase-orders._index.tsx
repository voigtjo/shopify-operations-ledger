import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { PageIntro, StatusBadge, SummaryCard, WorkQueueSection } from "../components/OperationsUi";
import { PlanningEmptyState } from "../components/PlanningEmptyState";
import { requirePlanningContext } from "../lib/app-context.server";
import { listPurchaseOrders } from "../lib/purchase-orders.server";

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
  const boardCounts = {
    draft: data.purchaseOrders.filter((order) => order.status === "draft").length,
    sent: data.purchaseOrders.filter((order) => order.status === "sent").length,
    acknowledged: data.purchaseOrders.filter(
      (order) => order.status === "acknowledged",
    ).length,
    cancelled: data.purchaseOrders.filter((order) => order.status === "cancelled").length,
  };

  return (
    <s-page heading="Purchase Orders">
      <s-section heading="Purchase Order Lifecycle">
        <s-stack direction="block" gap="base">
          <PageIntro>
            Purchase Orders are created from ready purchase needs. This slice
            supports draft, sent, acknowledged, and cancelled states only.
          </PageIntro>
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
          {data.configured && (
            <s-stack direction="inline" gap="base">
              <WorkQueueSection heading="Draft">
                <s-paragraph>{boardCounts.draft}</s-paragraph>
              </WorkQueueSection>
              <WorkQueueSection heading="Sent">
                <s-paragraph>{boardCounts.sent}</s-paragraph>
              </WorkQueueSection>
              <WorkQueueSection heading="Acknowledged">
                <s-paragraph>{boardCounts.acknowledged}</s-paragraph>
              </WorkQueueSection>
              <WorkQueueSection heading="Cancelled">
                <s-paragraph>{boardCounts.cancelled}</s-paragraph>
              </WorkQueueSection>
            </s-stack>
          )}
          {data.purchaseOrders.map((order) => (
            <SummaryCard
              key={order.id}
              heading={order.displayNumber}
            >
              <s-paragraph>
                {order.supplierName} <StatusBadge status={order.status} />
              </s-paragraph>
              <s-paragraph>
                {order.lineCount} line{order.lineCount === 1 ? "" : "s"} -{" "}
                {order.sourceNeedCount} source need
                {order.sourceNeedCount === 1 ? "" : "s"} - created{" "}
                {new Date(order.createdAt).toLocaleString()}
              </s-paragraph>
              <s-link href={`/app/purchase-orders/${order.id}`}>
                Open purchase order
              </s-link>
            </SummaryCard>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}
