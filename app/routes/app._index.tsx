import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";

import {
  dashboardFlowStages,
  getDashboardNextAction,
} from "../lib/dashboard-presentation";
import { getFoundationDatabasePool } from "../lib/foundation-db.server";
import {
  buildDemoShopifyOrderPayload,
  createPurchaseOrderFromNeeds,
  createSupplier,
  getTenantContextByShopDomain,
  importShopifyOrder,
  postGoodsReceipt,
  runSupplyCheck,
  sendPurchaseOrder,
} from "../lib/operational-core.server";
import { loadDashboardForShop } from "../lib/operations-dashboard.server";
import {
  PgTenantBootstrapStore,
  bootstrapTenantFromShopifySession,
} from "../lib/tenant-bootstrap.server";
import { authenticate } from "../shopify.server";

type ActionResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

function formString(formData: FormData, key: string) {
  const value = formData.get(key);

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function getRemainingReceiptLines(
  pool: ReturnType<typeof getFoundationDatabasePool>,
  tenantId: string,
  purchaseOrderId: string,
) {
  if (!pool) {
    return [];
  }

  const linesResult = await pool.query<{
    id: string;
    quantity_remaining: string;
  }>(
    `
      select id, (quantity_ordered - quantity_received)::text as quantity_remaining
      from public.purchase_order_lines
      where tenant_id = $1
        and purchase_order_id = $2
        and quantity_received < quantity_ordered
      order by created_at asc
    `,
    [tenantId, purchaseOrderId],
  );

  return linesResult.rows.map((line) => ({
    purchaseOrderLineId: line.id,
    quantityReceived: Number(line.quantity_remaining),
  }));
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  return loadDashboardForShop({
    shopDomain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const pool = getFoundationDatabasePool();

  if (!pool) {
    return {
      ok: false,
      message:
        "Operations Ledger database is not configured. Set OPERATIONS_LEDGER_DATABASE_URL for local verification.",
    } satisfies ActionResult;
  }

  if (!session.accessToken) {
    throw new Error("Shopify session did not include an access token");
  }

  await bootstrapTenantFromShopifySession(new PgTenantBootstrapStore(pool), {
    shopDomain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope ?? "",
  });

  const ctx = await getTenantContextByShopDomain(pool, session.shop);
  const demoOrder = buildDemoShopifyOrderPayload(session.shop);

  if (intent === "create-demo-order") {
    const result = await importShopifyOrder(pool, demoOrder);

    return {
      ok: true,
      message: result.alreadyImported
        ? "Demo Operations Order already exists."
        : "Demo Operations Order created.",
    } satisfies ActionResult;
  }

  if (intent === "run-demo-supply-check") {
    const imported = await importShopifyOrder(pool, demoOrder);
    const result = await runSupplyCheck(pool, ctx, imported.operationsOrderId);

    return {
      ok: true,
      message: `Demo Supply Check completed: ${result.status}.`,
    } satisfies ActionResult;
  }

  if (intent === "create-demo-purchase-order") {
    const purchaseNeedId = formString(formData, "purchaseNeedId");

    if (!purchaseNeedId) {
      return {
        ok: false,
        message: "Select a purchase need before creating a demo Purchase Order.",
      } satisfies ActionResult;
    }

    const supplier = await createSupplier(pool, ctx, {
      name: "Development Demo Supplier",
      email: "supplier@example.com",
      externalRef: "development-demo-supplier",
    });
    const purchaseOrder = await createPurchaseOrderFromNeeds(pool, ctx, {
      supplierId: supplier.supplierId,
      purchaseNeedIds: [purchaseNeedId],
      currency: demoOrder.currency,
      notes: "Created by Operations Ledger development dashboard action.",
      idempotencyKey: `demo:create_purchase_order:${purchaseNeedId}`,
    });

    return {
      ok: true,
      message: purchaseOrder.alreadyCreated
        ? "Purchase order already exists for this need."
        : "Demo Purchase Order created.",
    } satisfies ActionResult;
  }

  if (intent === "send-demo-purchase-order") {
    const purchaseOrderId = formString(formData, "purchaseOrderId");

    if (!purchaseOrderId) {
      return {
        ok: false,
        message: "Select a Purchase Order before sending.",
      } satisfies ActionResult;
    }

    const result = await sendPurchaseOrder(pool, ctx, purchaseOrderId);

    return {
      ok: true,
      message: result.alreadySent
        ? "Purchase order was already sent."
        : "Demo Purchase Order sent.",
    } satisfies ActionResult;
  }

  if (intent === "post-demo-goods-receipt") {
    const purchaseOrderId = formString(formData, "purchaseOrderId");

    if (!purchaseOrderId) {
      return {
        ok: false,
        message: "Select a Purchase Order before posting goods receipt.",
      } satisfies ActionResult;
    }

    const lines = await getRemainingReceiptLines(
      pool,
      ctx.tenantId,
      purchaseOrderId,
    );

    if (lines.length === 0) {
      return {
        ok: false,
        message: "No remaining Purchase Order quantity is available to receive.",
      } satisfies ActionResult;
    }

    const result = await postGoodsReceipt(pool, ctx, {
      purchaseOrderId,
      notes: "Posted by Operations Ledger development dashboard action.",
      idempotencyKey: `demo:post_goods_receipt:${purchaseOrderId}`,
      lines,
    });

    return {
      ok: true,
      message: result.alreadyPosted
        ? "Goods receipt already posted."
        : `Demo Goods Receipt posted: ${result.purchaseOrderStatus}.`,
    } satisfies ActionResult;
  }

  return {
    ok: false,
    message: "Unknown Operations Ledger action.",
  } satisfies ActionResult;
};

function formatQuantity(value: number) {
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 4,
  }).format(value);
}

function remainingNeedQuantity(input: {
  quantityNeeded: number;
  quantityCovered: number;
}) {
  return Math.max(input.quantityNeeded - input.quantityCovered, 0);
}

function EmptyState({ children }: { children: string }) {
  return <s-paragraph>{children}</s-paragraph>;
}

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";
  const nextAction = getDashboardNextAction(data.dashboard);
  const activeFlowStage = dashboardFlowStages.findIndex((stage) =>
    nextAction.stage === "ORDER"
      ? stage === "Order"
      : nextAction.stage === "SUPPLY_CHECK"
        ? stage === "Supply Check"
        : nextAction.stage === "PURCHASE_NEED"
          ? stage === "Purchase Need"
          : nextAction.stage === "PURCHASE_ORDER"
            ? stage === "Purchase Order"
            : nextAction.stage === "GOODS_RECEIPT"
              ? stage === "Goods Receipt"
              : stage === "Inventory Updated",
  );

  return (
    <s-page heading="Operations Ledger">
      <s-section heading="Tenant status">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text>Shop: </s-text>
            <s-text>{data.shopDomain}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text>Operations database: </s-text>
            <s-text>
              {data.configured ? "Connected" : "Not configured for this run"}
            </s-text>
          </s-paragraph>
          {data.dashboard && (
            <s-paragraph>
              <s-text>Tenant: </s-text>
              <s-text>{data.dashboard.tenant.status}</s-text>
            </s-paragraph>
          )}
          {!data.configured && (
            <s-paragraph>
              Set <code>OPERATIONS_LEDGER_DATABASE_URL</code> and{" "}
              <code>OPERATIONS_LEDGER_TOKEN_ENCRYPTION_KEY</code>, then restart{" "}
              <code>npm run dev</code>.
            </s-paragraph>
          )}
          {actionData && (
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <s-paragraph>{actionData.message}</s-paragraph>
            </s-box>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Next action">
        <s-stack direction="block" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>{nextAction.message}</s-heading>
          </s-box>
          <s-stack direction="inline" gap="small">
            {dashboardFlowStages.map((stage, index) => (
              <s-box
                key={stage}
                padding="small"
                borderWidth="base"
                borderRadius="base"
                {...(index === activeFlowStage ? { background: "subdued" } : {})}
              >
                <s-paragraph>
                  <s-text>{index < activeFlowStage ? "Done: " : ""}</s-text>
                  <s-text>{stage}</s-text>
                </s-paragraph>
              </s-box>
            ))}
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Demo actions">
        <s-stack direction="inline" gap="base">
          <Form method="post">
            <input type="hidden" name="intent" value="create-demo-order" />
            <s-button
              type="submit"
              {...(isSubmitting ? { loading: true } : {})}
              disabled={!data.configured}
            >
              Demo: Create Operations Order
            </s-button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="run-demo-supply-check" />
            <s-button
              type="submit"
              variant="secondary"
              {...(isSubmitting ? { loading: true } : {})}
              disabled={!data.configured}
            >
              Demo: Run Supply Check
            </s-button>
          </Form>
        </s-stack>
      </s-section>

      <s-section heading="Counts">
        <s-stack direction="inline" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>
              {data.dashboard?.counts.operationsOrders ?? 0}
            </s-heading>
            <s-paragraph>Operations Orders</s-paragraph>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>{data.dashboard?.counts.purchaseNeeds ?? 0}</s-heading>
            <s-paragraph>Purchase Needs</s-paragraph>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>{data.dashboard?.counts.purchaseOrders ?? 0}</s-heading>
            <s-paragraph>Purchase Orders</s-paragraph>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>{data.dashboard?.counts.goodsReceipts ?? 0}</s-heading>
            <s-paragraph>Goods Receipts</s-paragraph>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>
              {data.dashboard?.counts.inventoryMovements ?? 0}
            </s-heading>
            <s-paragraph>Inventory Movements</s-paragraph>
          </s-box>
        </s-stack>
      </s-section>

      <s-section heading="Operations Orders">
        {data.dashboard?.operationsOrders.length ? (
          <s-stack direction="block" gap="base">
            {data.dashboard.operationsOrders.map((order) => (
              <s-box
                key={order.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-paragraph>
                  <s-text>{order.orderNumber ?? order.id}</s-text>
                  <s-text> · {order.status}</s-text>
                  <s-text> · {order.originType}</s-text>
                </s-paragraph>
              </s-box>
            ))}
          </s-stack>
        ) : (
          <EmptyState>No Operations Orders yet.</EmptyState>
        )}
      </s-section>

      <s-section heading="Purchase Needs">
        {data.dashboard?.purchaseNeeds.length ? (
          <s-stack direction="block" gap="base">
            {data.dashboard.purchaseNeeds.map((need) => (
              <s-box
                key={need.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-paragraph>
                  <s-text>{need.sku ?? need.title}</s-text>
                  <s-text> · {need.status}</s-text>
                </s-paragraph>
                <s-paragraph>
                  <s-text>Required: {formatQuantity(need.quantityRequired)}</s-text>
                  <s-text>
                    {" "}
                    · Reserved/available: {formatQuantity(need.quantityReserved)}
                  </s-text>
                  <s-text>
                    {" "}
                    · Missing: {formatQuantity(remainingNeedQuantity(need))}
                  </s-text>
                </s-paragraph>
                <s-paragraph>
                  <s-text>
                    Supplier: {need.supplierName ?? "Development Demo Supplier"}
                  </s-text>
                  {need.operationsOrderNumber && (
                    <s-text> · Order {need.operationsOrderNumber}</s-text>
                  )}
                </s-paragraph>
                {need.status === "OPEN" && (
                  <Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="create-demo-purchase-order"
                    />
                    <input
                      type="hidden"
                      name="purchaseNeedId"
                      value={need.id}
                    />
                    <s-button
                      type="submit"
                      variant="secondary"
                      {...(isSubmitting ? { loading: true } : {})}
                    >
                      Demo: Create Purchase Order
                    </s-button>
                  </Form>
                )}
              </s-box>
            ))}
          </s-stack>
        ) : (
          <EmptyState>No Purchase Needs yet.</EmptyState>
        )}
      </s-section>

      <s-section heading="Purchase Orders">
        {data.dashboard?.purchaseOrders.length ? (
          <s-stack direction="block" gap="base">
            {data.dashboard.purchaseOrders.map((purchaseOrder) => (
              <s-box
                key={purchaseOrder.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small">
                  <s-paragraph>
                    <s-text>{purchaseOrder.poNumber ?? purchaseOrder.id}</s-text>
                    <s-text> · {purchaseOrder.status}</s-text>
                    <s-text> · {purchaseOrder.supplierName}</s-text>
                    {purchaseOrder.currency && (
                      <s-text> · {purchaseOrder.currency}</s-text>
                    )}
                  </s-paragraph>
                  <s-paragraph>
                    <s-text>
                      Related need:{" "}
                      {purchaseOrder.relatedNeedTitle ?? "Demo purchase need"}
                    </s-text>
                    {purchaseOrder.relatedOrderNumber && (
                      <s-text> · Order {purchaseOrder.relatedOrderNumber}</s-text>
                    )}
                    <s-text> · Lines: {purchaseOrder.lineCount}</s-text>
                  </s-paragraph>
                  {purchaseOrder.status === "DRAFT" && (
                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value="send-demo-purchase-order"
                      />
                      <input
                        type="hidden"
                        name="purchaseOrderId"
                        value={purchaseOrder.id}
                      />
                      <s-button
                        type="submit"
                        variant="secondary"
                        {...(isSubmitting ? { loading: true } : {})}
                      >
                        Demo: Send Purchase Order
                      </s-button>
                    </Form>
                  )}
                  {["SENT", "PARTIALLY_RECEIVED"].includes(
                    purchaseOrder.status,
                  ) && (
                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value="post-demo-goods-receipt"
                      />
                      <input
                        type="hidden"
                        name="purchaseOrderId"
                        value={purchaseOrder.id}
                      />
                      <s-button
                        type="submit"
                        variant="secondary"
                        {...(isSubmitting ? { loading: true } : {})}
                      >
                        Demo: Post Goods Receipt
                      </s-button>
                    </Form>
                  )}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        ) : (
          <EmptyState>No Purchase Orders yet.</EmptyState>
        )}
      </s-section>

      <s-section heading="Goods Receipts">
        {data.dashboard?.goodsReceipts.length ? (
          <s-stack direction="block" gap="base">
            {data.dashboard.goodsReceipts.map((receipt) => (
              <s-box
                key={receipt.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-paragraph>
                  <s-text>{receipt.receiptNumber ?? receipt.id}</s-text>
                  <s-text> · {receipt.status}</s-text>
                  <s-text> · PO {receipt.poNumber ?? receipt.purchaseOrderId}</s-text>
                </s-paragraph>
                <s-paragraph>
                  <s-text>{receipt.sku ?? receipt.title ?? "Received item"}</s-text>
                  <s-text>
                    {" "}
                    · received {formatQuantity(receipt.quantityReceived)}
                  </s-text>
                  {receipt.movementType && (
                    <s-text> · movement {receipt.movementType}</s-text>
                  )}
                </s-paragraph>
              </s-box>
            ))}
          </s-stack>
        ) : (
          <EmptyState>No Goods Receipts yet.</EmptyState>
        )}
      </s-section>

      <s-section heading="Inventory Movements">
        {data.dashboard?.inventoryMovements.length ? (
          <s-stack direction="block" gap="base">
            {data.dashboard.inventoryMovements.map((movement) => (
              <s-box
                key={movement.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-paragraph>
                  <s-text>{movement.sku ?? movement.title ?? movement.id}</s-text>
                  <s-text> · {movement.movementType}</s-text>
                  <s-text> · source {movement.sourceType}</s-text>
                  <s-text>
                    {" "}
                    · qty {formatQuantity(movement.quantityDelta)}, reserved{" "}
                    {formatQuantity(movement.reservationDelta)}
                  </s-text>
                </s-paragraph>
              </s-box>
            ))}
          </s-stack>
        ) : (
          <EmptyState>No Inventory Movements yet.</EmptyState>
        )}
      </s-section>
    </s-page>
  );
}
