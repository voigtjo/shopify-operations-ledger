import type { QueryExecutor } from "./foundation-db.server";

export interface TenantContext {
  tenantId: string;
  shopDomain?: string;
}

export interface ShopifyOrderLineInput {
  shopifyVariantId?: string | null;
  sku?: string | null;
  title: string;
  quantity: number;
}

export interface ShopifyOrderImportInput {
  shopDomain: string;
  shopifyOrderId: string;
  shopifyOrderName?: string | null;
  shopifyCreatedAt?: string | null;
  customerName?: string | null;
  customerExternalId?: string | null;
  currency?: string | null;
  rawPayload?: unknown;
  lines: ShopifyOrderLineInput[];
}

export interface InventoryItemInput {
  shopifyVariantId?: string | null;
  sku?: string | null;
  title?: string | null;
}

export interface InventoryBalance {
  physicalQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
}

export interface CreatePurchaseOrderInput {
  supplierId: string;
  purchaseNeedIds: string[];
  expectedDeliveryDate?: string | null;
  currency?: string | null;
  notes?: string | null;
}

export interface PostGoodsReceiptInput {
  purchaseOrderId: string;
  receiptNumber?: string | null;
  receivedAt?: string | null;
  notes?: string | null;
  lines: Array<{
    purchaseOrderLineId: string;
    quantityReceived: number;
  }>;
}

type OperationsOrderLineRow = {
  id: string;
  tenant_id: string;
  operations_order_id: string;
  shopify_variant_id: string | null;
  sku: string | null;
  title: string;
  quantity_required: string;
  quantity_reserved: string;
  quantity_missing: string;
  supply_status: string;
};

type PurchaseNeedRow = {
  id: string;
  tenant_id: string;
  operations_order_id: string | null;
  operations_order_line_id: string | null;
  shopify_variant_id: string | null;
  sku: string | null;
  title: string;
  quantity_needed: string;
  quantity_covered: string;
  status: string;
};

function toNumber(value: string | number | null | undefined) {
  return Number(value ?? 0);
}

function assertPositiveQuantity(quantity: number, label: string) {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`${label} must be greater than zero`);
  }
}

function normalizeShopDomain(shopDomain: string) {
  return shopDomain.trim().toLowerCase();
}

function itemWhereClause(item: InventoryItemInput, startIndex: number) {
  if (item.shopifyVariantId) {
    return {
      clause: `shopify_variant_id = $${startIndex}`,
      params: [item.shopifyVariantId],
    };
  }

  if (item.sku) {
    return {
      clause: `sku = $${startIndex}`,
      params: [item.sku],
    };
  }

  throw new Error("Inventory item requires shopifyVariantId or sku");
}

async function createDomainEvent(
  db: QueryExecutor,
  ctx: TenantContext,
  input: {
    eventType: string;
    aggregateType: string;
    aggregateId?: string | null;
    idempotencyKey?: string | null;
    payload: Record<string, unknown>;
  },
) {
  await db.query(
    `
      insert into public.domain_events (
        tenant_id,
        event_type,
        aggregate_type,
        aggregate_id,
        idempotency_key,
        payload
      )
      values ($1, $2, $3, $4, $5, $6::jsonb)
      on conflict (tenant_id, idempotency_key) do nothing
    `,
    [
      ctx.tenantId,
      input.eventType,
      input.aggregateType,
      input.aggregateId ?? null,
      input.idempotencyKey ?? null,
      JSON.stringify(input.payload),
    ],
  );
}

async function resolveTenantByShopDomain(db: QueryExecutor, shopDomain: string) {
  const result = await db.query<{ id: string }>(
    `
      select id
      from public.tenants
      where primary_shop_domain = $1
        and status <> 'DELETED'
      limit 1
    `,
    [normalizeShopDomain(shopDomain)],
  );

  const tenant = result.rows[0];

  if (!tenant) {
    throw new Error(`No Operations Ledger tenant found for ${shopDomain}`);
  }

  return tenant;
}

