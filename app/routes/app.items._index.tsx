import type { LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";

import { PlanningEmptyState } from "../components/PlanningEmptyState";
import { requirePlanningContext } from "../lib/app-context.server";
import {
  getAvailableQuantity,
  loadItemList,
  type ItemType,
} from "../lib/material-planning.server";
import { formatQuantity, formatStatus, shortReference } from "../lib/ui-format";

const itemTypes: Array<ItemType | "all"> = [
  "all",
  "product",
  "component",
  "raw_material",
  "assembly",
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const context = await requirePlanningContext(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
  const type = (url.searchParams.get("type") ?? "all") as ItemType | "all";

  if (!context.configured) {
    return { configured: false as const, items: [], query, type };
  }

  const allItems = await loadItemList(context.pool, context.ctx, { limit: 200 });
  const filteredItems = allItems.filter((item) => {
    const matchesQuery =
      !query ||
      item.sku?.toLowerCase().includes(query) ||
      item.shopifyVariantId.toLowerCase().includes(query);
    const matchesType = type === "all" || item.itemType === type;

    return matchesQuery && matchesType;
  });
  const items = await Promise.all(
    filteredItems.map(async (item) => ({
      ...item,
      availableQuantity: await getAvailableQuantity(
        context.pool,
        context.ctx,
        item.id,
      ),
    })),
  );

  return { configured: true as const, items, query, type };
};

export default function ItemsIndex() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading="Items & Materials">
      <s-section heading="Item catalog">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Shopify variants remain the product source of record. Operations
            Ledger adds operational classification for planning.
          </s-paragraph>
          <Form method="get">
            <s-stack direction="inline" gap="small">
              <label>
                Search{" "}
                <input
                  name="q"
                  defaultValue={data.query}
                  placeholder="SKU or variant"
                />
              </label>
              <label>
                Type{" "}
                <select name="type" defaultValue={data.type}>
                  {itemTypes.map((itemType) => (
                    <option key={itemType} value={itemType}>
                      {formatStatus(itemType)}
                    </option>
                  ))}
                </select>
              </label>
              <s-button type="submit" variant="secondary">
                Filter
              </s-button>
            </s-stack>
          </Form>
          {!data.configured && (
            <PlanningEmptyState>
              Database connection is not configured.
            </PlanningEmptyState>
          )}
          {data.configured && data.items.length === 0 && (
            <PlanningEmptyState>
              No items match the current filters.
            </PlanningEmptyState>
          )}
          {data.items.map((item) => (
            <s-box
              key={item.id}
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-stack direction="block" gap="small">
                <s-paragraph>
                  <s-link href={`/app/items/${item.id}`}>
                    {item.sku ?? "No SKU"}
                  </s-link>
                  <s-text> · {formatStatus(item.itemType)}</s-text>
                  <s-text> · available {formatQuantity(item.availableQuantity)}</s-text>
                </s-paragraph>
                <s-paragraph>
                  <s-text>{shortReference(item.shopifyVariantId)}</s-text>
                  <s-text>
                    {" "}
                    · {item.isSellable ? "Sellable" : "Not sellable"}
                  </s-text>
                  <s-text>
                    {" "}
                    · {item.isPurchasable ? "Purchasable" : "Not purchasable"}
                  </s-text>
                  <s-text>
                    {" "}
                    · {item.isProducible ? "Producible" : "Not producible"}
                  </s-text>
                </s-paragraph>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}
