import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";

import { PageIntro, StatusBadge, SummaryCard } from "../components/OperationsUi";
import { PlanningEmptyState } from "../components/PlanningEmptyState";
import { requirePlanningContext } from "../lib/app-context.server";
import {
  createDemoKitBom,
  loadBomDetail,
  loadBomList,
} from "../lib/material-planning.server";
import { formatStatus } from "../lib/ui-format";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const context = await requirePlanningContext(request);

  if (!context.configured) {
    return { configured: false as const, boms: [] };
  }

  const boms = await loadBomList(context.pool, context.ctx);
  const withValidation = await Promise.all(
    boms.map(async (bom) => ({
      ...bom,
      validation: (await loadBomDetail(context.pool, context.ctx, bom.id))
        .validation,
    })),
  );

  return { configured: true as const, boms: withValidation };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const context = await requirePlanningContext(request);

  if (!context.configured) {
    return { ok: false, message: "Database is not configured." };
  }

  await createDemoKitBom(context.pool, context.ctx);

  return { ok: true, message: "Demo Kit BOM is ready." };
};

export default function BomsIndex() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  return (
    <s-page heading="BOMs">
      <s-section heading="Bills of material">
        <s-stack direction="block" gap="base">
          <PageIntro>
            BOMs explain which components are required when MRP plans a
            producible item.
          </PageIntro>
          {actionData && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>{actionData.message}</s-paragraph>
            </s-box>
          )}
          <Form method="post">
            <s-button
              type="submit"
              variant="secondary"
              disabled={!data.configured}
              {...(isSubmitting ? { loading: true } : {})}
            >
              Create Demo Kit BOM
            </s-button>
          </Form>
          {!data.configured && (
            <PlanningEmptyState>
              Database connection is not configured.
            </PlanningEmptyState>
          )}
          {data.configured && data.boms.length === 0 && (
            <PlanningEmptyState>No BOMs have been created yet.</PlanningEmptyState>
          )}
          {data.boms.map((bom) => (
            <SummaryCard
              key={bom.id}
              heading={bom.parentSku ?? bom.parentVariantId}
            >
              <s-paragraph>
                Version {bom.version}{" "}
                <StatusBadge status={bom.isActive ? "active" : "inactive"} />
              </s-paragraph>
              <s-paragraph>
                {bom.lines.length} component line
                {bom.lines.length === 1 ? "" : "s"} -{" "}
                {bom.validation.valid
                  ? "Valid for MRP"
                  : `Needs attention: ${bom.validation.errors
                      .map(formatStatus)
                      .join(", ")}`}
              </s-paragraph>
              <s-link href={`/app/boms/${bom.id}`}>
                Open BOM editor
              </s-link>
            </SummaryCard>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}