export async function importShopifyOrder(
  db: QueryExecutor,
  input: ShopifyOrderImportInput,
) {
  if (input.lines.length === 0) {
    throw new Error("Shopify order import requires at least one line item");
  }

  for (const line of input.lines) {
    assertPositiveQuantity(line.quantity, "Line quantity");
  }

  const tenant = await resolveTenantByShopDomain(db, input.shopDomain);
  const ctx: TenantContext = {
    tenantId: tenant.id,
    shopDomain: normalizeShopDomain(input.shopDomain),
  };
  const existing = await db.query<{ operations_order_id: string; status: string }>(
    `
      select operations_orders.id as operations_order_id, operations_orders.status
      from public.shopify_order_refs
      join public.operations_orders
        on operations_orders.origin_ref_id = shopify_order_refs.id
      where shopify_order_refs.tenant_id = $1
        and shopify_order_refs.shopify_order_id = $2
      limit 1
    `,
    [tenant.id, input.shopifyOrderId],
  );

  if (existing.rows[0]) {
    return {
      operationsOrderId: existing.rows[0].operations_order_id,
      status: existing.rows[0].status,
      alreadyImported: true,
    };
  }

  const orderRefResult = await db.query<{ id: string }>(
    `
      insert into public.shopify_order_refs (
        tenant_id,
        shopify_order_id,
        shopify_order_name,
        shopify_created_at,
        raw_payload
      )
      values ($1, $2, $3, $4, $5::jsonb)
      returning id
    `,
    [
      tenant.id,
      input.shopifyOrderId,
      input.shopifyOrderName ?? null,
      input.shopifyCreatedAt ?? null,
      JSON.stringify(input.rawPayload ?? {}),
    ],
  );
  const orderRefId = orderRefResult.rows[0]!.id;
  const operationsOrderResult = await db.query<{ id: string; status: string }>(
    `
      insert into public.operations_orders (
        tenant_id,
        origin_type,
        origin_ref_id,
        order_number,
        customer_name,
        customer_external_id,
        status,
        currency
      )
      values ($1, 'SHOPIFY_ORDER', $2, $3, $4, $5, 'OPEN', $6)
      returning id, status
    `,
    [
      tenant.id,
      orderRefId,
      input.shopifyOrderName ?? null,
      input.customerName ?? null,
      input.customerExternalId ?? null,
      input.currency ?? null,
    ],
  );
  const operationsOrder = operationsOrderResult.rows[0]!;

  for (const line of input.lines) {
    await db.query(
      `
        insert into public.operations_order_lines (
          tenant_id,
          operations_order_id,
          shopify_variant_id,
          sku,
          title,
          quantity_required,
          supply_status
        )
        values ($1, $2, $3, $4, $5, $6, 'UNCHECKED')
      `,
      [
        tenant.id,
        operationsOrder.id,
        line.shopifyVariantId ?? null,
        line.sku ?? null,
        line.title,
        line.quantity,
      ],
    );
  }

  await db.query(
    `
      insert into public.idempotency_keys (
        tenant_id,
        key,
        purpose,
        result_ref_type,
        result_ref_id
      )
      values ($1, $2, 'SHOPIFY_ORDER_IMPORT', 'operations_order', $3)
      on conflict (tenant_id, key) do nothing
    `,
    [
      tenant.id,
      `shopify_order_import:${ctx.shopDomain}:${input.shopifyOrderId}`,
      operationsOrder.id,
    ],
  );

  await createDomainEvent(db, ctx, {
    eventType: "OPERATIONS_ORDER_CREATED",
    aggregateType: "operations_order",
    aggregateId: operationsOrder.id,
    payload: {
      operations_order_id: operationsOrder.id,
      origin_type: "SHOPIFY_ORDER",
      origin_ref_id: orderRefId,
      order_number: input.shopifyOrderName ?? null,
    },
  });
  await createDomainEvent(db, ctx, {
    eventType: "SHOPIFY_ORDER_IMPORTED",
    aggregateType: "shopify_order_ref",
    aggregateId: orderRefId,
    idempotencyKey: `shopify_order_import:${ctx.shopDomain}:${input.shopifyOrderId}`,
    payload: {
      shopify_order_ref_id: orderRefId,
      shopify_order_id: input.shopifyOrderId,
      operations_order_id: operationsOrder.id,
    },
  });

  return {
    operationsOrderId: operationsOrder.id,
    status: operationsOrder.status,
    alreadyImported: false,
  };
}

