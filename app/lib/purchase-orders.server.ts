import type { QueryExecutor } from "./foundation-db.server";
import type { MaterialTenantContext } from "./material-planning.server";

export type PurchaseOrderStatus = "draft" | "sent" | "acknowledged" | "cancelled";

export interface PurchaseOrderSummary {
  id: string;
  displayNumber: string;
  supplierId: string;
  supplierName: string;
  status: string;
  lineCount: number;
  sourceNeedCount: number;
  createdAt: string;
  sentAt: string | null;
  acknowledgedAt: string | null;
  cancelledAt: string | null;
}

export interface PurchaseOrderDetail extends PurchaseOrderSummary {
  supplierEmail: string | null;
  notes: string | null;
  lines: Array<{
    id: string;
    itemId: string | null;
    sku: string | null;
    title: string;
    quantity: number;
    unit: string;
    status: string;
    sourcePurchaseNeedId: string | null;
    sourceMrpRunId: string | null;
  }>;
}

export interface PurchaseOrderCreateResult {
  createdPurchaseOrders: PurchaseOrderSummary[];
  existingPurchaseOrders: PurchaseOrderSummary[];
  skippedNeeds: Array<{ purchaseNeedId: string; reason: string }>;
}

function toNumber(value: string | number | null | undefined) {
  return Number(value ?? 0);
}

function activePurchaseNeedStatusSql() {
  return "lower(purchase_needs.status) in ('open', 'linked_to_po', 'partially_covered')";
}

function displayNumberFromId(id: string) {
  return `PO-${id.slice(0, 8).toUpperCase()}`;
}

async function summarizePurchaseOrders(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  purchaseOrderIds: string[],
) {
  if (purchaseOrderIds.length === 0) {
    return [];
  }

  const result = await db.query<{
    id: string;
    display_number: string | null;
    po_number: string | null;
    supplier_id: string;
    supplier_name: string;
    status: string;
    line_count: string;
    source_need_count: string;
    created_at: Date;
    sent_at: Date | null;
    acknowledged_at: Date | null;
    cancelled_at: Date | null;
  }>(
    `
      select purchase_orders.id,
             purchase_orders.display_number,
             purchase_orders.po_number,
             purchase_orders.supplier_id,
             suppliers.name as supplier_name,
             purchase_orders.status,
             count(purchase_order_lines.id)::text as line_count,
             count(distinct coalesce(
               purchase_order_lines.source_purchase_need_id,
               purchase_order_lines.purchase_need_id
             ))::text as source_need_count,
             purchase_orders.created_at,
             purchase_orders.sent_at,
             purchase_orders.acknowledged_at,
             purchase_orders.cancelled_at
      from public.purchase_orders
      join public.suppliers
        on suppliers.id = purchase_orders.supplier_id
      left join public.purchase_order_lines
        on purchase_order_lines.purchase_order_id = purchase_orders.id
      where purchase_orders.tenant_id = $1
        and purchase_orders.id = any($2::uuid[])
      group by purchase_orders.id, suppliers.name
      order by purchase_orders.created_at desc
    `,
    [ctx.tenantId, purchaseOrderIds],
  );

  return result.rows.map((row) => ({
    id: row.id,
    displayNumber: row.display_number ?? row.po_number ?? displayNumberFromId(row.id),
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    status: row.status,
    lineCount: toNumber(row.line_count),
    sourceNeedCount: toNumber(row.source_need_count),
    createdAt: row.created_at.toISOString(),
    sentAt: row.sent_at?.toISOString() ?? null,
    acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
  })) satisfies PurchaseOrderSummary[];
}

