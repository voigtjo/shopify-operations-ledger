import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";

import { NextActionCard, StatusBadge, SummaryCard } from "../components/OperationsUi";
import { requirePlanningContext } from "../lib/app-context.server";
import {
  cancelPurchaseOrder,
  loadPurchaseOrderDetail,
  markPurchaseOrderAcknowledged,
  markPurchaseOrderSent,
} from "../lib/purchase-orders.server";
import { formatQuantity, formatStatus, shortReference } from "../lib/ui-format";

type ActionResult = {
  ok: boolean;
  message: string;
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const context = await requirePlanningContext(request);

  if (!context.configured) {
    return {
      configured: false as const,
      purchaseOrder: null,
    };
  }

  return {
    configured: true as const,
    purchaseOrder: await loadPurchaseOrderDetail(
      context.pool,
      context.ctx,
      params.id!,
    ),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const context = await requirePlanningContext(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const purchaseOrderId = params.id!;

  if (!context.configured) {
    return {
      ok: false,
      message: "Database connection is not configured.",
    } satisfies ActionResult;
  }

  try {
    if (intent === "mark-sent") {
      const result = await markPurchaseOrderSent(context.pool, context.ctx, {
        purchaseOrderId,
      });

      return {
        ok: true,
        message: result.alreadyDone
          ? "Purchase order was already sent."
          : "Purchase order marked as sent.",
      } satisfies ActionResult;
    }

    if (intent === "mark-acknowledged") {
      const result = await markPurchaseOrderAcknowledged(
        context.pool,
        context.ctx,
        { purchaseOrderId },
      );

      return {
        ok: true,
        message: result.alreadyDone
          ? "Purchase order was already acknowledged."
          : "Purchase order marked as acknowledged.",
      } satisfies ActionResult;
    }

    if (intent === "cancel") {
      const result = await cancelPurchaseOrder(context.pool, context.ctx, {
        purchaseOrderId,
      });

      return {
        ok: true,
        message: result.alreadyDone
          ? "Purchase order was already cancelled."
          : "Purchase order cancelled.",
      } satisfies ActionResult;
    }
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? formatStatus(error.message) : "Action failed.",
    } satisfies ActionResult;
  }

  return {
    ok: false,
    message: "Unknown purchase order action.",
  } satisfies ActionResult;
};

export default function PurchaseOrderDetail() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  if (!data.configured || !data.purchaseOrder) {
    return (
      <s-page heading="Purchase Order">
        <s-section heading="Connection">
          <s-paragraph>Database connection is not configured.</s-paragraph>
        </s-section>
      </s-page>
    );
  }

  const purchaseOrder = data.purchaseOrder;
  const nextAction =
    purchaseOrder.status === "draft"
      ? {
          title: "Send purchase order",
          message:
            "Mark this PO as sent after you send it to the supplier outside Operations Ledger.",
        }
      : purchaseOrder.status === "sent"
        ? {
            title: "Record acknowledgement",
            message:
              "Mark acknowledged once the supplier confirms the order outside Operations Ledger.",
          }
        : {
            title: "Procurement follow-up",
            message:
              "Goods Receipt comes later. This page currently tracks PO status only.",
          };

  return (
    <s-page heading={purchaseOrder.displayNumber}>
      <s-section heading="Purchase Order Detail">
        <s-stack direction="block" gap="base">
          {actionData && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>{actionData.message}</s-paragraph>
            </s-box>
          )}
          <SummaryCard heading="Header">
            <s-paragraph>
              Supplier: {purchaseOrder.supplierName}
              {purchaseOrder.supplierEmail
                ? ` (${purchaseOrder.supplierEmail})`
                : ""}
            </s-paragraph>
            <s-paragraph>
              <StatusBadge status={purchaseOrder.status} /> Created{" "}
              {new Date(purchaseOrder.createdAt).toLocaleString()}
            </s-paragraph>
            <s-link href="/app/purchase-orders">Back to Purchase Orders</s-link>
          </SummaryCard>
          <NextActionCard
            title={nextAction.title}
            href="/app/purchase-orders"
            actionLabel="Back to Purchase Orders"
          >
            {nextAction.message}
          </NextActionCard>
          <s-stack direction="inline" gap="base">
            <Form method="post">
              <input type="hidden" name="intent" value="mark-sent" />
              <s-button
                type="submit"
                variant="primary"
                disabled={purchaseOrder.status !== "draft"}
                {...(isSubmitting ? { loading: true } : {})}
              >
                Mark as Sent
              </s-button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="mark-acknowledged" />
              <s-button
                type="submit"
                variant="primary"
                disabled={purchaseOrder.status !== "sent"}
                {...(isSubmitting ? { loading: true } : {})}
              >
                Mark as Acknowledged
              </s-button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="cancel" />
              <s-button
                type="submit"
                variant="secondary"
                disabled={!["draft", "sent"].includes(purchaseOrder.status)}
                {...(isSubmitting ? { loading: true } : {})}
              >
                Cancel
              </s-button>
            </Form>
          </s-stack>
          <s-paragraph>
            Goods Receipt comes later. No supplier email is sent from this app
            yet, and no Shopify inventory is changed.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Lines">
        <s-stack direction="block" gap="base">
          {purchaseOrder.lines.map((line) => (
            <s-box
              key={line.id}
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-paragraph>
                <s-text>{line.sku ?? line.title}</s-text>
                <s-text>
                  {" "}
                  - qty {formatQuantity(line.quantity)} {line.unit}
                </s-text>
                <s-text> - {formatStatus(line.status)}</s-text>
              </s-paragraph>
              <s-paragraph>
                Source need:{" "}
                {line.sourcePurchaseNeedId
                  ? shortReference(line.sourcePurchaseNeedId)
                  : "Not linked"}
              </s-paragraph>
              <s-paragraph>
                Source MRP run:{" "}
                {line.sourceMrpRunId ? (
                  <s-link href={`/app/mrp/${line.sourceMrpRunId}`}>
                    {shortReference(line.sourceMrpRunId)}
                  </s-link>
                ) : (
                  "Not linked"
                )}
              </s-paragraph>
            </s-box>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}
