import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { PlanningEmptyState } from "../components/PlanningEmptyState";
import { requirePlanningContext } from "../lib/app-context.server";
import { loadNeedsBoard } from "../lib/material-planning.server";
import { formatQuantity, formatStatus, shortReference } from "../lib/ui-format";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const context = await requirePlanningContext(request);

  if (!context.configured) {
    return {
      configured: false as const,
      purchaseNeeds: [],
      productionNeeds: [],
    };
  }

  return {
    configured: true as const,
    ...(await loadNeedsBoard(context.pool, context.ctx)),
  };
};

export default function NeedsIndex() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading="Needs">
      <s-section heading="Purchase Needs">
        <s-stack direction="block" gap="base">
          {!data.configured && (
            <PlanningEmptyState>
              Database connection is not configured.
            </PlanningEmptyState>
          )}
          {data.configured && data.purchaseNeeds.length === 0 && (
            <PlanningEmptyState>No purchase needs yet.</PlanningEmptyState>
          )}
          {data.purchaseNeeds.map((need) => (
            <s-box
              key={need.id}
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-paragraph>
                <s-text>{need.sku ?? need.title}</s-text>
                <s-text> · {formatStatus(need.status)}</s-text>
                <s-text> · qty {formatQuantity(need.quantityNeeded)}</s-text>
              </s-paragraph>
              <s-paragraph>
                <s-text>
                  Source MRP run:{" "}
                  {need.mrpRunId ? (
                    <s-link href={`/app/mrp/${need.mrpRunId}`}>
                      {shortReference(need.mrpRunId)}
                    </s-link>
                  ) : (
                    "Not linked"
                  )}
                </s-text>
              </s-paragraph>
              <s-paragraph>PO creation is later scope.</s-paragraph>
            </s-box>
          ))}
        </s-stack>
      </s-section>

      <s-section heading="Production Needs">
        <s-stack direction="block" gap="base">
          {data.configured && data.productionNeeds.length === 0 && (
            <PlanningEmptyState>No production needs yet.</PlanningEmptyState>
          )}
          {data.productionNeeds.map((need) => (
            <s-box
              key={need.id}
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-paragraph>
                <s-text>{need.sku ?? need.itemId}</s-text>
                <s-text> · {formatStatus(need.status)}</s-text>
                <s-text>
                  {" "}
                  · qty {formatQuantity(need.requiredQuantity)}
                </s-text>
              </s-paragraph>
              <s-paragraph>
                <s-text>
                  Source MRP run:{" "}
                  {need.mrpRunId ? (
                    <s-link href={`/app/mrp/${need.mrpRunId}`}>
                      {shortReference(need.mrpRunId)}
                    </s-link>
                  ) : (
                    "Not linked"
                  )}
                </s-text>
              </s-paragraph>
              <s-paragraph>Production order creation is later scope.</s-paragraph>
            </s-box>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}
