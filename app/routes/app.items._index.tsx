import type { LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";

import { PageIntro, StatusBadge, SummaryCard } from "../components/OperationsUi";
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
          <PageIntro>
            Shopify variants remain the product source of record. Operations
            Ledger adds operational classification for BOM, MRP, purchasing,
            and production planning.
          </PageIntro>
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
            <SummaryCard
              key={item.id}
              heading={item.sku ?? "No SKU"}
            >
              <s-paragraph>
                <StatusBadge status={item.itemType} /> Available{" "}
                {formatQuantity(item.availableQuantity)}
              </s-paragraph>
              <s-paragraph>
                Shopify variant: {shortReference(item.shopifyVariantId)}
              </s-paragraph>
              <s-paragraph>
                {item.isSellable ? "Sellable" : "Not sellable"} -{" "}
                {item.isPurchasable ? "Purchasable" : "Not purchasable"} -{" "}
                {item.isProducible ? "Producible" : "Not producible"}
              </s-paragraph>
              <s-link href={`/app/items/${item.id}`}>
                Review classification
              </s-link>
            </SummaryCard>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}
