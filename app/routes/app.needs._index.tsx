import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";

import { PlanningEmptyState } from "../components/PlanningEmptyState";
import { requirePlanningContext } from "../lib/app-context.server";
import {
  assignPreferredSupplierToPurchaseNeed,
  assignSupplierToPurchaseNeed,
  createSupplier,
  listPurchaseNeedsBoard,
  listSuppliers,
  markPurchaseNeedReadyForPo,
  type PurchaseNeedsBoardFilter,
} from "../lib/purchase-needs.server";
import { formatQuantity, formatStatus, shortReference } from "../lib/ui-format";

type ActionResult = {
  ok: boolean;
  message: string;
};

const filters: Array<{ value: PurchaseNeedsBoardFilter; label: string }> = [
  { value: "open", label: "Open" },
  { value: "assigned", label: "Assigned" },
  { value: "ready_for_po", label: "Ready for PO" },
  { value: "all", label: "All" },
];

function formString(formData: FormData, key: string) {
  const value = formData.get(key);

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseFilter(value: string | null): PurchaseNeedsBoardFilter {
  return filters.some((filter) => filter.value === value)
    ? (value as PurchaseNeedsBoardFilter)
    : "open";
}

function workflowState(need: {
  assignedSupplierId: string | null;
  readyForPoDraftAt: string | null;
}) {
  if (need.readyForPoDraftAt) {
    return "ready_for_po";
  }

  if (need.assignedSupplierId) {
    return "assigned";
  }

  return "needs_supplier";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const context = await requirePlanningContext(request);
  const url = new URL(request.url);
  const filter = parseFilter(url.searchParams.get("filter"));

  if (!context.configured) {
    return {
      configured: false as const,
      filter,
      suppliers: [],
      purchaseNeeds: [],
      productionNeeds: [],
    };
  }

  return {
    configured: true as const,
    filter,
    suppliers: await listSuppliers(context.pool, context.ctx),
    ...(await listPurchaseNeedsBoard(context.pool, context.ctx, { filter })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const context = await requirePlanningContext(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (!context.configured) {
    return {
      ok: false,
      message: "Database connection is not configured.",
    } satisfies ActionResult;
  }

  try {
    if (intent === "assign-supplier") {
      const purchaseNeedId = formString(formData, "purchaseNeedId");
      const supplierId = formString(formData, "supplierId");

      if (!purchaseNeedId || !supplierId) {
        return {
          ok: false,
          message: "Choose a supplier for this purchase need.",
        } satisfies ActionResult;
      }

      const result = await assignSupplierToPurchaseNeed(
        context.pool,
        context.ctx,
        {
          purchaseNeedId,
          supplierId,
          rememberForItem: formData.get("rememberForItem") === "on",
        },
      );

      return {
        ok: true,
        message: result.alreadyAssigned
          ? "Supplier was already assigned to this need."
          : "Supplier assigned to purchase need.",
      } satisfies ActionResult;
    }

    if (intent === "assign-preferred-supplier") {
      const purchaseNeedId = formString(formData, "purchaseNeedId");

      if (!purchaseNeedId) {
        return {
          ok: false,
          message: "Choose a purchase need first.",
        } satisfies ActionResult;
      }

      const result = await assignPreferredSupplierToPurchaseNeed(
        context.pool,
        context.ctx,
        { purchaseNeedId },
      );

      return {
        ok: true,
        message: result.alreadyAssigned
          ? "Preferred supplier was already assigned."
          : "Preferred supplier assigned to purchase need.",
      } satisfies ActionResult;
    }

    if (intent === "create-and-assign-supplier") {
      const purchaseNeedId = formString(formData, "purchaseNeedId");
      const supplierName = formString(formData, "supplierName");

      if (!purchaseNeedId || !supplierName) {
        return {
          ok: false,
          message: "Enter a supplier name before assigning.",
        } satisfies ActionResult;
      }

      const supplier = await createSupplier(context.pool, context.ctx, {
        name: supplierName,
        email: formString(formData, "supplierEmail"),
      });
      await assignSupplierToPurchaseNeed(context.pool, context.ctx, {
        purchaseNeedId,
        supplierId: supplier.id,
        rememberForItem: true,
      });

      return {
        ok: true,
        message: `${supplier.name} was created and assigned.`,
      } satisfies ActionResult;
    }

    if (intent === "mark-ready-for-po") {
      const purchaseNeedId = formString(formData, "purchaseNeedId");

      if (!purchaseNeedId) {
        return {
          ok: false,
          message: "Choose a purchase need before marking ready.",
        } satisfies ActionResult;
      }

      const result = await markPurchaseNeedReadyForPo(
        context.pool,
        context.ctx,
        { purchaseNeedId },
      );

      return {
        ok: true,
        message: result.alreadyReady
          ? "This need was already ready for PO draft."
          : "Purchase need marked ready for PO draft.",
      } satisfies ActionResult;
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? formatStatus(error.message) : "Action failed.",
    } satisfies ActionResult;
  }

  return {
    ok: false,
    message: "Unknown needs action.",
  } satisfies ActionResult;
};

export default function NeedsIndex() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  return (
    <s-page heading="Needs">
      <s-section heading="Purchase Needs Board">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Review MRP-generated purchase needs, assign a supplier, then mark
            each need ready for PO draft preparation.
          </s-paragraph>
          {!data.configured && (
            <PlanningEmptyState>
              Database connection is not configured.
            </PlanningEmptyState>
          )}
          {actionData && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>{actionData.message}</s-paragraph>
            </s-box>
          )}
          <s-stack direction="inline" gap="base">
            {filters.map((filter) => (
              <s-link
                key={filter.value}
                href={`/app/needs?filter=${filter.value}`}
              >
                {data.filter === filter.value
                  ? `Selected: ${filter.label}`
                  : filter.label}
              </s-link>
            ))}
            <s-link href="/app/needs/po-draft">Prepare PO Draft</s-link>
          </s-stack>
          {data.configured && data.purchaseNeeds.length === 0 && (
            <PlanningEmptyState>
              No purchase needs match this filter.
            </PlanningEmptyState>
          )}
          {data.purchaseNeeds.map((need) => {
            const state = workflowState(need);

            return (
              <s-box
                key={need.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small">
                  <s-paragraph>
                    <s-text>{need.sku ?? need.title}</s-text>
                    <s-text> - {formatStatus(need.status)}</s-text>
                    <s-text> - {formatStatus(state)}</s-text>
                    <s-text> - qty {formatQuantity(need.quantityNeeded)}</s-text>
                  </s-paragraph>
                  <s-paragraph>
                    Source MRP run:{" "}
                    {need.mrpRunId ? (
                      <s-link href={`/app/mrp/${need.mrpRunId}`}>
                        {shortReference(need.mrpRunId)}
                      </s-link>
                    ) : (
                      "Not linked"
                    )}
                  </s-paragraph>
                  <s-paragraph>
                    Recommended supplier:{" "}
                    {need.recommendedSupplierName ?? "No preferred supplier yet"}
                  </s-paragraph>
                  <s-paragraph>
                    Assigned supplier:{" "}
                    {need.assignedSupplierName
                      ? `${need.assignedSupplierName}${
                          need.assignedSupplierEmail
                            ? ` (${need.assignedSupplierEmail})`
                            : ""
                        }`
                      : "Not assigned"}
                  </s-paragraph>
                  <s-paragraph>
                    Purchase order:{" "}
                    {need.purchaseOrderId ? (
                      <s-link href={`/app/purchase-orders/${need.purchaseOrderId}`}>
                        {need.purchaseOrderDisplayNumber ??
                          shortReference(need.purchaseOrderId)}
                        {need.purchaseOrderStatus
                          ? ` (${formatStatus(need.purchaseOrderStatus)})`
                          : ""}
                      </s-link>
                    ) : (
                      "Not created yet"
                    )}
                  </s-paragraph>
                  {!need.readyForPoDraftAt ? (
                    <s-stack direction="block" gap="small">
                      {!need.assignedSupplierId && need.recommendedSupplierId && (
                        <Form method="post">
                          <input
                            type="hidden"
                            name="intent"
                            value="assign-preferred-supplier"
                          />
                          <input
                            type="hidden"
                            name="purchaseNeedId"
                            value={need.id}
                          />
                          <s-button
                            type="submit"
                            variant="primary"
                            {...(isSubmitting ? { loading: true } : {})}
                          >
                            Assign Preferred Supplier
                          </s-button>
                        </Form>
                      )}
                      {!need.assignedSupplierId &&
                        !need.recommendedSupplierId && (
                          <s-paragraph>
                            Missing supplier. Choose one below or create a new
                            supplier.
                          </s-paragraph>
                        )}
                      <Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="assign-supplier"
                        />
                        <input
                          type="hidden"
                          name="purchaseNeedId"
                          value={need.id}
                        />
                        <s-stack direction="inline" gap="small">
                          <label>
                            Supplier{" "}
                            <select
                              name="supplierId"
                              defaultValue={
                                need.assignedSupplierId ??
                                need.recommendedSupplierId ??
                                ""
                              }
                            >
                              <option value="">Choose supplier</option>
                              {data.suppliers
                                .filter((supplier) => supplier.active)
                                .map((supplier) => (
                                  <option key={supplier.id} value={supplier.id}>
                                    {supplier.name}
                                  </option>
                                ))}
                            </select>
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              name="rememberForItem"
                              defaultChecked={!need.recommendedSupplierId}
                            />{" "}
                            Use as preferred supplier
                          </label>
                          <s-button
                            type="submit"
                            variant="secondary"
                            {...(isSubmitting ? { loading: true } : {})}
                          >
                            Assign Supplier
                          </s-button>
                        </s-stack>
                      </Form>
                      <Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="create-and-assign-supplier"
                        />
                        <input
                          type="hidden"
                          name="purchaseNeedId"
                          value={need.id}
                        />
                        <s-stack direction="inline" gap="small">
                          <label>
                            New supplier{" "}
                            <input
                              name="supplierName"
                              placeholder="Supplier name"
                            />
                          </label>
                          <label>
                            Email{" "}
                            <input
                              name="supplierEmail"
                              placeholder="supplier@example.com"
                            />
                          </label>
                          <s-button
                            type="submit"
                            variant="secondary"
                            {...(isSubmitting ? { loading: true } : {})}
                          >
                            Create and Assign
                          </s-button>
                        </s-stack>
                      </Form>
                      <Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="mark-ready-for-po"
                        />
                        <input
                          type="hidden"
                          name="purchaseNeedId"
                          value={need.id}
                        />
                        <s-button
                          type="submit"
                          variant="primary"
                          disabled={!need.assignedSupplierId}
                          {...(isSubmitting ? { loading: true } : {})}
                        >
                          Mark Ready for PO Draft
                        </s-button>
                      </Form>
                    </s-stack>
                  ) : (
                    <s-paragraph>
                      Ready for PO draft. Open Prepare PO Draft to review the
                      supplier grouping.
                    </s-paragraph>
                  )}
                </s-stack>
              </s-box>
            );
          })}
        </s-stack>
      </s-section>

      <s-section heading="Production Needs">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Production order creation is later scope. These needs remain visible
            so planners can see what MRP committed.
          </s-paragraph>
          {data.configured && data.productionNeeds.length === 0 && (
            <PlanningEmptyState>No production needs yet.</PlanningEmptyState>
          )}
          {data.productionNeeds.map((need) => (
            <s-box
              key={need.id}
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-paragraph>
                <s-text>{need.sku ?? need.itemId}</s-text>
                <s-text> - {formatStatus(need.status)}</s-text>
                <s-text>
                  {" "}
                  - qty {formatQuantity(need.requiredQuantity)}
                </s-text>
              </s-paragraph>
              <s-paragraph>
                Source MRP run:{" "}
                {need.mrpRunId ? (
                  <s-link href={`/app/mrp/${need.mrpRunId}`}>
                    {shortReference(need.mrpRunId)}
                  </s-link>
                ) : (
                  "Not linked"
                )}
              </s-paragraph>
            </s-box>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}
