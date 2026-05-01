import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";

import { PlanningEmptyState } from "../components/PlanningEmptyState";
import { requirePlanningContext } from "../lib/app-context.server";
import { loadItemList } from "../lib/material-planning.server";
import {
  createSupplier,
  linkSupplierToItem,
  listSupplierItemLinks,
  listSuppliers,
  setPreferredSupplierForItem,
  setSupplierActive,
  unlinkSupplierFromItem,
  updateSupplier,
} from "../lib/purchase-needs.server";
import { formatStatus } from "../lib/ui-format";

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
      suppliers: [],
      items: [],
      supplierItemLinks: [],
    };
  }

  const [suppliers, items, supplierItemLinks] = await Promise.all([
    listSuppliers(context.pool, context.ctx),
    loadItemList(context.pool, context.ctx, { limit: 500 }),
    listSupplierItemLinks(context.pool, context.ctx),
  ]);

  return {
    configured: true as const,
    suppliers,
    items,
    supplierItemLinks,
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
    if (intent === "create-supplier") {
      const name = formString(formData, "name");

      if (!name) {
        return {
          ok: false,
          message: "Enter a supplier name.",
        } satisfies ActionResult;
      }

      const supplier = await createSupplier(context.pool, context.ctx, {
        name,
        email: formString(formData, "email"),
      });

      return {
        ok: true,
        message: `${supplier.name} is ready.`,
      } satisfies ActionResult;
    }

    if (intent === "update-supplier") {
      const supplierId = formString(formData, "supplierId");
      const name = formString(formData, "name");

      if (!supplierId || !name) {
        return {
          ok: false,
          message: "Supplier and name are required.",
        } satisfies ActionResult;
      }

      const supplier = await updateSupplier(context.pool, context.ctx, {
        supplierId,
        name,
        email: formString(formData, "email"),
      });

      return {
        ok: true,
        message: `${supplier.name} was updated.`,
      } satisfies ActionResult;
    }

    if (intent === "set-supplier-active") {
      const supplierId = formString(formData, "supplierId");

      if (!supplierId) {
        return {
          ok: false,
          message: "Choose a supplier first.",
        } satisfies ActionResult;
      }

      const result = await setSupplierActive(context.pool, context.ctx, {
        supplierId,
        active: formData.get("active") === "true",
      });

      return {
        ok: true,
        message: result.active
          ? "Supplier reactivated."
          : "Supplier deactivated.",
      } satisfies ActionResult;
    }

    if (intent === "link-supplier-item") {
      const supplierId = formString(formData, "supplierId");
      const itemId = formString(formData, "itemId");

      if (!supplierId || !itemId) {
        return {
          ok: false,
          message: "Choose a supplier and item.",
        } satisfies ActionResult;
      }

      await linkSupplierToItem(context.pool, context.ctx, {
        supplierId,
        itemId,
        supplierSku: formString(formData, "supplierSku"),
        purchaseUnit: formString(formData, "purchaseUnit"),
        isPreferred: formData.get("isPreferred") === "on",
      });

      return {
        ok: true,
        message: "Supplier linked to item.",
      } satisfies ActionResult;
    }

    if (intent === "set-preferred-supplier") {
      const supplierId = formString(formData, "supplierId");
      const itemId = formString(formData, "itemId");

      if (!supplierId || !itemId) {
        return {
          ok: false,
          message: "Choose a supplier item link first.",
        } satisfies ActionResult;
      }

      await setPreferredSupplierForItem(context.pool, context.ctx, {
        supplierId,
        itemId,
      });

      return {
        ok: true,
        message: "Preferred supplier updated for item.",
      } satisfies ActionResult;
    }

    if (intent === "unlink-supplier-item") {
      const supplierItemId = formString(formData, "supplierItemId");

      if (!supplierItemId) {
        return {
          ok: false,
          message: "Choose a supplier item link first.",
        } satisfies ActionResult;
      }

      await unlinkSupplierFromItem(context.pool, context.ctx, {
        supplierItemId,
      });

      return {
        ok: true,
        message: "Supplier item link deactivated.",
      } satisfies ActionResult;
    }
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? formatStatus(error.message) : "Action failed.",
    } satisfies ActionResult;
  }

  return {
    ok: false,
    message: "Unknown supplier action.",
  } satisfies ActionResult;
};