export async function createPurchaseOrdersFromDraftPreview(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
): Promise<PurchaseOrderCreateResult> {
  const readyNeeds = await db.query<{
    id: string;
    item_id: string | null;
    assigned_supplier_id: string;
    shopify_variant_id: string | null;
    sku: string | null;
    title: string;
    quantity_needed: string;
    quantity_covered: string;
    existing_purchase_order_id: string | null;
  }>(
    `
      select purchase_needs.id,
             purchase_needs.item_id,
             purchase_needs.assigned_supplier_id,
             purchase_needs.shopify_variant_id,
             purchase_needs.sku,
             purchase_needs.title,
             purchase_needs.quantity_needed::text,
             purchase_needs.quantity_covered::text,
             purchase_orders.id as existing_purchase_order_id
      from public.purchase_needs
      join public.suppliers
        on suppliers.id = purchase_needs.assigned_supplier_id
       and suppliers.active = true
      left join public.purchase_order_lines
        on purchase_order_lines.tenant_id = purchase_needs.tenant_id
       and (
         purchase_order_lines.source_purchase_need_id = purchase_needs.id
         or purchase_order_lines.purchase_need_id = purchase_needs.id
       )
       and lower(purchase_order_lines.status) <> 'cancelled'
      left join public.purchase_orders
        on purchase_orders.id = purchase_order_lines.purchase_order_id
      where purchase_needs.tenant_id = $1
        and purchase_needs.ready_for_po_draft_at is not null
        and ${activePurchaseNeedStatusSql()}
      order by purchase_needs.assigned_supplier_id asc,
               purchase_needs.created_at asc
    `,
    [ctx.tenantId],
  );

  const existingIds = new Set<string>();
  const skippedNeeds: PurchaseOrderCreateResult["skippedNeeds"] = [];
  const needsBySupplier = new Map<string, typeof readyNeeds.rows>();

  for (const need of readyNeeds.rows) {
    if (need.existing_purchase_order_id) {
      existingIds.add(need.existing_purchase_order_id);
      skippedNeeds.push({
        purchaseNeedId: need.id,
        reason: "already_linked_to_purchase_order",
      });
      continue;
    }

    if (!need.item_id) {
      skippedNeeds.push({
        purchaseNeedId: need.id,
        reason: "missing_item",
      });
      continue;
    }

    const quantityToOrder =
      toNumber(need.quantity_needed) - toNumber(need.quantity_covered);

    if (quantityToOrder <= 0) {
      skippedNeeds.push({
        purchaseNeedId: need.id,
        reason: "no_remaining_quantity",
      });
      continue;
    }

    const group = needsBySupplier.get(need.assigned_supplier_id) ?? [];
    group.push(need);
    needsBySupplier.set(need.assigned_supplier_id, group);
  }

  const createdIds: string[] = [];

  for (const [supplierId, needs] of needsBySupplier.entries()) {
    const purchaseOrder = await db.query<{ id: string }>(
      `
        insert into public.purchase_orders (
          tenant_id,
          supplier_id,
          status,
          source_type,
          source_id,
          notes
        )
        values ($1, $2, 'draft', 'po_draft_preview', $2::uuid, 'Created from PO Draft Preview')
        returning id
      `,
      [ctx.tenantId, supplierId],
    );
    const purchaseOrderId = purchaseOrder.rows[0]!.id;
    const displayNumber = displayNumberFromId(purchaseOrderId);

    await db.query(
      `
        update public.purchase_orders
        set display_number = $3,
            po_number = coalesce(po_number, $3),
            updated_at = now()
        where tenant_id = $1
          and id = $2
      `,
      [ctx.tenantId, purchaseOrderId, displayNumber],
    );

    for (const need of needs) {
      const quantityToOrder =
        toNumber(need.quantity_needed) - toNumber(need.quantity_covered);

      await db.query(
        `
          insert into public.purchase_order_lines (
            tenant_id,
            purchase_order_id,
            purchase_need_id,
            source_purchase_need_id,
            item_id,
            shopify_variant_id,
            sku,
            title,
            quantity_ordered,
            quantity,
            unit,
            status
          )
          values ($1, $2, $3, $3, $4, $5, $6, $7, $8, $8, 'pcs', 'open')
          on conflict (tenant_id, source_purchase_need_id)
          where source_purchase_need_id is not null
            and status <> 'cancelled'
          do nothing
        `,
        [
          ctx.tenantId,
          purchaseOrderId,
          need.id,
          need.item_id,
          need.shopify_variant_id,
          need.sku,
          need.title,
          quantityToOrder,
        ],
      );

      await db.query(
        `
          update public.purchase_needs
          set status = 'linked_to_po',
              updated_at = now()
          where tenant_id = $1
            and id = $2
        `,
        [ctx.tenantId, need.id],
      );
    }

    createdIds.push(purchaseOrderId);
  }

  return {
    createdPurchaseOrders: await summarizePurchaseOrders(db, ctx, createdIds),
    existingPurchaseOrders: await summarizePurchaseOrders(
      db,
      ctx,
      Array.from(existingIds),
    ),
    skippedNeeds,
  };
}

