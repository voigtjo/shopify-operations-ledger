import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";

import { PlanningEmptyState } from "../components/PlanningEmptyState";
import { requirePlanningContext } from "../lib/app-context.server";
import {
  commitMrpRunNeeds,
  createDemoKitBom,
  createDemoKitItems,
  loadBomList,
  loadItemList,
  loadLatestDemoKitMrpPreview,
  loadMrpRunList,
  loadNeedsBoard,
  runDemoKitMrpPreview,
} from "../lib/material-planning.server";
import { loadPurchaseNeedsSummary } from "../lib/purchase-needs.server";
import { loadPurchaseOrderDashboardSummary } from "../lib/purchase-orders.server";
import { formatQuantity, formatStatus, shortReference } from "../lib/ui-format";

type ActionResult = {
  ok: boolean;
  message: string;
};

function formString(formData: FormData, key: string) {
  const value = formData.get(key);

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const context = await requirePlanningContext(request);

  if (!context.configured) {
    return {
      configured: false as const,
      shopDomain: context.shopDomain,
      itemCount: 0,
      activeBomCount: 0,
      latestMrpRun: null,
      openPurchaseNeedCount: 0,
      missingSupplierPurchaseNeedCount: 0,
      preferredSupplierAvailablePurchaseNeedCount: 0,
      readyForPoDraftPurchaseNeedCount: 0,
      draftPurchaseOrderCount: 0,
      sentPurchaseOrderCount: 0,
      acknowledgedPurchaseOrderCount: 0,
      openProductionNeedCount: 0,
      demoPreview: null,
      hasDemoItems: false,
      hasDemoBom: false,
    };
  }

  const [
    items,
    boms,
    runs,
    needs,
    purchaseNeedSummary,
    purchaseOrderSummary,
    demoPreview,
  ] =
    await Promise.all([
      loadItemList(context.pool, context.ctx, { limit: 200 }),
      loadBomList(context.pool, context.ctx),
      loadMrpRunList(context.pool, context.ctx, { limit: 1 }),
      loadNeedsBoard(context.pool, context.ctx),
      loadPurchaseNeedsSummary(context.pool, context.ctx),
      loadPurchaseOrderDashboardSummary(context.pool, context.ctx),
      loadLatestDemoKitMrpPreview(context.pool, context.ctx),
    ]);

  return {
    configured: true as const,
    shopDomain: context.shopDomain,
    itemCount: items.length,
    activeBomCount: boms.filter((bom) => bom.isActive).length,
    latestMrpRun: runs[0] ?? null,
    openPurchaseNeedCount: purchaseNeedSummary.openPurchaseNeeds,
    missingSupplierPurchaseNeedCount:
      purchaseNeedSummary.missingSupplierPurchaseNeeds,
    preferredSupplierAvailablePurchaseNeedCount:
      purchaseNeedSummary.preferredSupplierAvailablePurchaseNeeds,
    readyForPoDraftPurchaseNeedCount:
      purchaseNeedSummary.readyForPoDraftPurchaseNeeds,
    draftPurchaseOrderCount: purchaseOrderSummary.draftPurchaseOrders,
    sentPurchaseOrderCount: purchaseOrderSummary.sentPurchaseOrders,
    acknowledgedPurchaseOrderCount:
      purchaseOrderSummary.acknowledgedPurchaseOrders,
    openProductionNeedCount: needs.productionNeeds.filter((need) =>
      ["pending", "PENDING"].includes(need.status),
    ).length,
    demoPreview,
    hasDemoItems: items.some((item) => item.sku === "DEMO-KIT"),
    hasDemoBom: boms.some((bom) => bom.parentSku === "DEMO-KIT"),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const context = await requirePlanningContext(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (!context.configured) {
    return {
      ok: false,
      message:
        "Operations Ledger database is not configured. Set OPERATIONS_LEDGER_DATABASE_URL and restart the app.",
    } satisfies ActionResult;
  }

  if (intent === "create-demo-kit-items") {
    const result = await createDemoKitItems(context.pool, context.ctx);

    return {
      ok: true,
      message: `Demo items are ready (${result.count} items).`,
    } satisfies ActionResult;
  }

  if (intent === "create-demo-kit-bom") {
    await createDemoKitBom(context.pool, context.ctx);

    return {
      ok: true,
      message: "Demo Kit BOM is ready.",
    } satisfies ActionResult;
  }

  if (intent === "run-mrp-preview") {
    const preview = await runDemoKitMrpPreview(context.pool, context.ctx, 1);

    return {
      ok: Boolean(preview),
      message: preview
        ? "MRP Preview saved for 1 Demo Kit."
        : "Create demo items and BOM before running MRP Preview.",
    } satisfies ActionResult;
  }

  if (intent === "commit-mrp-needs") {
    const mrpRunId = formString(formData, "mrpRunId");

    if (!mrpRunId) {
      return {
        ok: false,
        message: "Run an MRP Preview before committing needs.",
      } satisfies ActionResult;
    }

    const result = await commitMrpRunNeeds(context.pool, context.ctx, {
      mrpRunId,
    });

    return {
      ok: true,
      message: `Committed needs: ${result.purchaseNeeds.length} purchase, ${result.productionNeeds.length} production.`,
    } satisfies ActionResult;
  }

  return {
    ok: false,
    message: "Unknown dashboard action.",
  } satisfies ActionResult;
};

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  return (
    <s-page heading="Operations Ledger">
      <s-section heading="Operational cockpit">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Operations Ledger turns Shopify demand into operational work:
            classified materials, BOMs, MRP previews, and committed purchase or
            production needs.
          </s-paragraph>
          {!data.configured && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>
                Database connection is not configured for this app run.
              </s-paragraph>
            </s-box>
          )}
          {actionData && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>{actionData.message}</s-paragraph>
            </s-box>
          )}
          <s-stack direction="inline" gap="base">
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-heading>{data.itemCount}</s-heading>
              <s-paragraph>Total items</s-paragraph>
            </s-box>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-heading>{data.activeBomCount}</s-heading>
              <s-paragraph>Active BOMs</s-paragraph>
            </s-box>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-heading>
                {data.latestMrpRun
                  ? formatStatus(data.latestMrpRun.status)
                  : "None"}
              </s-heading>
              <s-paragraph>Latest MRP run</s-paragraph>
            </s-box>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-heading>{data.openPurchaseNeedCount}</s-heading>
              <s-paragraph>Open purchase needs</s-paragraph>
            </s-box>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-heading>{data.openProductionNeedCount}</s-heading>
              <s-paragraph>Open production needs</s-paragraph>
            </s-box>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-heading>{data.draftPurchaseOrderCount}</s-heading>
              <s-paragraph>Draft purchase orders</s-paragraph>
            </s-box>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-heading>{data.sentPurchaseOrderCount}</s-heading>
              <s-paragraph>Sent purchase orders</s-paragraph>
            </s-box>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Guided demo flow">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Use this path to test the implemented spine without leaving the
            Shopify app.
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <Form method="post">
              <input
                type="hidden"
                name="intent"
                value="create-demo-kit-items"
              />
              <s-button
                type="submit"
                variant={data.hasDemoItems ? "secondary" : "primary"}
                disabled={!data.configured}
                {...(isSubmitting ? { loading: true } : {})}
              >
                Step 1: Create Demo Items
              </s-button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="create-demo-kit-bom" />
              <s-button
                type="submit"
                variant={data.hasDemoBom ? "secondary" : "primary"}
                disabled={!data.configured}
                {...(isSubmitting ? { loading: true } : {})}
              >
                Step 2: Create Demo BOM
              </s-button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="run-mrp-preview" />
              <s-button
                type="submit"
                variant="primary"
                disabled={!data.configured || !data.hasDemoBom}
                {...(isSubmitting ? { loading: true } : {})}
              >
                Step 3: Run MRP Preview
              </s-button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="commit-mrp-needs" />
              <input
                type="hidden"
                name="mrpRunId"
                value={data.demoPreview?.mrpRunId ?? ""}
              />
              <s-button
                type="submit"
                variant="primary"
                disabled={!data.configured || !data.demoPreview?.mrpRunId}
                {...(isSubmitting ? { loading: true } : {})}
              >
                Step 4: Commit Needs
              </s-button>
            </Form>
            <s-link href="/app/needs">Step 5: Review Needs</s-link>
          </s-stack>
          {data.demoPreview ? (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>
                Latest preview {shortReference(data.demoPreview.mrpRunId)} ·{" "}
                {formatStatus(data.demoPreview.status)}
              </s-paragraph>
              <s-paragraph>
                Demo Kit shortage:{" "}
                {formatQuantity(data.demoPreview.parent.shortageQuantity)}
              </s-paragraph>
            </s-box>
          ) : (
            <PlanningEmptyState>
              No MRP Preview has been run for the Demo Kit yet.
            </PlanningEmptyState>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Next work">
        <s-stack direction="block" gap="base">
          {!data.hasDemoItems && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>
                Missing item classifications. Start with Demo Items or import
                Shopify variants.
              </s-paragraph>
            </s-box>
          )}
          {data.hasDemoItems && !data.hasDemoBom && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>
                Demo Kit exists but has no BOM. Create the BOM before running
                MRP.
              </s-paragraph>
            </s-box>
          )}
          {data.openPurchaseNeedCount > 0 && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>
                {data.openPurchaseNeedCount} purchase need
                {data.openPurchaseNeedCount === 1 ? "" : "s"} waiting.
              </s-paragraph>
              <s-link href="/app/needs">Open Purchase Needs board</s-link>
            </s-box>
          )}
          {data.missingSupplierPurchaseNeedCount > 0 && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>
                {data.missingSupplierPurchaseNeedCount} purchase need
                {data.missingSupplierPurchaseNeedCount === 1 ? "" : "s"} need
                {data.missingSupplierPurchaseNeedCount === 1 ? "s" : ""} a
                supplier assignment.
              </s-paragraph>
              <s-link href="/app/needs?filter=open">Assign suppliers</s-link>
            </s-box>
          )}
          {data.preferredSupplierAvailablePurchaseNeedCount > 0 && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>
                {data.preferredSupplierAvailablePurchaseNeedCount} purchase need
                {data.preferredSupplierAvailablePurchaseNeedCount === 1
                  ? " has"
                  : "s have"}{" "}
                a preferred supplier available.
              </s-paragraph>
              <s-link href="/app/needs?filter=open">
                Assign preferred suppliers
              </s-link>
            </s-box>
          )}
          {data.readyForPoDraftPurchaseNeedCount > 0 && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>
                {data.readyForPoDraftPurchaseNeedCount} purchase need
                {data.readyForPoDraftPurchaseNeedCount === 1 ? "" : "s"} ready
                for PO draft preview.
              </s-paragraph>
              <s-link href="/app/needs/po-draft">Prepare PO Draft</s-link>
            </s-box>
          )}
          {data.draftPurchaseOrderCount > 0 && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>
                {data.draftPurchaseOrderCount} draft purchase order
                {data.draftPurchaseOrderCount === 1 ? "" : "s"} ready to send.
              </s-paragraph>
              <s-link href="/app/purchase-orders">Open Purchase Orders</s-link>
            </s-box>
          )}
          {data.sentPurchaseOrderCount + data.acknowledgedPurchaseOrderCount >
            0 && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>
                {data.sentPurchaseOrderCount} sent and{" "}
                {data.acknowledgedPurchaseOrderCount} acknowledged purchase
                orders.
              </s-paragraph>
              <s-link href="/app/purchase-orders">Review Purchase Orders</s-link>
            </s-box>
          )}
          {data.openProductionNeedCount > 0 && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>
                {data.openProductionNeedCount} production need
                {data.openProductionNeedCount === 1 ? "" : "s"} waiting.
              </s-paragraph>
              <s-link href="/app/needs">Open Needs</s-link>
            </s-box>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}