export async function getInventoryBalance(
  db: QueryExecutor,
  ctx: TenantContext,
  item: InventoryItemInput,
): Promise<InventoryBalance> {
  const where = itemWhereClause(item, 2);
  const result = await db.query<{
    physical_quantity: string;
    reserved_quantity: string;
  }>(
    `
      select
        coalesce(sum(quantity_delta), 0)::text as physical_quantity,
        coalesce(sum(reservation_delta), 0)::text as reserved_quantity
      from public.inventory_movements
      where tenant_id = $1
        and ${where.clause}
    `,
    [ctx.tenantId, ...where.params],
  );
  const physicalQuantity = toNumber(result.rows[0]?.physical_quantity);
  const reservedQuantity = toNumber(result.rows[0]?.reserved_quantity);

  return {
    physicalQuantity,
    reservedQuantity,
    availableQuantity: physicalQuantity - reservedQuantity,
  };
}

export async function createInventoryAdjustment(
  db: QueryExecutor,
  ctx: TenantContext,
  input: InventoryItemInput & { quantityDelta: number; reason: string },
) {
  if (!input.reason.trim()) {
    throw new Error("Inventory adjustment requires a reason");
  }

  if (!Number.isFinite(input.quantityDelta) || input.quantityDelta === 0) {
    throw new Error("Inventory adjustment quantity_delta must be non-zero");
  }

  const movementResult = await db.query<{ id: string }>(
    `
      insert into public.inventory_movements (
        tenant_id,
        shopify_variant_id,
        sku,
        title,
        movement_type,
        quantity_delta,
        reservation_delta,
        source_type,
        reason
      )
      values ($1, $2, $3, $4, 'MANUAL_ADJUSTMENT', $5, 0, 'MANUAL_ADJUSTMENT', $6)
      returning id
    `,
    [
      ctx.tenantId,
      input.shopifyVariantId ?? null,
      input.sku ?? null,
      input.title ?? null,
      input.quantityDelta,
      input.reason,
    ],
  );
  const movementId = movementResult.rows[0]!.id;

  await createDomainEvent(db, ctx, {
    eventType: "INVENTORY_MOVEMENT_CREATED",
    aggregateType: "inventory_movement",
    aggregateId: movementId,
    payload: {
      inventory_movement_id: movementId,
      movement_type: "MANUAL_ADJUSTMENT",
      sku: input.sku ?? null,
      quantity_delta: input.quantityDelta,
      reservation_delta: 0,
      source_type: "MANUAL_ADJUSTMENT",
    },
  });
  await createDomainEvent(db, ctx, {
    eventType: "INVENTORY_ADJUSTED",
    aggregateType: "inventory_movement",
    aggregateId: movementId,
    payload: {
      inventory_movement_id: movementId,
      sku: input.sku ?? null,
      quantity_delta: input.quantityDelta,
      reason: input.reason,
    },
  });

  return { inventoryMovementId: movementId };
}

