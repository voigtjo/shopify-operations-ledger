import type { QueryExecutor } from "./foundation-db.server";

export type ItemType = "product" | "component" | "raw_material" | "assembly";

export interface MaterialTenantContext {
  tenantId: string;
}

export interface MaterialDemandLine {
  operationsOrderLineId: string;
  itemId: string;
  itemType: ItemType;
  shopifyVariantId: string | null;
  sku: string | null;
  title: string;
  demandType: "direct" | "production" | "component";
  requiredQuantity: number;
  availableQuantity: number;
  shortageQuantity: number;
}

function toNumber(value: string | number | null | undefined) {
  return Number(value ?? 0);
}

export function explodeBomLines(
  parentQuantity: number,
  lines: Array<{ componentItemId: string; quantity: number }>,
) {
  return lines.map((line) => ({
    componentItemId: line.componentItemId,
    requiredQuantity: parentQuantity * line.quantity,
  }));
}

export async function ensureItemForShopifyVariant(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: {
    shopifyProductId?: string | null;
    shopifyVariantId: string;
    sku?: string | null;
    itemType?: ItemType;
    unit?: string | null;
    isSellable?: boolean;
    isPurchasable?: boolean;
    isProducible?: boolean;
  },
) {
  const result = await db.query<{ id: string }>(
    `
      insert into public.items (
        tenant_id,
        shopify_product_id,
        shopify_variant_id,
        item_type,
        sku,
        unit,
        is_sellable,
        is_purchasable,
        is_producible
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      on conflict (tenant_id, shopify_variant_id)
      do update set
        shopify_product_id = coalesce(excluded.shopify_product_id, items.shopify_product_id),
        sku = coalesce(excluded.sku, items.sku),
        updated_at = now()
      returning id
    `,
    [
      ctx.tenantId,
      input.shopifyProductId ?? null,
      input.shopifyVariantId,
      input.itemType ?? "product",
      input.sku ?? null,
      input.unit ?? "pcs",
      input.isSellable ?? true,
      input.isPurchasable ?? false,
      input.isProducible ?? false,
    ],
  );

  return { itemId: result.rows[0]!.id };
}

export async function updateItemClassification(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: {
    itemId: string;
    itemType: ItemType;
    isSellable?: boolean;
    isPurchasable?: boolean;
    isProducible?: boolean;
  },
) {
  const result = await db.query<{ id: string; item_type: ItemType }>(
    `
      update public.items
      set item_type = $3,
          is_sellable = $4,
          is_purchasable = $5,
          is_producible = $6,
          updated_at = now()
      where tenant_id = $1
        and id = $2
      returning id, item_type
    `,
    [
      ctx.tenantId,
      input.itemId,
      input.itemType,
      input.isSellable ?? input.itemType === "product",
      input.isPurchasable ??
        ["component", "raw_material"].includes(input.itemType),
      input.isProducible ?? input.itemType === "assembly",
    ],
  );

  if (!result.rows[0]) {
    throw new Error("Item not found");
  }

  return { itemId: result.rows[0].id, itemType: result.rows[0].item_type };
}

export async function createBom(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: {
    parentItemId: string;
    version?: string;
    isActive?: boolean;
    lines: Array<{ componentItemId: string; quantity: number; unit?: string | null }>;
  },
) {
  if (input.lines.length === 0) {
    throw new Error("BOM requires at least one component line");
  }

  if (input.isActive ?? true) {
    await db.query(
      `
        update public.boms
        set is_active = false
        where tenant_id = $1
          and parent_item_id = $2
          and is_active = true
      `,
      [ctx.tenantId, input.parentItemId],
    );
  }

  const bomResult = await db.query<{ id: string }>(
    `
      insert into public.boms (tenant_id, parent_item_id, version, is_active)
      values ($1, $2, $3, $4)
      on conflict (tenant_id, parent_item_id, version)
      do update set is_active = excluded.is_active
      returning id
    `,
    [
      ctx.tenantId,
      input.parentItemId,
      input.version ?? "v1",
      input.isActive ?? true,
    ],
  );
  const bomId = bomResult.rows[0]!.id;

  for (const line of input.lines) {
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      throw new Error("BOM line quantity must be greater than zero");
    }

    await db.query(
      `
        insert into public.bom_lines (
          bom_id,
          component_item_id,
          quantity,
          unit
        )
        values ($1, $2, $3, $4)
        on conflict (bom_id, component_item_id)
        do update set quantity = excluded.quantity,
                      unit = excluded.unit
      `,
      [bomId, line.componentItemId, line.quantity, line.unit ?? "pcs"],
    );
  }

  return { bomId };
}