export async function listPurchaseOrders(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
): Promise<PurchaseOrderSummary[]> {
  const ids = await db.query<{ id: string }>(
    `
      select id
      from public.purchase_orders
      where tenant_id = $1
      order by created_at desc
      limit 100
    `,
    [ctx.tenantId],
  );

  return summarizePurchaseOrders(
    db,
    ctx,
    ids.rows.map((row) => row.id),
  );
}

export async function loadPurchaseOrderDetail(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  purchaseOrderId: string,
): Promise<PurchaseOrderDetail> {
  const header = await db.query<{
    id: string;
    display_number: string | null;
    po_number: string | null;
    supplier_id: string;
    supplier_name: string;
    supplier_email: string | null;
    status: string;
    notes: string | null;
    created_at: Date;
    sent_at: Date | null;
    acknowledged_at: Date | null;
    cancelled_at: Date | null;
  }>(
    `
      select purchase_orders.id,
             purchase_orders.display_number,
             purchase_orders.po_number,
             purchase_orders.supplier_id,
             suppliers.name as supplier_name,
             suppliers.email as supplier_email,
             purchase_orders.status,
             purchase_orders.notes,
             purchase_orders.created_at,
             purchase_orders.sent_at,
             purchase_orders.acknowledged_at,
             purchase_orders.cancelled_at
      from public.purchase_orders
      join public.suppliers
        on suppliers.id = purchase_orders.supplier_id
      where purchase_orders.tenant_id = $1
        and purchase_orders.id = $2
      limit 1
    `,
    [ctx.tenantId, purchaseOrderId],
  );

  if (!header.rows[0]) {
    throw new Error("purchase_order_not_found");
  }

  const lines = await db.query<{
    id: string;
    item_id: string | null;
    sku: string | null;
    title: string;
    quantity: string;
    unit: string;
    status: string;
    source_purchase_need_id: string | null;
    mrp_run_id: string | null;
  }>(
    `
      select purchase_order_lines.id,
             purchase_order_lines.item_id,
             purchase_order_lines.sku,
             purchase_order_lines.title,
             coalesce(purchase_order_lines.quantity, purchase_order_lines.quantity_ordered)::text as quantity,
             purchase_order_lines.unit,
             purchase_order_lines.status,
             coalesce(
               purchase_order_lines.source_purchase_need_id,
               purchase_order_lines.purchase_need_id
             ) as source_purchase_need_id,
             mrp_run_lines.mrp_run_id
      from public.purchase_order_lines
      left join public.purchase_needs
        on purchase_needs.id = coalesce(
          purchase_order_lines.source_purchase_need_id,
          purchase_order_lines.purchase_need_id
        )
      left join public.mrp_run_lines
        on mrp_run_lines.id = purchase_needs.mrp_run_line_id
      where purchase_order_lines.tenant_id = $1
        and purchase_order_lines.purchase_order_id = $2
      order by purchase_order_lines.created_at asc
    `,
    [ctx.tenantId, purchaseOrderId],
  );

  const row = header.rows[0];

  return {
    id: row.id,
    displayNumber: row.display_number ?? row.po_number ?? displayNumberFromId(row.id),
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    supplierEmail: row.supplier_email,
    status: row.status,
    notes: row.notes,
    lineCount: lines.rows.length,
    sourceNeedCount: lines.rows.filter((line) => line.source_purchase_need_id)
      .length,
    createdAt: row.created_at.toISOString(),
    sentAt: row.sent_at?.toISOString() ?? null,
    acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    lines: lines.rows.map((line) => ({
      id: line.id,
      itemId: line.item_id,
      sku: line.sku,
      title: line.title,
      quantity: toNumber(line.quantity),
      unit: line.unit,
      status: line.status,
      sourcePurchaseNeedId: line.source_purchase_need_id,
      sourceMrpRunId: line.mrp_run_id,
    })),
  };
}

