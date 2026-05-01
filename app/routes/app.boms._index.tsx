import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";

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
          <s-paragraph>
            BOMs explain which components are required when MRP plans a
            producible item.
          </s-paragraph>
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
            <s-box
              key={bom.id}
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-paragraph>
                <s-link href={`/app/boms/${bom.id}`}>
                  {bom.parentSku ?? bom.parentVariantId}
                </s-link>
                <s-text> · version {bom.version}</s-text>
                <s-text> · {bom.isActive ? "Active" : "Inactive"}</s-text>
              </s-paragraph>
              <s-paragraph>
                <s-text>{bom.lines.length} component lines</s-text>
                <s-text>
                  {" "}
                  ·{" "}
                  {bom.validation.valid
                    ? "Valid"
                    : `Invalid: ${bom.validation.errors.map(formatStatus).join(", ")}`}
                </s-text>
              </s-paragraph>
            </s-box>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}
