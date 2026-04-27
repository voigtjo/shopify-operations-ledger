import { describe, expect, it } from "vitest";

import { mapShopifyOrderToOperationsOrderInput } from "../../app/lib/shopify-orders.server";

describe("Shopify order mapping", () => {
  it("maps Shopify Admin GraphQL orders into Operations Order import input", () => {
    const input = mapShopifyOrderToOperationsOrderInput(
      "operations-ledger-dev.myshopify.com",
      {
        id: "gid://shopify/Order/1001",
        name: "#1001",
        createdAt: "2026-04-26T10:00:00Z",
        lines: [
          {
            title: "Operations Kit",
            quantity: 2,
            sku: "OPS-KIT",
            shopifyVariantId: "gid://shopify/ProductVariant/2001",
          },
          {
            title: "Zero Quantity Line",
            quantity: 0,
            sku: "ZERO",
            shopifyVariantId: "gid://shopify/ProductVariant/2002",
          },
        ],
      },
    );

    expect(input).toMatchObject({
      shopDomain: "operations-ledger-dev.myshopify.com",
      shopifyOrderId: "gid://shopify/Order/1001",
      shopifyOrderName: "#1001",
      shopifyCreatedAt: "2026-04-26T10:00:00Z",
      lines: [
        {
          title: "Operations Kit",
          quantity: 2,
          sku: "OPS-KIT",
          shopifyVariantId: "gid://shopify/ProductVariant/2001",
        },
      ],
    });
  });
});
