import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { requirePlanningContext } from "../lib/app-context.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const context = await requirePlanningContext(request);

  return {
    configured: context.configured,
    shopDomain: context.shopDomain,
    tenantId: context.ctx?.tenantId ?? null,
  };
};

export default function Settings() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading="Settings">
      <s-section heading="About this MVP">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Operations Ledger currently supports item classification, BOMs, MRP
            Preview, and explicit commit into purchase and production needs.
          </s-paragraph>
          <s-paragraph>
            Shopify remains the system of record for products, variants, orders,
            inventory records, customers, and fulfillment objects.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Intentionally not implemented yet">
        <s-unordered-list>
          <s-list-item>Purchase Orders</s-list-item>
          <s-list-item>Production Orders</s-list-item>
          <s-list-item>Goods Receipt and QC</s-list-item>
          <s-list-item>Warehouse Tasks</s-list-item>
          <s-list-item>Shopify fulfillment writeback</s-list-item>
          <s-list-item>File evidence</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Connection status">
        <s-stack direction="block" gap="base">
          <s-paragraph>Shop: {data.shopDomain}</s-paragraph>
          <s-paragraph>
            Database: {data.configured ? "Reachable" : "Not configured"}
          </s-paragraph>
          <s-paragraph>
            Tenant: {data.tenantId ?? "Not available for this run"}
          </s-paragraph>
          <s-paragraph>Shopify session: Available</s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}
