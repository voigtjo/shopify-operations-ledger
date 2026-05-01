import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";

import {
  KpiCard,
  NextActionCard,
  PageIntro,
  StatusBadge,
  SummaryCard,
} from "../components/OperationsUi";
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
          <PageIntro>
            Operations Ledger turns Shopify demand into operational work:
            classify items, define BOMs, preview material demand, commit needs,
            assign suppliers, and create internal purchase orders.
          </PageIntro>
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
            <KpiCard label="Items" value={data.itemCount} href="/app/items" />
            <KpiCard
              label="Active BOMs"
              value={data.activeBomCount}
              href="/app/boms"
            />
            <KpiCard
              label="Latest MRP Run"
              value={
                data.latestMrpRun
                  ? formatStatus(data.latestMrpRun.status)
                  : "None"
              }
              href={
                data.latestMrpRun ? `/app/mrp/${data.latestMrpRun.id}` : "/app/mrp"
              }
            />
            <KpiCard
              label="Open Purchase Needs"
              value={data.openPurchaseNeedCount}
              href="/app/needs"
            />
            <KpiCard
              label="Needs Missing Supplier"
              value={data.missingSupplierPurchaseNeedCount}
              href="/app/needs?filter=open"
            />
            <KpiCard
              label="Ready for PO Draft"
              value={data.readyForPoDraftPurchaseNeedCount}
              href="/app/needs/po-draft"
            />
            <KpiCard
              label="Draft Purchase Orders"
              value={data.draftPurchaseOrderCount}
              href="/app/purchase-orders"
            />
            <KpiCard
              label="Sent/Acknowledged Purchase Orders"
              value={`${data.sentPurchaseOrderCount}/${data.acknowledgedPurchaseOrderCount}`}
              href="/app/purchase-orders"
            />
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Guided demo flow">
        <s-stack direction="block" gap="base">
          <PageIntro>
            Use this path to test the implemented spine without leaving the
            Shopify app.
          </PageIntro>
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
            <s-link href="/app/needs/po-draft">
              Step 6: Create Purchase Orders
            </s-link>
          </s-stack>
          {data.demoPreview ? (
            <SummaryCard heading="Latest Demo MRP Preview">
              <s-paragraph>
                {shortReference(data.demoPreview.mrpRunId)}{" "}
                <StatusBadge status={data.demoPreview.status} />
              </s-paragraph>
              <s-paragraph>
                Demo Kit shortage:{" "}
                {formatQuantity(data.demoPreview.parent.shortageQuantity)}
              </s-paragraph>
              <s-link href={`/app/mrp/${data.demoPreview.mrpRunId}`}>
                Open latest MRP run
              </s-link>
            </SummaryCard>
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
            <NextActionCard
              title="Start item setup"
              href="/app/items"
              actionLabel="Open Items"
            >
                Missing item classifications. Start with Demo Items or import
                Shopify variants.
            </NextActionCard>
          )}
          {data.hasDemoItems && !data.hasDemoBom && (
            <NextActionCard
              title="Create a BOM"
              href="/app/boms"
              actionLabel="Open BOMs"
            >
                Demo Kit exists but has no BOM. Create the BOM before running
                MRP.
            </NextActionCard>
          )}
          {data.missingSupplierPurchaseNeedCount > 0 && (
            <NextActionCard
              title="Assign suppliers"
              href="/app/needs?filter=open"
              actionLabel="Open missing supplier work"
            >
                {data.missingSupplierPurchaseNeedCount} purchase need
                {data.missingSupplierPurchaseNeedCount === 1 ? " needs" : "s need"} a
                supplier assignment.
            </NextActionCard>
          )}
          {data.preferredSupplierAvailablePurchaseNeedCount > 0 && (
            <NextActionCard
              title="Use preferred suppliers"
              href="/app/needs?filter=open"
              actionLabel="Assign preferred suppliers"
            >
                {data.preferredSupplierAvailablePurchaseNeedCount} purchase need
                {data.preferredSupplierAvailablePurchaseNeedCount === 1
                  ? " has"
                  : "s have"}{" "}
                a preferred supplier available.
            </NextActionCard>
          )}
          {data.readyForPoDraftPurchaseNeedCount > 0 && (
            <NextActionCard
              title="Create purchase orders"
              href="/app/needs/po-draft"
              actionLabel="Open PO Draft Preview"
            >
                {data.readyForPoDraftPurchaseNeedCount} purchase need
                {data.readyForPoDraftPurchaseNeedCount === 1 ? "" : "s"} ready
                for PO draft preview.
            </NextActionCard>
          )}
          {data.draftPurchaseOrderCount > 0 && (
            <NextActionCard
              title="Send draft purchase orders"
              href="/app/purchase-orders"
              actionLabel="Open Purchase Orders"
            >
                {data.draftPurchaseOrderCount} draft purchase order
                {data.draftPurchaseOrderCount === 1 ? "" : "s"} ready to send.
            </NextActionCard>
          )}
          {data.sentPurchaseOrderCount > 0 && (
            <NextActionCard
              title="Track supplier acknowledgement"
              href="/app/purchase-orders"
              actionLabel="Review sent purchase orders"
            >
                {data.sentPurchaseOrderCount} sent and{" "}
                {data.acknowledgedPurchaseOrderCount} acknowledged purchase
                orders.
            </NextActionCard>
          )}
          {data.openProductionNeedCount > 0 && (
            <NextActionCard
              title="Production needs waiting"
              href="/app/needs"
              actionLabel="Open Needs"
            >
                {data.openProductionNeedCount} production need
                {data.openProductionNeedCount === 1 ? "" : "s"} waiting.
            </NextActionCard>
          )}
          {data.configured &&
            data.hasDemoItems &&
            data.hasDemoBom &&
            data.openPurchaseNeedCount === 0 &&
            data.draftPurchaseOrderCount === 0 &&
            data.sentPurchaseOrderCount === 0 && (
              <SummaryCard heading="No urgent operational work">
                <s-paragraph>
                  Run an MRP Preview or review existing Items, BOMs, and
                  Purchase Orders.
                </s-paragraph>
              </SummaryCard>
            )}
        </s-stack>
      </s-section>
    </s-page>
  );
}
