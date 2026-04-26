import { describe, expect, it } from "vitest";

import { buildDemoShopifyOrderPayload } from "../../app/lib/operational-core.server";

describe("demo Shopify order payload", () => {
  it("is deterministic and safe to import repeatedly for a shop", () => {
    const first = buildDemoShopifyOrderPayload("Example-Shop.myshopify.com");
    const second = buildDemoShopifyOrderPayload("example-shop.myshopify.com");

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      shopDomain: "example-shop.myshopify.com",
      shopifyOrderId: "demo-core-order:example-shop.myshopify.com",
      shopifyOrderName: "DEV-OPS-1001",
      lines: [
        {
          sku: "OPS-KIT-DEMO",
          title: "Operations Demo Kit",
          quantity: 3,
        },
      ],
    });
  });
});
