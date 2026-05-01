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
  loadItemDetail,
  updateItemClassification,
  type ItemType,
} from "../lib/material-planning.server";
import { formatAction, formatQuantity, formatStatus, shortReference } from "../lib/ui-format";

const itemTypes: ItemType[] = [
  "product",
  "component",
  "raw_material",
  "assembly",
];

function formString(formData: FormData, key: string) {
  const value = formData.get(key);

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const context = await requirePlanningContext(request);

  if (!context.configured) {
    return { configured: false as const, item: null };
  }

  return {
    configured: true as const,
    item: await loadItemDetail(context.pool, context.ctx, params.id!),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const context = await requirePlanningContext(request);

  if (!context.configured) {
    return { ok: false, message: "Database is not configured." };
  }

  const formData = await request.formData();
  const itemType = formString(formData, "itemType");

  if (!itemType || !itemTypes.includes(itemType as ItemType)) {
    return { ok: false, message: "Choose a valid item type." };
  }

  await updateItemClassification(context.pool, context.ctx, {
    itemId: params.id!,
    itemType: itemType as ItemType,
    unit: formString(formData, "unit") ?? "pcs",
    isSellable: formData.get("isSellable") === "on",
    isPurchasable: formData.get("isPurchasable") === "on",
    isProducible: formData.get("isProducible") === "on",
  });

  return redirect(`/app/items/${params.id}`);
};

export default function ItemDetail() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  if (!data.configured || !data.item) {
    return (
      <s-page heading="Item detail">
        <s-section heading="Connection">
          <s-paragraph>Database connection is not configured.</s-paragraph>
        </s-section>
      </s-page>
    );
  }

  const item = data.item;

  return (
    <s-page heading={item.sku ?? "Item detail"}>
      <s-section heading="Classification">
        <s-stack direction="block" gap="base">
          {actionData && "message" in actionData && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>{actionData.message}</s-paragraph>
            </s-box>
          )}
          <s-paragraph>
            Shopify variant: {shortReference(item.shopifyVariantId)}
          </s-paragraph>
          <s-paragraph>
            Available quantity: {formatQuantity(item.availableQuantity)}
          </s-paragraph>
          <Form method="post">
            <s-stack direction="block" gap="base">
              <label>
                Item type{" "}
                <select name="itemType" defaultValue={item.itemType}>
                  {itemTypes.map((itemType) => (
                    <option key={itemType} value={itemType}>
                      {formatStatus(itemType)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Unit <input name="unit" defaultValue={item.unit} />
              </label>
              <label>
                <input
                  type="checkbox"
                  name="isSellable"
                  defaultChecked={item.isSellable}
                />{" "}
                Sellable
              </label>
              <label>
                <input
                  type="checkbox"
                  name="isPurchasable"
                  defaultChecked={item.isPurchasable}
                />{" "}
                Purchasable
              </label>
              <label>
                <input
                  type="checkbox"
                  name="isProducible"
                  defaultChecked={item.isProducible}
                />{" "}
                Producible
              </label>
              <s-button
                type="submit"
                variant="primary"
                {...(isSubmitting ? { loading: true } : {})}
              >
                Save Classification
              </s-button>
            </s-stack>
          </Form>
        </s-stack>
      </s-section>

      <s-section heading="Planning usage">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            BOM parent: {item.canBeBomParent ? "Allowed" : "Requires producible item"}
          </s-paragraph>
          <s-paragraph>
            BOM component: {item.canBeComponent ? "Allowed" : "Review classification first"}
          </s-paragraph>
          {item.relatedBom ? (
            <s-paragraph>
              Related BOM:{" "}
              <s-link href={`/app/boms/${item.relatedBom.id}`}>
                {item.relatedBom.version} ·{" "}
                {item.relatedBom.is_active ? "Active" : "Inactive"}
              </s-link>
            </s-paragraph>
          ) : (
            <s-paragraph>No parent BOM is defined for this item.</s-paragraph>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Recent MRP lines">
        {item.mrpLines.length ? (
          <s-stack direction="block" gap="small">
            {item.mrpLines.map((line) => (
              <s-paragraph key={line.id}>
                <s-link href={`/app/mrp/${line.mrpRunId}`}>
                  {shortReference(line.mrpRunId)}
                </s-link>
                <s-text>
                  {" "}
                  · required {formatQuantity(line.requiredQuantity)}
                </s-text>
                <s-text>
                  {" "}
                  · shortage {formatQuantity(line.shortageQuantity)}
                </s-text>
                <s-text> · {formatAction(line.recommendedAction)}</s-text>
              </s-paragraph>
            ))}
          </s-stack>
        ) : (
          <s-paragraph>No MRP lines for this item yet.</s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}
