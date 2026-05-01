import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";

import { requirePlanningContext } from "../lib/app-context.server";
import {
  createOrUpdateBom,
  loadBomDetail,
  loadItemList,
  runMrpPreview,
} from "../lib/material-planning.server";
import { formatQuantity, formatStatus } from "../lib/ui-format";

function formString(formData: FormData, key: string) {
  const value = formData.get(key);

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const context = await requirePlanningContext(request);

  if (!context.configured) {
    return { configured: false as const, bom: null, items: [] };
  }

  return {
    configured: true as const,
    bom: await loadBomDetail(context.pool, context.ctx, params.id!),
    items: await loadItemList(context.pool, context.ctx, { limit: 200 }),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const context = await requirePlanningContext(request);

  if (!context.configured) {
    return { ok: false, message: "Database is not configured." };
  }

  const formData = await request.formData();
  const intent = formData.get("intent");
  const bom = await loadBomDetail(context.pool, context.ctx, params.id!);

  if (intent === "run-mrp-preview") {
    const result = await runMrpPreview(context.pool, context.ctx, {
      demandSourceType: "bom",
      demandSourceId: bom.id,
      idempotencyKey: `mrp_preview:bom:${bom.id}:qty:1`,
      demandLines: [{ itemId: bom.parentItemId, quantity: 1 }],
    });

    return redirect(`/app/mrp/${result.mrpRunId}`);
  }

  const componentIds = formData
    .getAll("componentItemId")
    .filter((value): value is string => typeof value === "string" && Boolean(value));
  const quantities = formData.getAll("quantity");
  const units = formData.getAll("unit");
  const lines = componentIds.map((componentItemId, index) => ({
    componentItemId,
    quantity: Number(quantities[index] ?? 0),
    unit: typeof units[index] === "string" ? units[index] : "pcs",
  }));

  try {
    await createOrUpdateBom(context.pool, context.ctx, {
      parentItemId: bom.parentItemId,
      version: formString(formData, "version") ?? bom.version,
      isActive: formData.get("isActive") === "on",
      lines,
    });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unable to save BOM.",
    };
  }

  return redirect(`/app/boms/${params.id}`);
};

export default function BomDetail() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  if (!data.configured || !data.bom) {
    return (
      <s-page heading="BOM detail">
        <s-section heading="Connection">
          <s-paragraph>Database connection is not configured.</s-paragraph>
        </s-section>
      </s-page>
    );
  }

  const bom = data.bom;

  return (
    <s-page heading={`BOM · ${bom.parentSku ?? bom.parentItemId}`}>
      <s-section heading="BOM detail">
        <s-stack direction="block" gap="base">
          {actionData && "message" in actionData && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>{actionData.message}</s-paragraph>
            </s-box>
          )}
          <s-paragraph>
            Parent item: {bom.parentSku ?? bom.parentItemId} ·{" "}
            {formatStatus(bom.parentItemType)}
          </s-paragraph>
          <s-paragraph>
            Parent can be active BOM parent:{" "}
            {bom.parentIsProducible ? "Yes" : "No"}
          </s-paragraph>
          <s-paragraph>
            Validation:{" "}
            {bom.validation.valid
              ? "Valid"
              : bom.validation.errors.map(formatStatus).join(", ")}
          </s-paragraph>
          <Form method="post">
            <s-stack direction="block" gap="base">
              <label>
                Version <input name="version" defaultValue={bom.version} />
              </label>
              <label>
                <input
                  type="checkbox"
                  name="isActive"
                  defaultChecked={bom.isActive}
                />{" "}
                Active
              </label>
              {bom.lines.map((line) => (
                <s-box
                  key={line.id}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                >
                  <s-stack direction="inline" gap="small">
                    <label>
                      Component{" "}
                      <select
                        name="componentItemId"
                        defaultValue={line.componentItemId}
                      >
                        {data.items.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.sku ?? item.shopifyVariantId}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Qty{" "}
                      <input
                        name="quantity"
                        defaultValue={String(line.quantity)}
                        size={6}
                      />
                    </label>
                    <label>
                      Unit{" "}
                      <input name="unit" defaultValue={line.unit} size={6} />
                    </label>
                    <s-text>
                      Current: {formatQuantity(line.quantity)} x{" "}
                      {line.componentSku}
                    </s-text>
                  </s-stack>
                </s-box>
              ))}
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="inline" gap="small">
                  <label>
                    Add component{" "}
                    <select name="componentItemId" defaultValue="">
                      <option value="">None</option>
                      {data.items.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.sku ?? item.shopifyVariantId}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Qty <input name="quantity" defaultValue="" size={6} />
                  </label>
                  <label>
                    Unit <input name="unit" defaultValue="pcs" size={6} />
                  </label>
                </s-stack>
              </s-box>
              <s-stack direction="inline" gap="base">
                <s-button
                  type="submit"
                  variant="primary"
                  {...(isSubmitting ? { loading: true } : {})}
                >
                  Save BOM
                </s-button>
              </s-stack>
            </s-stack>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="run-mrp-preview" />
            <s-button
              type="submit"
              variant="secondary"
              disabled={!bom.validation.valid}
              {...(isSubmitting ? { loading: true } : {})}
            >
              Run MRP Preview for This BOM
            </s-button>
          </Form>
        </s-stack>
      </s-section>
    </s-page>
  );
}