async function loadPurchaseOrderStatus(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  purchaseOrderId: string,
) {
  const result = await db.query<{ status: string }>(
    `
      select lower(status) as status
      from public.purchase_orders
      where tenant_id = $1
        and id = $2
      limit 1
    `,
    [ctx.tenantId, purchaseOrderId],
  );

  if (!result.rows[0]) {
    throw new Error("purchase_order_not_found");
  }

  return result.rows[0].status;
}

export async function markPurchaseOrderSent(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: { purchaseOrderId: string },
) {
  const status = await loadPurchaseOrderStatus(db, ctx, input.purchaseOrderId);

  if (status === "sent" || status === "acknowledged") {
    return { purchaseOrderId: input.purchaseOrderId, status, alreadyDone: true };
  }

  if (status !== "draft") {
    throw new Error("purchase_order_not_draft");
  }

  await db.query(
    `
      update public.purchase_orders
      set status = 'sent',
          sent_at = coalesce(sent_at, now()),
          updated_at = now()
      where tenant_id = $1
        and id = $2
    `,
    [ctx.tenantId, input.purchaseOrderId],
  );

  return { purchaseOrderId: input.purchaseOrderId, status: "sent", alreadyDone: false };
}

export async function markPurchaseOrderAcknowledged(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: { purchaseOrderId: string },
) {
  const status = await loadPurchaseOrderStatus(db, ctx, input.purchaseOrderId);

  if (status === "acknowledged") {
    return {
      purchaseOrderId: input.purchaseOrderId,
      status,
      alreadyDone: true,
    };
  }

  if (status === "cancelled") {
    throw new Error("purchase_order_cancelled");
  }

  if (status !== "sent") {
    throw new Error("purchase_order_not_sent");
  }

  await db.query(
    `
      update public.purchase_orders
      set status = 'acknowledged',
          acknowledged_at = coalesce(acknowledged_at, now()),
          updated_at = now()
      where tenant_id = $1
        and id = $2
    `,
    [ctx.tenantId, input.purchaseOrderId],
  );

  return {
    purchaseOrderId: input.purchaseOrderId,
    status: "acknowledged",
    alreadyDone: false,
  };
}

export async function cancelPurchaseOrder(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: { purchaseOrderId: string },
) {
  const status = await loadPurchaseOrderStatus(db, ctx, input.purchaseOrderId);

  if (status === "cancelled") {
    return {
      purchaseOrderId: input.purchaseOrderId,
      status,
      alreadyDone: true,
    };
  }

  if (!["draft", "sent"].includes(status)) {
    throw new Error("purchase_order_cannot_be_cancelled");
  }

  await db.query(
    `
      update public.purchase_orders
      set status = 'cancelled',
          cancelled_at = coalesce(cancelled_at, now()),
          updated_at = now()
      where tenant_id = $1
        and id = $2
    `,
    [ctx.tenantId, input.purchaseOrderId],
  );

  return {
    purchaseOrderId: input.purchaseOrderId,
    status: "cancelled",
    alreadyDone: false,
  };
}

export async function loadPurchaseOrderDashboardSummary(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
) {
  const result = await db.query<{
    draft_count: string;
    sent_count: string;
    acknowledged_count: string;
  }>(
    `
      select
        count(*) filter (where lower(status) = 'draft')::text as draft_count,
        count(*) filter (where lower(status) = 'sent')::text as sent_count,
        count(*) filter (where lower(status) = 'acknowledged')::text as acknowledged_count
      from public.purchase_orders
      where tenant_id = $1
    `,
    [ctx.tenantId],
  );

  return {
    draftPurchaseOrders: toNumber(result.rows[0]?.draft_count),
    sentPurchaseOrders: toNumber(result.rows[0]?.sent_count),
    acknowledgedPurchaseOrders: toNumber(result.rows[0]?.acknowledged_count),
  };
}
