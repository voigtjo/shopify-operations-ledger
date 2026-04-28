import type { QueryExecutor } from "./foundation-db.server";
import {
  importShopifyOrder,
  runSupplyCheck,
  type ShopifyOrderImportInput,
  type TenantContext,
} from "./operational-core.server";

interface ShopifyAdminGraphqlClient {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<Response>;
}

interface ShopifyOrderLineNode {
  title: string;
  quantity: number;
  sku?: string | null;
  variant?: {
    id: string;
    sku?: string | null;
    product?: {
      id: string;
    } | null;
  } | null;
}

interface ShopifyOrderNode {
  id: string;
  name: string;
  createdAt?: string | null;
  lineItems: {
    nodes: ShopifyOrderLineNode[];
  };
}

interface ShopifyOrdersGraphqlResponse {
  data?: {
    orders?: {
      nodes: ShopifyOrderNode[];
    };
    node?: ShopifyOrderNode | null;
  };
  errors?: Array<{ message: string }>;
}

export interface RecentShopifyOrder {
  id: string;
  name: string;
  createdAt: string | null;
  lines: Array<{
    title: string;
    quantity: number;
    sku: string | null;
    shopifyProductId?: string | null;
    shopifyVariantId: string | null;
  }>;
}

const ORDER_FIELDS = `#graphql
  fragment OperationsLedgerOrderFields on Order {
    id
    name
    createdAt
    lineItems(first: 50) {
      nodes {
        title
        quantity
        sku
        variant {
          id
          sku
          product {
            id
          }
        }
      }
    }
  }
`;

function assertShopifyGraphqlResponse(response: ShopifyOrdersGraphqlResponse) {
  if (response.errors?.length) {
    throw new Error(
      `Shopify orders query failed: ${response.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
}

function normalizeShopifyOrder(node: ShopifyOrderNode): RecentShopifyOrder {
  return {
    id: node.id,
    name: node.name,
    createdAt: node.createdAt ?? null,
    lines: node.lineItems.nodes.map((line) => ({
      title: line.title,
      quantity: line.quantity,
      sku: line.variant?.sku ?? line.sku ?? null,
      shopifyProductId: line.variant?.product?.id ?? null,
      shopifyVariantId: line.variant?.id ?? null,
    })),
  };
}

export async function fetchRecentShopifyOrders(
  admin: ShopifyAdminGraphqlClient,
  first = 10,
) {
  const response = await admin.graphql(
    `${ORDER_FIELDS}
    query OperationsLedgerRecentOrders($first: Int!) {
      orders(first: $first, sortKey: CREATED_AT, reverse: true) {
        nodes {
          ...OperationsLedgerOrderFields
        }
      }
    }`,
    { variables: { first } },
  );
  const payload = (await response.json()) as ShopifyOrdersGraphqlResponse;

  assertShopifyGraphqlResponse(payload);

  return (payload.data?.orders?.nodes ?? []).map(normalizeShopifyOrder);
}

export async function fetchShopifyOrderById(
  admin: ShopifyAdminGraphqlClient,
  orderId: string,
) {
  const response = await admin.graphql(
    `${ORDER_FIELDS}
    query OperationsLedgerOrderById($id: ID!) {
      node(id: $id) {
        ... on Order {
          ...OperationsLedgerOrderFields
        }
      }
    }`,
    { variables: { id: orderId } },
  );
  const payload = (await response.json()) as ShopifyOrdersGraphqlResponse;

  assertShopifyGraphqlResponse(payload);

  if (!payload.data?.node) {
    throw new Error("Shopify order was not found");
  }

  return normalizeShopifyOrder(payload.data.node);
}

export function mapShopifyOrderToOperationsOrderInput(
  shopDomain: string,
  order: RecentShopifyOrder,
): ShopifyOrderImportInput {
  return {
    shopDomain,
    shopifyOrderId: order.id,
    shopifyOrderName: order.name,
    shopifyCreatedAt: order.createdAt,
    rawPayload: {
      source: "shopify_admin_graphql",
      orderId: order.id,
      orderName: order.name,
    },
    lines: order.lines
      .filter((line) => line.quantity > 0)
      .map((line) => ({
        shopifyVariantId: line.shopifyVariantId,
        shopifyProductId: line.shopifyProductId,
        sku: line.sku,
        title: line.title,
        quantity: line.quantity,
      })),
  };
}

export async function importShopifyOrderWithSupplyCheck(
  db: QueryExecutor,
  ctx: TenantContext,
  shopDomain: string,
  order: RecentShopifyOrder,
) {
  const importResult = await importShopifyOrder(
    db,
    mapShopifyOrderToOperationsOrderInput(shopDomain, order),
  );
  const supplyCheck = await runSupplyCheck(
    db,
    ctx,
    importResult.operationsOrderId,
  );

  return {
    importResult,
    supplyCheck,
  };
}