export async function getAvailableQuantity(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  itemId: string,
) {
  const itemResult = await db.query<{
    shopify_variant_id: string | null;
    sku: string | null;
  }>(
    `
      select shopify_variant_id, sku
      from public.items
      where tenant_id = $1
        and id = $2
      limit 1
    `,
    [ctx.tenantId, itemId],
  );
  const item = itemResult.rows[0];

  if (!item) {
    throw new Error("Item not found");
  }

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
        and (
          ($2::text is not null and shopify_variant_id = $2)
          or ($3::text is not null and sku = $3)
        )
    `,
    [ctx.tenantId, item.shopify_variant_id, item.sku],
  );
  const physicalQuantity = toNumber(result.rows[0]?.physical_quantity);
  const reservedQuantity = toNumber(result.rows[0]?.reserved_quantity);

  return physicalQuantity - reservedQuantity;
}

async function activeBomLinesForItem(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  itemId: string,
) {
  const result = await db.query<{
    component_item_id: string;
    item_type: ItemType;
    shopify_variant_id: string | null;
    sku: string | null;
    quantity: string;
  }>(
    `
      select bom_lines.component_item_id,
             items.item_type,
             items.shopify_variant_id,
             items.sku,
             bom_lines.quantity::text
      from public.boms
      join public.bom_lines
        on bom_lines.bom_id = boms.id
      join public.items
        on items.id = bom_lines.component_item_id
      where boms.tenant_id = $1
        and boms.parent_item_id = $2
        and boms.is_active = true
      order by bom_lines.created_at asc
    `,
    [ctx.tenantId, itemId],
  );

  return result.rows.map((line) => ({
    componentItemId: line.component_item_id,
    itemType: line.item_type,
    shopifyVariantId: line.shopify_variant_id,
    sku: line.sku,
    quantity: toNumber(line.quantity),
  }));
}

export async function calculateMaterialDemand(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  operationsOrderId: string,
): Promise<MaterialDemandLine[]> {
  const linesResult = await db.query<{
    id: string;
    item_id: string | null;
    title: string;
    quantity_required: string;
  }>(
    `
      select id, item_id, title, quantity_required::text
      from public.operations_order_lines
      where tenant_id = $1
        and operations_order_id = $2
      order by created_at asc
    `,
    [ctx.tenantId, operationsOrderId],
  );
  const demands: MaterialDemandLine[] = [];

  for (const orderLine of linesResult.rows) {
    if (!orderLine.item_id) {
      continue;
    }

    const itemResult = await db.query<{
      id: string;
      item_type: ItemType;
      shopify_variant_id: string | null;
      sku: string | null;
    }>(
      `
        select id, item_type, shopify_variant_id, sku
        from public.items
        where tenant_id = $1
          and id = $2
        limit 1
      `,
      [ctx.tenantId, orderLine.item_id],
    );
    const item = itemResult.rows[0];

    if (!item) {
      continue;
    }

    const required = toNumber(orderLine.quantity_required);
    const parentAvailable = await getAvailableQuantity(db, ctx, item.id);
    const parentShortage = Math.max(required - Math.max(parentAvailable, 0), 0);
    const bomLines = await activeBomLinesForItem(db, ctx, item.id);

    if (item.item_type === "assembly") {
      demands.push({
        operationsOrderLineId: orderLine.id,
        itemId: item.id,
        itemType: item.item_type,
        shopifyVariantId: item.shopify_variant_id,
        sku: item.sku,
        title: orderLine.title,
        demandType: "production",
        requiredQuantity: required,
        availableQuantity: Math.max(parentAvailable, 0),
        shortageQuantity: parentShortage,
      });
    }

    if (bomLines.length > 0) {
      const exploded = explodeBomLines(
        item.item_type === "assembly" ? parentShortage : required,
        bomLines,
      );

      for (const explodedLine of exploded) {
        const component = bomLines.find(
          (line) => line.componentItemId === explodedLine.componentItemId,
        )!;
        const available = await getAvailableQuantity(
          db,
          ctx,
          explodedLine.componentItemId,
        );

        demands.push({
          operationsOrderLineId: orderLine.id,
          itemId: explodedLine.componentItemId,
          itemType: component.itemType,
          shopifyVariantId: component.shopifyVariantId,
          sku: component.sku,
          title: component.sku ?? "Component",
          demandType: "component",
          requiredQuantity: explodedLine.requiredQuantity,
          availableQuantity: Math.max(available, 0),
          shortageQuantity: Math.max(
            explodedLine.requiredQuantity - Math.max(available, 0),
            0,
          ),
        });
      }
    } else if (item.item_type !== "assembly") {
      demands.push({
        operationsOrderLineId: orderLine.id,
        itemId: item.id,
        itemType: item.item_type,
        shopifyVariantId: item.shopify_variant_id,
        sku: item.sku,
        title: orderLine.title,
        demandType: "direct",
        requiredQuantity: required,
        availableQuantity: Math.max(parentAvailable, 0),
        shortageQuantity: parentShortage,
      });
    }
  }

  return demands;
}