export async function runSupplyCheck(
  db: QueryExecutor,
  ctx: TenantContext,
  operationsOrderId: string,
) {
  const orderResult = await db.query<{ id: string; status: string }>(
    `
      select id, status
      from public.operations_orders
      where tenant_id = $1
        and id = $2
      limit 1
    `,
    [ctx.tenantId, operationsOrderId],
  );
  const order = orderResult.rows[0];

  if (!order) {
    throw new Error("Operations order not found");
  }

  if (order.status === "CANCELLED") {
    throw new Error("Cancelled operations order cannot run supply check");
  }

  const linesResult = await db.query<OperationsOrderLineRow>(
    `
      select *
      from public.operations_order_lines
      where tenant_id = $1
        and operations_order_id = $2
      order by created_at asc
    `,
    [ctx.tenantId, operationsOrderId],
  );

  const createdPurchaseNeeds: Array<{ id: string; sku: string | null; quantityNeeded: number }> =
    [];
  const lineResults = [];

  for (const line of linesResult.rows) {
    const required = toNumber(line.quantity_required);
    const currentReserved = toNumber(line.quantity_reserved);
    const requiredRemaining = Math.max(required - currentReserved, 0);
    const balance = await getInventoryBalance(db, ctx, {
      shopifyVariantId: line.shopify_variant_id,
      sku: line.sku,
    });
    const reserveQuantity = Math.min(
      Math.max(balance.availableQuantity, 0),
      requiredRemaining,
    );

    if (reserveQuantity > 0) {
      const movementResult = await db.query<{ id: string }>(
        `
          insert into public.inventory_movements (
            tenant_id,
            shopify_variant_id,
            sku,
            title,
            movement_type,
            quantity_delta,
            reservation_delta,
            source_type,
            source_id
          )
          values ($1, $2, $3, $4, 'RESERVATION_CREATED', 0, $5, 'OPERATIONS_ORDER_LINE', $6)
          returning id
        `,
        [
          ctx.tenantId,
          line.shopify_variant_id,
          line.sku,
          line.title,
          reserveQuantity,
          line.id,
        ],
      );
      const movementId = movementResult.rows[0]!.id;

      await createDomainEvent(db, ctx, {
        eventType: "INVENTORY_MOVEMENT_CREATED",
        aggregateType: "inventory_movement",
        aggregateId: movementId,
        payload: {
          inventory_movement_id: movementId,
          movement_type: "RESERVATION_CREATED",
          sku: line.sku,
          quantity_delta: 0,
          reservation_delta: reserveQuantity,
          source_type: "OPERATIONS_ORDER_LINE",
          source_id: line.id,
        },
      });
    }

    const quantityReserved = currentReserved + reserveQuantity;
    const quantityMissing = Math.max(required - quantityReserved, 0);
    const supplyStatus =
      quantityMissing === 0
        ? "RESERVED"
        : quantityReserved > 0
          ? "PARTIALLY_RESERVED"
          : "MISSING";

    await db.query(
      `
        update public.operations_order_lines
        set quantity_reserved = $3,
            quantity_missing = $4,
            supply_status = $5,
            updated_at = now()
        where tenant_id = $1
          and id = $2
      `,
      [ctx.tenantId, line.id, quantityReserved, quantityMissing, supplyStatus],
    );

    if (quantityMissing > 0) {
      const existingNeedResult = await db.query<PurchaseNeedRow>(
        `
          select *
          from public.purchase_needs
          where tenant_id = $1
            and operations_order_line_id = $2
            and status in ('OPEN', 'LINKED_TO_PO', 'PARTIALLY_COVERED')
          limit 1
        `,
        [ctx.tenantId, line.id],
      );

      const existingNeed = existingNeedResult.rows[0];

      if (existingNeed) {
        if (existingNeed.status === "OPEN") {
          await db.query(
            `
              update public.purchase_needs
              set quantity_needed = $3,
                  updated_at = now()
              where tenant_id = $1
                and id = $2
            `,
            [ctx.tenantId, existingNeed.id, quantityMissing],
          );
        }
      } else {
        const purchaseNeedResult = await db.query<{ id: string }>(
          `
            insert into public.purchase_needs (
              tenant_id,
              operations_order_id,
              operations_order_line_id,
              shopify_variant_id,
              sku,
              title,
              quantity_needed,
              status
            )
            values ($1, $2, $3, $4, $5, $6, $7, 'OPEN')
            returning id
          `,
          [
            ctx.tenantId,
            operationsOrderId,
            line.id,
            line.shopify_variant_id,
            line.sku,
            line.title,
            quantityMissing,
          ],
        );
        const purchaseNeedId = purchaseNeedResult.rows[0]!.id;

        createdPurchaseNeeds.push({
          id: purchaseNeedId,
          sku: line.sku,
          quantityNeeded: quantityMissing,
        });
        await createDomainEvent(db, ctx, {
          eventType: "PURCHASE_NEED_CREATED",
          aggregateType: "purchase_need",
          aggregateId: purchaseNeedId,
          payload: {
            purchase_need_id: purchaseNeedId,
            operations_order_id: operationsOrderId,
            operations_order_line_id: line.id,
            sku: line.sku,
            quantity_needed: quantityMissing,
          },
        });
      }
    }

    lineResults.push({
      operationsOrderLineId: line.id,
      required,
      reserved: quantityReserved,
      missing: quantityMissing,
      supplyStatus,
    });
  }

  const status = lineResults.every((line) => line.supplyStatus === "RESERVED")
    ? "SUPPLY_READY"
    : "SUPPLY_PENDING";

  await db.query(
    `
      update public.operations_orders
      set status = $3,
          updated_at = now()
      where tenant_id = $1
        and id = $2
    `,
    [ctx.tenantId, operationsOrderId, status],
  );
  await createDomainEvent(db, ctx, {
    eventType: "SUPPLY_CHECK_COMPLETED",
    aggregateType: "operations_order",
    aggregateId: operationsOrderId,
    payload: {
      operations_order_id: operationsOrderId,
      result: status,
      lines: lineResults.map((line) => ({
        operations_order_line_id: line.operationsOrderLineId,
        required: line.required,
        reserved: line.reserved,
        missing: line.missing,
        supply_status: line.supplyStatus,
      })),
    },
  });

  return {
    operationsOrderId,
    status,
    createdPurchaseNeeds,
    lines: lineResults,
  };
}

