import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { PlanningEmptyState } from "../components/PlanningEmptyState";
import { requirePlanningContext } from "../lib/app-context.server";
import { preparePurchaseOrderDraftPreview } from "../lib/purchase-needs.server";
import { formatQuantity, shortReference } from "../lib/ui-format";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const context = await requirePlanningContext(request);

  if (!context.configured) {
    return {
      configured: false as const,
      groups: [],
    };
  }

  return {
    configured: true as const,
    ...(await preparePurchaseOrderDraftPreview(context.pool, context.ctx)),
  };
};

export default function PurchaseOrderDraftPreview() {
  const data = useLoaderData<typeof loader>();
  const totalNeeds = data.groups.reduce((sum, group) => sum + group.needCount, 0);

  return (
    <s-page heading="PO Draft Preview">
      <s-section heading="Prepare PO Draft">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            This preview groups ready purchase needs by supplier and shows what
            would become purchase order lines. Final PO creation, approval,
            sending, and receiving are later scope.
          </s-paragraph>
          {!data.configured && (
            <PlanningEmptyState>
              Database connection is not configured.
            </PlanningEmptyState>
          )}
          {data.configured && data.groups.length === 0 && (
            <PlanningEmptyState>
              No purchase needs are ready for PO draft yet. Assign suppliers and
              mark needs ready from the Needs board first.
            </PlanningEmptyState>
          )}
          {data.configured && data.groups.length > 0 && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>
                {totalNeeds} purchase need{totalNeeds === 1 ? "" : "s"} ready
                across {data.groups.length} supplier group
                {data.groups.length === 1 ? "" : "s"}.
              </s-paragraph>
            </s-box>
          )}
          {data.groups.map((group) => (
            <s-box
              key={group.supplierId}
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-stack direction="block" gap="small">
                <s-heading>{group.supplierName}</s-heading>
                <s-paragraph>
                  {group.supplierEmail ?? "No supplier email"} -{" "}
                  {group.needCount} need{group.needCount === 1 ? "" : "s"} -
                  total qty {formatQuantity(group.totalQuantity)}
                </s-paragraph>
                {group.lines.map((line) => (
                  <s-box
                    key={line.purchaseNeedId}
                    padding="base"
                    borderWidth="base"
                    borderRadius="base"
                  >
                    <s-paragraph>
                      <s-text>{line.sku ?? line.title}</s-text>
                      <s-text>
                        {" "}
                        - order qty {formatQuantity(line.quantityToOrder)}
                      </s-text>
                    </s-paragraph>
                    <s-paragraph>
                      Needed {formatQuantity(line.quantityNeeded)} - covered{" "}
                      {formatQuantity(line.quantityCovered)}
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
            </s-box>
          ))}
          <s-link href="/app/needs">Back to Needs board</s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}