export default function SuppliersIndex() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  return (
    <s-page heading="Suppliers">
      <s-section heading="Supplier Management">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Maintain suppliers and preferred item sourcing before preparing PO
            drafts. Final purchase order creation is later scope.
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
          <Form method="post">
            <input type="hidden" name="intent" value="create-supplier" />
            <s-stack direction="inline" gap="small">
              <label>
                Name <input name="name" placeholder="Supplier name" />
              </label>
              <label>
                Email <input name="email" placeholder="supplier@example.com" />
              </label>
              <s-button
                type="submit"
                variant="primary"
                disabled={!data.configured}
                {...(isSubmitting ? { loading: true } : {})}
              >
                Create Supplier
              </s-button>
            </s-stack>
          </Form>
        </s-stack>
      </s-section>

      <s-section heading="Suppliers">
        <s-stack direction="block" gap="base">
          {data.configured && data.suppliers.length === 0 && (
            <PlanningEmptyState>
              No suppliers yet. Create one, then link it to purchasable items.
            </PlanningEmptyState>
          )}
          {data.suppliers.map((supplier) => (
            <s-box
              key={supplier.id}
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-stack direction="block" gap="small">
                <s-paragraph>
                  <s-text>{supplier.name}</s-text>
                  <s-text>
                    {" "}
                    - {supplier.active ? "Active" : "Inactive"}
                  </s-text>
                  <s-text>
                    {" "}
                    - {supplier.linkedItemCount ?? 0} linked item
                    {(supplier.linkedItemCount ?? 0) === 1 ? "" : "s"}
                  </s-text>
                  <s-text>
                    {" "}
                    - {supplier.openPurchaseNeedCount ?? 0} open assigned need
                    {(supplier.openPurchaseNeedCount ?? 0) === 1 ? "" : "s"}
                  </s-text>
                </s-paragraph>
                <s-paragraph>{supplier.email ?? "No email"}</s-paragraph>
                <Form method="post">
                  <input
                    type="hidden"
                    name="intent"
                    value="update-supplier"
                  />
                  <input
                    type="hidden"
                    name="supplierId"
                    value={supplier.id}
                  />
                  <s-stack direction="inline" gap="small">
                    <label>
                      Name <input name="name" defaultValue={supplier.name} />
                    </label>
                    <label>
                      Email{" "}
                      <input name="email" defaultValue={supplier.email ?? ""} />
                    </label>
                    <s-button
                      type="submit"
                      variant="secondary"
                      {...(isSubmitting ? { loading: true } : {})}
                    >
                      Save
                    </s-button>
                  </s-stack>
                </Form>
                <Form method="post">
                  <input
                    type="hidden"
                    name="intent"
                    value="set-supplier-active"
                  />
                  <input
                    type="hidden"
                    name="supplierId"
                    value={supplier.id}
                  />
                  <input
                    type="hidden"
                    name="active"
                    value={supplier.active ? "false" : "true"}
                  />
                  <s-button
                    type="submit"
                    variant="secondary"
                    {...(isSubmitting ? { loading: true } : {})}
                  >
                    {supplier.active ? "Deactivate" : "Reactivate"}
                  </s-button>
                </Form>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>

      <s-section heading="Preferred Suppliers by Item">
        <s-stack direction="block" gap="base">
          <Form method="post">
            <input type="hidden" name="intent" value="link-supplier-item" />
            <s-stack direction="inline" gap="small">
              <label>
                Supplier{" "}
                <select name="supplierId" defaultValue="">
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
                Item{" "}
                <select name="itemId" defaultValue="">
                  <option value="">Choose item</option>
                  {data.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.sku ?? item.shopifyVariantId}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Supplier SKU <input name="supplierSku" />
              </label>
              <label>
                Unit <input name="purchaseUnit" defaultValue="pcs" size={6} />
              </label>
              <label>
                <input type="checkbox" name="isPreferred" /> Preferred
              </label>
              <s-button
                type="submit"
                variant="primary"
                disabled={!data.configured}
                {...(isSubmitting ? { loading: true } : {})}
              >
                Link Supplier to Item
              </s-button>
            </s-stack>
          </Form>
          {data.configured && data.supplierItemLinks.length === 0 && (
            <PlanningEmptyState>
              No supplier item links yet.
            </PlanningEmptyState>
          )}
          {data.supplierItemLinks.map((link) => (
            <s-box
              key={link.id}
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-stack direction="block" gap="small">
                <s-paragraph>
                  <s-text>{link.supplierName}</s-text>
                  <s-text> - {link.itemSku ?? link.itemId}</s-text>
                  <s-text>
                    {" "}
                    - {link.isPreferred ? "Preferred" : "Backup"}
                  </s-text>
                  <s-text> - {link.active ? "Active" : "Inactive"}</s-text>
                </s-paragraph>
                <s-paragraph>
                  Supplier SKU: {link.supplierSku ?? "Not set"} - unit{" "}
                  {link.purchaseUnit}
                </s-paragraph>
                <s-stack direction="inline" gap="small">
                  <Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="set-preferred-supplier"
                    />
                    <input
                      type="hidden"
                      name="supplierId"
                      value={link.supplierId}
                    />
                    <input type="hidden" name="itemId" value={link.itemId} />
                    <s-button
                      type="submit"
                      variant="secondary"
                      disabled={!link.active || !link.supplierActive}
                      {...(isSubmitting ? { loading: true } : {})}
                    >
                      Mark Preferred
                    </s-button>
                  </Form>
                  <Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="unlink-supplier-item"
                    />
                    <input
                      type="hidden"
                      name="supplierItemId"
                      value={link.id}
                    />
                    <s-button
                      type="submit"
                      variant="secondary"
                      disabled={!link.active}
                      {...(isSubmitting ? { loading: true } : {})}
                    >
                      Deactivate Link
                    </s-button>
                  </Form>
                </s-stack>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}