export async function createSupplier(
  db: QueryExecutor,
  ctx: TenantContext,
  input: { name: string; email?: string | null; externalRef?: string | null },
) {
  if (!input.name.trim()) {
    throw new Error("Supplier name is required");
  }

  const result = await db.query<{ id: string }>(
    `
      insert into public.suppliers (tenant_id, name, email, external_ref)
      values ($1, $2, $3, $4)
      on conflict (tenant_id, name)
      do update set email = excluded.email,
                    external_ref = excluded.external_ref,
                    active = true,
                    updated_at = now()
      returning id
    `,
    [ctx.tenantId, input.name, input.email ?? null, input.externalRef ?? null],
  );

  return { supplierId: result.rows[0]!.id };
}

export async function createPurchaseOrderFromNeeds(
  db: QueryExecutor,
  ctx: TenantContext,
  input: CreatePurchaseOrderInput,
) {
  if (input.purchaseNeedIds.length === 0) {
    throw new Error("Purchase order requires at least one purchase need");
  }

  const supplierResult = await db.query<{ id: string }>(
    `
      select id
      from public.suppliers
      where tenant_id = $1
        and id = $2
        and active = true
      limit 1
    `,
    [ctx.tenantId, input.supplierId],
  );

  if (!supplierResult.rows[0]) {
    throw new Error("Active supplier not found");
  }

  const needsResult = await db.query<PurchaseNeedRow>(
    `
      select *
      from public.purchase_needs
      where tenant_id = $1
        and id = any($2::uuid[])
      order by created_at asc
    `,
    [ctx.tenantId, input.purchaseNeedIds],
  );

  if (needsResult.rows.length !== input.purchaseNeedIds.length) {
    throw new Error("One or more purchase needs were not found");
  }

  for (const need of needsResult.rows) {
    if (need.status !== "OPEN") {
      throw new Error("Purchase order can only be created from OPEN needs");
    }
  }

  const purchaseOrderResult = await db.query<{ id: string; status: string }>(
    `
      insert into public.purchase_orders (
        tenant_id,
        supplier_id,
        status,
        expected_delivery_date,
        currency,
        notes
      )
      values ($1, $2, 'DRAFT', $3, $4, $5)
      returning id, status
    `,
    [
      ctx.tenantId,
      input.supplierId,
      input.expectedDeliveryDate ?? null,
      input.currency ?? null,
      input.notes ?? null,
    ],
  );
  const purchaseOrder = purchaseOrderResult.rows[0]!;

  for (const need of needsResult.rows) {
    const quantityNeeded = toNumber(need.quantity_needed);
    const quantityCovered = toNumber(need.quantity_covered);
    const quantityOrdered = quantityNeeded - quantityCovered;

    assertPositiveQuantity(quantityOrdered, "Purchase order line quantity");

    await db.query(
      `
        insert into public.purchase_order_lines (
          tenant_id,
          purchase_order_id,
          purchase_need_id,
          shopify_variant_id,
          sku,
          title,
          quantity_ordered
        )
        values ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        ctx.tenantId,
        purchaseOrder.id,
        need.id,
        need.shopify_variant_id,
        need.sku,
        need.title,
        quantityOrdered,
      ],
    );

    await db.query(
      `
        update public.purchase_needs
        set status = 'LINKED_TO_PO',
            updated_at = now()
        where tenant_id = $1
          and id = $2
      `,
      [ctx.tenantId, need.id],
    );
  }

  await createDomainEvent(db, ctx, {
    eventType: "PURCHASE_ORDER_CREATED",
    aggregateType: "purchase_order",
    aggregateId: purchaseOrder.id,
    payload: {
      purchase_order_id: purchaseOrder.id,
      supplier_id: input.supplierId,
      status: purchaseOrder.status,
      line_count: needsResult.rows.length,
    },
  });

  return {
    purchaseOrderId: purchaseOrder.id,
    status: purchaseOrder.status,
  };
}

export async function sendPurchaseOrder(
  db: QueryExecutor,
  ctx: TenantContext,
  purchaseOrderId: string,
) {
  const lineCountResult = await db.query<{ count: string }>(
    `
      select count(*)::text as count
      from public.purchase_order_lines
      where tenant_id = $1
        and purchase_order_id = $2
    `,
    [ctx.tenantId, purchaseOrderId],
  );

  if (lineCountResult.rows[0]?.count === "0") {
    throw new Error("Purchase order cannot be sent without lines");
  }

  const result = await db.query<{ id: string; status: string; po_number: string | null }>(
    `
      update public.purchase_orders
      set status = 'SENT',
          updated_at = now()
      where tenant_id = $1
        and id = $2
        and status = 'DRAFT'
      returning id, status, po_number
    `,
    [ctx.tenantId, purchaseOrderId],
  );
  const purchaseOrder = result.rows[0];

  if (!purchaseOrder) {
    throw new Error("Only DRAFT purchase orders can be sent");
  }

  await createDomainEvent(db, ctx, {
    eventType: "PURCHASE_ORDER_SENT",
    aggregateType: "purchase_order",
    aggregateId: purchaseOrder.id,
    payload: {
      purchase_order_id: purchaseOrder.id,
      po_number: purchaseOrder.po_number,
    },
  });

  return { purchaseOrderId: purchaseOrder.id, status: purchaseOrder.status };
}

export async function postGoodsReceipt(
  db: QueryExecutor,
  ctx: TenantContext,
  input: PostGoodsReceiptInput,
) {
  if (input.lines.length === 0) {
    throw new Error("Goods receipt requires at least one line");
  }

  const purchaseOrderResult = await db.query<{ id: string; status: string }>(
    `
      select id, status
      from public.purchase_orders
      where tenant_id = $1
        and id = $2
      limit 1
    `,
    [ctx.tenantId, input.purchaseOrderId],
  );
  const purchaseOrder = purchaseOrderResult.rows[0];

  if (!purchaseOrder) {
    throw new Error("Purchase order not found");
  }

  if (!["SENT", "PARTIALLY_RECEIVED"].includes(purchaseOrder.status)) {
    throw new Error("Goods receipt requires a SENT or PARTIALLY_RECEIVED purchase order");
  }

  const receiptResult = await db.query<{ id: string }>(
    `
      insert into public.goods_receipts (
        tenant_id,
        purchase_order_id,
        receipt_number,
        status,
        received_at,
        notes
      )
      values ($1, $2, $3, 'POSTED', coalesce($4::timestamptz, now()), $5)
      returning id
    `,
    [
      ctx.tenantId,
      input.purchaseOrderId,
      input.receiptNumber ?? null,
      input.receivedAt ?? null,
      input.notes ?? null,
    ],
  );
  const goodsReceiptId = receiptResult.rows[0]!.id;
  const eventLines = [];

  for (const line of input.lines) {
    assertPositiveQuantity(line.quantityReceived, "Receipt quantity");

    const purchaseOrderLineResult = await db.query<{
      id: string;
      purchase_need_id: string | null;
      shopify_variant_id: string | null;
      sku: string | null;
      title: string;
      quantity_ordered: string;
      quantity_received: string;
    }>(
      `
        select *
        from public.purchase_order_lines
        where tenant_id = $1
          and purchase_order_id = $2
          and id = $3
        limit 1
      `,
      [ctx.tenantId, input.purchaseOrderId, line.purchaseOrderLineId],
    );
    const purchaseOrderLine = purchaseOrderLineResult.rows[0];

    if (!purchaseOrderLine) {
      throw new Error("Purchase order line not found for receipt");
    }

    const ordered = toNumber(purchaseOrderLine.quantity_ordered);
    const alreadyReceived = toNumber(purchaseOrderLine.quantity_received);

    if (alreadyReceived + line.quantityReceived > ordered) {
      throw new Error("Over receipt is not allowed by default");
    }

    const receiptLineResult = await db.query<{ id: string }>(
      `
        insert into public.goods_receipt_lines (
          tenant_id,
          goods_receipt_id,
          purchase_order_line_id,
          shopify_variant_id,
          sku,
          title,
          quantity_received
        )
        values ($1, $2, $3, $4, $5, $6, $7)
        returning id
      `,
      [
        ctx.tenantId,
        goodsReceiptId,
        purchaseOrderLine.id,
        purchaseOrderLine.shopify_variant_id,
        purchaseOrderLine.sku,
        purchaseOrderLine.title,
        line.quantityReceived,
      ],
    );
    const receiptLineId = receiptLineResult.rows[0]!.id;

    await db.query(
      `
        update public.purchase_order_lines
        set quantity_received = quantity_received + $3,
            updated_at = now()
        where tenant_id = $1
          and id = $2
      `,
      [ctx.tenantId, purchaseOrderLine.id, line.quantityReceived],
    );

    const movementResult = await db.query<{ id: string }>(
      `
        insert into public.inventory_movements (
          tenant_id,
          shopify_variant_id,
          sku,
          title,
          movement_type,
          quantity_delta,
          reservation_delta,
          source_type,
          source_id
        )
        values ($1, $2, $3, $4, 'GOODS_RECEIPT', $5, 0, 'GOODS_RECEIPT_LINE', $6)
        returning id
      `,
      [
        ctx.tenantId,
        purchaseOrderLine.shopify_variant_id,
        purchaseOrderLine.sku,
        purchaseOrderLine.title,
        line.quantityReceived,
        receiptLineId,
      ],
    );
    const movementId = movementResult.rows[0]!.id;

    await createDomainEvent(db, ctx, {
      eventType: "INVENTORY_MOVEMENT_CREATED",
      aggregateType: "inventory_movement",
      aggregateId: movementId,
      payload: {
        inventory_movement_id: movementId,
        movement_type: "GOODS_RECEIPT",
        sku: purchaseOrderLine.sku,
        quantity_delta: line.quantityReceived,
        reservation_delta: 0,
        source_type: "GOODS_RECEIPT_LINE",
        source_id: receiptLineId,
      },
    });

    if (purchaseOrderLine.purchase_need_id) {
      const needResult = await db.query<{
        quantity_needed: string;
        quantity_covered: string;
      }>(
        `
          update public.purchase_needs
          set quantity_covered = quantity_covered + $3,
              updated_at = now()
          where tenant_id = $1
            and id = $2
          returning quantity_needed, quantity_covered
        `,
        [
          ctx.tenantId,
          purchaseOrderLine.purchase_need_id,
          line.quantityReceived,
        ],
      );
      const need = needResult.rows[0];

      if (need) {
        const nextStatus =
          toNumber(need.quantity_covered) >= toNumber(need.quantity_needed)
            ? "COVERED"
            : "PARTIALLY_COVERED";

        await db.query(
          `
            update public.purchase_needs
            set status = $3,
                updated_at = now()
            where tenant_id = $1
              and id = $2
          `,
          [ctx.tenantId, purchaseOrderLine.purchase_need_id, nextStatus],
        );
      }
    }

    eventLines.push({
      purchase_order_line_id: purchaseOrderLine.id,
      shopify_variant_id: purchaseOrderLine.shopify_variant_id,
      sku: purchaseOrderLine.sku,
      quantity_received: line.quantityReceived,
    });
  }

  const totalsResult = await db.query<{
    remaining_quantity: string;
    received_quantity: string;
  }>(
    `
      select
        coalesce(sum(quantity_ordered - quantity_received), 0)::text as remaining_quantity,
        coalesce(sum(quantity_received), 0)::text as received_quantity
      from public.purchase_order_lines
      where tenant_id = $1
        and purchase_order_id = $2
    `,
    [ctx.tenantId, input.purchaseOrderId],
  );
  const remainingQuantity = toNumber(totalsResult.rows[0]?.remaining_quantity);
  const receivedQuantity = toNumber(totalsResult.rows[0]?.received_quantity);
  const purchaseOrderStatus =
    remainingQuantity === 0 ? "FULLY_RECEIVED" : "PARTIALLY_RECEIVED";

  if (receivedQuantity === 0) {
    throw new Error("Goods receipt did not receive any quantity");
  }

  await db.query(
    `
      update public.purchase_orders
      set status = $3,
          updated_at = now()
      where tenant_id = $1
        and id = $2
    `,
    [ctx.tenantId, input.purchaseOrderId, purchaseOrderStatus],
  );

  await createDomainEvent(db, ctx, {
    eventType: "GOODS_RECEIVED",
    aggregateType: "goods_receipt",
    aggregateId: goodsReceiptId,
    payload: {
      goods_receipt_id: goodsReceiptId,
      purchase_order_id: input.purchaseOrderId,
      lines: eventLines,
    },
  });

  return {
    goodsReceiptId,
    purchaseOrderStatus,
  };
}
