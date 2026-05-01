import type { QueryExecutor } from "./foundation-db.server";
import { createHash } from "node:crypto";

export type ItemType = "product" | "component" | "raw_material" | "assembly";
export type MrpRecommendedAction =
  | "none"
  | "reserve"
  | "purchase"
  | "produce"
  | "review";

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

export interface ItemSummary {
  id: string;
  shopifyProductId: string | null;
  shopifyVariantId: string;
  sku: string | null;
  itemType: ItemType;
  unit: string;
  isSellable: boolean;
  isPurchasable: boolean;
  isProducible: boolean;
  createdAt: string;
}

export interface BomSummary {
  id: string;
  parentItemId: string;
  parentSku: string | null;
  parentVariantId: string;
  version: string;
  isActive: boolean;
  lines: Array<{
    id: string;
    componentItemId: string;
    componentSku: string | null;
    componentVariantId: string;
    componentItemType: ItemType;
    quantity: number;
    unit: string;
  }>;
}

export interface MrpPreviewLine {
  id?: string;
  itemId: string;
  sku: string | null;
  itemType: ItemType;
  sourceLineId?: string | null;
  demandType?: "direct" | "production" | "component";
  demandLevel?: number;
  bomPath?: string[];
  requiredQuantity: number;
  availableQuantity: number;
  reservedQuantity?: number;
  shortageQuantity: number;
  action: MrpRecommendedAction;
  explanation?: string;
}

export interface DemoKitMrpPreview {
  mrpRunId?: string;
  status?: string;
  parent: MrpPreviewLine;
  components: MrpPreviewLine[];
}

export interface MrpNeedCommitItem {
  id: string;
  mrpRunLineId: string;
  sku: string | null;
  quantity: number;
  status: string;
  alreadyCommitted: boolean;
}

export interface MrpNeedCommitSkippedLine {
  mrpRunLineId: string;
  sku: string | null;
  recommendedAction: MrpRecommendedAction;
  reason: string;
}

export interface MrpNeedCommitResult {
  purchaseNeeds: MrpNeedCommitItem[];
  productionNeeds: MrpNeedCommitItem[];
  skippedLines: MrpNeedCommitSkippedLine[];
}

export interface BomValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

interface ItemPlanningRow {
  id: string;
  sku: string | null;
  shopify_variant_id: string;
  item_type: ItemType;
  unit: string;
  is_sellable: boolean;
  is_purchasable: boolean;
  is_producible: boolean;
}

interface BomLineInput {
  componentItemId: string;
  quantity: number;
  unit?: string | null;
}

const demoKitDefinitions = [
  {
    sku: "DEMO-KIT",
    shopifyVariantId: "demo-variant:demo-kit",
    itemType: "assembly" as const,
    isSellable: true,
    isPurchasable: false,
    isProducible: true,
    unit: "pcs",
  },
  {
    sku: "BOX",
    shopifyVariantId: "demo-variant:box",
    itemType: "component" as const,
    isSellable: false,
    isPurchasable: true,
    isProducible: false,
    unit: "pcs",
  },
  {
    sku: "COMPONENT-A",
    shopifyVariantId: "demo-variant:component-a",
    itemType: "raw_material" as const,
    isSellable: false,
    isPurchasable: true,
    isProducible: false,
    unit: "pcs",
  },
  {
    sku: "MANUAL",
    shopifyVariantId: "demo-variant:manual",
    itemType: "component" as const,
    isSellable: false,
    isPurchasable: true,
    isProducible: false,
    unit: "pcs",
  },
];

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
    unit?: string | null;
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
          unit = coalesce(nullif($7, ''), unit),
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
      input.unit?.trim() ?? null,
    ],
  );

  if (!result.rows[0]) {
    throw new Error("Item not found");
  }

  return { itemId: result.rows[0].id, itemType: result.rows[0].item_type };
}

export async function loadItemList(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  options: { limit?: number } = {},
): Promise<ItemSummary[]> {
  const result = await db.query<{
    id: string;
    shopify_product_id: string | null;
    shopify_variant_id: string;
    sku: string | null;
    item_type: ItemType;
    unit: string;
    is_sellable: boolean;
    is_purchasable: boolean;
    is_producible: boolean;
    created_at: Date;
  }>(
    `
      select id,
             shopify_product_id,
             sku,
             shopify_variant_id,
             item_type,
             unit,
             is_sellable,
             is_purchasable,
             is_producible,
             created_at
      from public.items
      where tenant_id = $1
      order by created_at desc, sku asc nulls last
      limit $2
    `,
    [ctx.tenantId, options.limit ?? 50],
  );

  return result.rows.map((item) => ({
    id: item.id,
    shopifyProductId: item.shopify_product_id,
    shopifyVariantId: item.shopify_variant_id,
    sku: item.sku,
    itemType: item.item_type,
    unit: item.unit,
    isSellable: item.is_sellable,
    isPurchasable: item.is_purchasable,
    isProducible: item.is_producible,
    createdAt: item.created_at.toISOString(),
  }));
}

async function loadItemPlanningRow(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  itemId: string,
) {
  const result = await db.query<ItemPlanningRow>(
    `
      select id,
             sku,
             item_type,
             unit,
             is_sellable,
             is_purchasable,
             is_producible
      from public.items
      where tenant_id = $1
        and id = $2
      limit 1
    `,
    [ctx.tenantId, itemId],
  );

  return result.rows[0] ?? null;
}

function lineKey(parts: unknown[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

async function activeBomEdges(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  parentOverride?: {
    parentItemId: string;
    componentItemIds: string[];
  },
) {
  const result = await db.query<{
    parent_item_id: string;
    component_item_id: string;
  }>(
    `
      select boms.parent_item_id,
             bom_lines.component_item_id
      from public.boms
      join public.bom_lines
        on bom_lines.bom_id = boms.id
      where boms.tenant_id = $1
        and boms.is_active = true
    `,
    [ctx.tenantId],
  );
  const edges = new Map<string, Set<string>>();

  for (const row of result.rows) {
    if (row.parent_item_id === parentOverride?.parentItemId) {
      continue;
    }

    const components = edges.get(row.parent_item_id) ?? new Set<string>();

    components.add(row.component_item_id);
    edges.set(row.parent_item_id, components);
  }

  if (parentOverride) {
    edges.set(parentOverride.parentItemId, new Set(parentOverride.componentItemIds));
  }

  return edges;
}

function graphHasPath(
  edges: Map<string, Set<string>>,
  fromItemId: string,
  toItemId: string,
  seen = new Set<string>(),
): boolean {
  if (fromItemId === toItemId) {
    return true;
  }

  if (seen.has(fromItemId)) {
    return false;
  }

  seen.add(fromItemId);

  for (const nextItemId of edges.get(fromItemId) ?? []) {
    if (graphHasPath(edges, nextItemId, toItemId, seen)) {
      return true;
    }
  }

  return false;
}

export async function validateBom(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: {
    parentItemId: string;
    isActive?: boolean;
    lines: BomLineInput[];
  },
): Promise<BomValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const active = input.isActive ?? true;
  const parent = await loadItemPlanningRow(db, ctx, input.parentItemId);

  if (!parent) {
    errors.push("parent_item_not_found");
  } else if (active && !parent.is_producible) {
    errors.push("active_bom_parent_not_producible");
  }

  if (input.lines.length === 0) {
    errors.push("bom_requires_component_line");
  }

  const seenComponents = new Set<string>();
  const componentIds: string[] = [];

  for (const line of input.lines) {
    if (line.componentItemId === input.parentItemId) {
      errors.push("bom_cycle_detected");
    }

    if (seenComponents.has(line.componentItemId)) {
      errors.push("duplicate_component_line");
    }

    seenComponents.add(line.componentItemId);
    componentIds.push(line.componentItemId);

    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      errors.push("invalid_quantity");
    }

    if (line.unit !== undefined && line.unit !== null && !line.unit.trim()) {
      errors.push("invalid_unit");
    }

    const component = await loadItemPlanningRow(db, ctx, line.componentItemId);

    if (!component) {
      errors.push("component_item_not_found");
    }
  }

  if (active && componentIds.length > 0) {
    const edges = await activeBomEdges(db, ctx, {
      parentItemId: input.parentItemId,
      componentItemIds: componentIds,
    });

    for (const componentItemId of componentIds) {
      if (graphHasPath(edges, componentItemId, input.parentItemId)) {
        errors.push("bom_cycle_detected");
        break;
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors: Array.from(new Set(errors)),
    warnings,
  };
}

export async function createOrUpdateBom(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: {
    parentItemId: string;
    version?: string;
    isActive?: boolean;
    lines: BomLineInput[];
  },
) {
  const validation = await validateBom(db, ctx, input);

  if (!validation.valid) {
    throw new Error(validation.errors.join(","));
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
  const componentIds = input.lines.map((line) => line.componentItemId);

  await db.query(
    `
      delete from public.bom_lines
      where bom_id = $1
        and not (component_item_id = any($2::uuid[]))
    `,
    [bomId, componentIds],
  );

  for (const line of input.lines) {
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

  return { bomId, validation };
}

export async function createBom(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: {
    parentItemId: string;
    version?: string;
    isActive?: boolean;
    lines: BomLineInput[];
  },
) {
  return createOrUpdateBom(db, ctx, input);
}

export async function loadBomList(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
): Promise<BomSummary[]> {
  const result = await db.query<{
    bom_id: string;
    parent_item_id: string;
    parent_sku: string | null;
    parent_variant_id: string;
    version: string;
    is_active: boolean;
    line_id: string | null;
    component_item_id: string | null;
    component_sku: string | null;
    component_variant_id: string | null;
    component_item_type: ItemType | null;
    quantity: string | null;
    unit: string | null;
  }>(
    `
      select boms.id as bom_id,
             boms.parent_item_id,
             parent_items.sku as parent_sku,
             parent_items.shopify_variant_id as parent_variant_id,
             boms.version,
             boms.is_active,
             bom_lines.id as line_id,
             bom_lines.component_item_id,
             component_items.sku as component_sku,
             component_items.shopify_variant_id as component_variant_id,
             component_items.item_type as component_item_type,
             bom_lines.quantity::text,
             bom_lines.unit
      from public.boms
      join public.items parent_items
        on parent_items.id = boms.parent_item_id
      left join public.bom_lines
        on bom_lines.bom_id = boms.id
      left join public.items component_items
        on component_items.id = bom_lines.component_item_id
      where boms.tenant_id = $1
      order by boms.created_at desc, bom_lines.created_at asc
    `,
    [ctx.tenantId],
  );
  const boms = new Map<string, BomSummary>();

  for (const row of result.rows) {
    const bom =
      boms.get(row.bom_id) ??
      {
        id: row.bom_id,
        parentItemId: row.parent_item_id,
        parentSku: row.parent_sku,
        parentVariantId: row.parent_variant_id,
        version: row.version,
        isActive: row.is_active,
        lines: [],
      };

    if (row.line_id && row.component_item_id && row.component_variant_id) {
      bom.lines.push({
        id: row.line_id,
        componentItemId: row.component_item_id,
        componentSku: row.component_sku,
        componentVariantId: row.component_variant_id,
        componentItemType: row.component_item_type ?? "component",
        quantity: toNumber(row.quantity),
        unit: row.unit ?? "pcs",
      });
    }

    boms.set(row.bom_id, bom);
  }

  return Array.from(boms.values());
}

export async function createDemoKitItems(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
) {
  const itemIds = new Map<string, string>();

  for (const definition of demoKitDefinitions) {
    const item = await ensureItemForShopifyVariant(db, ctx, definition);

    await updateItemClassification(db, ctx, {
      itemId: item.itemId,
      itemType: definition.itemType,
      unit: definition.unit,
      isSellable: definition.isSellable,
      isPurchasable: definition.isPurchasable,
      isProducible: definition.isProducible,
    });
    itemIds.set(definition.sku, item.itemId);
  }

  return {
    itemIds,
    count: itemIds.size,
  };
}

export async function createDemoKitBom(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
) {
  const setup = await createDemoKitItems(db, ctx);
  const parentItemId = setup.itemIds.get("DEMO-KIT");
  const boxItemId = setup.itemIds.get("BOX");
  const componentItemId = setup.itemIds.get("COMPONENT-A");
  const manualItemId = setup.itemIds.get("MANUAL");

  if (!parentItemId || !boxItemId || !componentItemId || !manualItemId) {
    throw new Error("Demo kit item setup did not create all required items");
  }

  return createBom(db, ctx, {
    parentItemId,
    version: "demo-v1",
    lines: [
      { componentItemId: boxItemId, quantity: 1, unit: "pcs" },
      { componentItemId, quantity: 2, unit: "pcs" },
      { componentItemId: manualItemId, quantity: 1, unit: "pcs" },
    ],
  });
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

function actionForPreview(input: {
  shortageQuantity: number;
  itemType: ItemType;
  isPurchasable: boolean;
  isProducible: boolean;
}): MrpPreviewLine["action"] {
  if (input.shortageQuantity <= 0) {
    return "reserve";
  }

  if (input.itemType === "assembly" && input.isProducible) {
    return "produce";
  }

  if (input.isPurchasable) {
    return "purchase";
  }

  return "review";
}

function explanationForPreview(input: {
  sku: string | null;
  requiredQuantity: number;
  availableQuantity: number;
  shortageQuantity: number;
  action: MrpRecommendedAction;
}) {
  const label = input.sku ?? "Item";

  if (input.shortageQuantity <= 0) {
    return `${label} has ${input.availableQuantity} available for ${input.requiredQuantity} required, so MRP recommends reserving available stock.`;
  }

  if (input.action === "produce") {
    return `${label} is short by ${input.shortageQuantity} and is producible, so MRP recommends production planning.`;
  }

  if (input.action === "purchase") {
    return `${label} is short by ${input.shortageQuantity} and is purchasable, so MRP recommends procurement planning.`;
  }

  return `${label} is short by ${input.shortageQuantity}, but item flags do not define a clear buy or make action, so planner review is required.`;
}

async function calculateMrpPreviewLines(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: {
    demandLines: Array<{
      sourceLineId?: string | null;
      itemId: string;
      quantity: number;
    }>;
    sourceType: string;
    sourceId: string;
    maxDepth?: number;
  },
) {
  const lines: MrpPreviewLine[] = [];
  const maxDepth = input.maxDepth ?? 5;

  async function visitDemand(demand: {
    sourceLineId?: string | null;
    itemId: string;
    quantity: number;
    demandType: "direct" | "production" | "component";
    demandLevel: number;
    bomPath: string[];
  }) {
    if (!Number.isFinite(demand.quantity) || demand.quantity <= 0) {
      throw new Error("invalid_demand_quantity");
    }

    if (demand.demandLevel > maxDepth) {
      throw new Error("max_depth_exceeded");
    }

    const item = await loadItemPlanningRow(db, ctx, demand.itemId);

    if (!item) {
      throw new Error("missing_item_mapping");
    }

    const availableQuantity = Math.max(
      await getAvailableQuantity(db, ctx, item.id),
      0,
    );
    const shortageQuantity = Math.max(demand.quantity - availableQuantity, 0);
    const action = actionForPreview({
      shortageQuantity,
      itemType: item.item_type,
      isPurchasable: item.is_purchasable,
      isProducible: item.is_producible,
    });
    const previewLine: MrpPreviewLine = {
      itemId: item.id,
      sku: item.sku,
      itemType: item.item_type,
      sourceLineId: demand.sourceLineId ?? null,
      demandType: demand.demandType,
      demandLevel: demand.demandLevel,
      bomPath: demand.bomPath,
      requiredQuantity: demand.quantity,
      availableQuantity,
      reservedQuantity: 0,
      shortageQuantity,
      action,
      explanation: explanationForPreview({
        sku: item.sku,
        requiredQuantity: demand.quantity,
        availableQuantity,
        shortageQuantity,
        action,
      }),
    };

    lines.push(previewLine);

    if (shortageQuantity <= 0) {
      return;
    }

    const bomLines = await activeBomLinesForItem(db, ctx, item.id);

    if (bomLines.length === 0) {
      return;
    }

    for (const bomLine of bomLines) {
      await visitDemand({
        sourceLineId: demand.sourceLineId,
        itemId: bomLine.componentItemId,
        quantity: shortageQuantity * bomLine.quantity,
        demandType: "component",
        demandLevel: demand.demandLevel + 1,
        bomPath: [...demand.bomPath, bomLine.componentItemId],
      });
    }
  }

  for (const demandLine of input.demandLines) {
    await visitDemand({
      sourceLineId: demandLine.sourceLineId,
      itemId: demandLine.itemId,
      quantity: demandLine.quantity,
      demandType: "direct",
      demandLevel: 0,
      bomPath: [demandLine.itemId],
    });
  }

  return lines;
}

export async function runMrpPreview(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: {
    demandSourceType: string;
    demandSourceId: string;
    idempotencyKey: string;
    demandLines: Array<{
      sourceLineId?: string | null;
      itemId: string;
      quantity: number;
    }>;
    maxDepth?: number;
  },
) {
  const runResult = await db.query<{
    id: string;
    status: string;
  }>(
    `
      insert into public.mrp_runs (
        tenant_id,
        run_number,
        status,
        demand_source_type,
        demand_source_id,
        idempotency_key,
        started_at
      )
      values (
        $1,
        'MRP-' || to_char(now(), 'YYYYMMDDHH24MISSMS'),
        'running',
        $2,
        $3,
        $4,
        now()
      )
      on conflict (tenant_id, idempotency_key)
      do update set status = 'running',
                    demand_source_type = excluded.demand_source_type,
                    demand_source_id = excluded.demand_source_id,
                    error_message = null,
                    started_at = now(),
                    completed_at = null
      returning id, status
    `,
    [
      ctx.tenantId,
      input.demandSourceType,
      input.demandSourceId,
      input.idempotencyKey,
    ],
  );
  const mrpRunId = runResult.rows[0]!.id;

  try {
    const previewLines = await calculateMrpPreviewLines(db, ctx, {
      demandLines: input.demandLines,
      sourceType: input.demandSourceType,
      sourceId: input.demandSourceId,
      maxDepth: input.maxDepth,
    });

    await db.query("delete from public.mrp_run_lines where mrp_run_id = $1", [
      mrpRunId,
    ]);

    let lineNumber = 1;

    for (const line of previewLines) {
      const bomPath = line.bomPath ?? [line.itemId];
      const key = lineKey([
        input.demandSourceType,
        input.demandSourceId,
        line.itemId,
        line.demandLevel ?? 0,
        bomPath,
        lineNumber,
      ]);
      const inserted = await db.query<{ id: string }>(
        `
          insert into public.mrp_run_lines (
            tenant_id,
            mrp_run_id,
            line_number,
            line_key,
            item_id,
            source_type,
            source_id,
            source_line_id,
            demand_type,
            demand_level,
            bom_path,
            required_quantity,
            available_quantity,
            reserved_quantity,
            shortage_quantity,
            recommended_action,
            explanation
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17)
          returning id
        `,
        [
          ctx.tenantId,
          mrpRunId,
          lineNumber,
          key,
          line.itemId,
          input.demandSourceType,
          input.demandSourceId,
          line.sourceLineId ?? null,
          line.demandType ?? "direct",
          line.demandLevel ?? 0,
          JSON.stringify(bomPath),
          line.requiredQuantity,
          line.availableQuantity,
          line.reservedQuantity ?? 0,
          line.shortageQuantity,
          line.action,
          line.explanation ?? "",
        ],
      );

      line.id = inserted.rows[0]!.id;
      lineNumber += 1;
    }

    await db.query(
      `
        update public.mrp_runs
        set status = 'completed',
            completed_at = now()
        where tenant_id = $1
          and id = $2
      `,
      [ctx.tenantId, mrpRunId],
    );

    return {
      mrpRunId,
      status: "completed",
      lines: previewLines,
      sideEffects: {
        purchaseNeedsCreated: 0,
        productionNeedsCreated: 0,
        caseTasksCreated: 0,
        caseDecisionsCreated: 0,
      },
    };
  } catch (error) {
    await db.query(
      `
        update public.mrp_runs
        set status = 'failed',
            error_message = $3,
            completed_at = now()
        where tenant_id = $1
          and id = $2
      `,
      [ctx.tenantId, mrpRunId, error instanceof Error ? error.message : "MRP preview failed"],
    );
    throw error;
  }
}

export async function runDemoKitMrpPreview(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  quantity = 1,
): Promise<DemoKitMrpPreview | null> {
  const parentResult = await db.query<{ id: string }>(
    `
      select id
      from public.items
      where tenant_id = $1
        and sku = 'DEMO-KIT'
      limit 1
    `,
    [ctx.tenantId],
  );
  const parentItem = parentResult.rows[0];

  if (!parentItem) {
    return null;
  }

  const result = await runMrpPreview(db, ctx, {
    demandSourceType: "demo",
    demandSourceId: "demo-kit",
    idempotencyKey: `mrp_preview:demo-kit:${quantity}`,
    demandLines: [{ itemId: parentItem.id, quantity }],
  });
  const [parent, ...components] = result.lines;

  if (!parent) {
    return null;
  }

  return {
    mrpRunId: result.mrpRunId,
    status: result.status,
    parent,
    components,
  };
}

export async function previewDemoKitMrp(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  quantity = 1,
) {
  return runDemoKitMrpPreview(db, ctx, quantity);
}

export async function loadLatestDemoKitMrpPreview(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
): Promise<DemoKitMrpPreview | null> {
  const runResult = await db.query<{ id: string; status: string }>(
    `
      select id, status
      from public.mrp_runs
      where tenant_id = $1
        and idempotency_key like 'mrp_preview:demo-kit:%'
      order by updated_at desc
      limit 1
    `,
    [ctx.tenantId],
  );
  const run = runResult.rows[0];

  if (!run) {
    return null;
  }

  const lineResult = await db.query<{
    id: string;
    item_id: string;
    sku: string | null;
    item_type: ItemType;
    demand_type: "direct" | "production" | "component";
    demand_level: number;
    bom_path: string[];
    required_quantity: string;
    available_quantity: string;
    reserved_quantity: string;
    shortage_quantity: string;
    recommended_action: MrpRecommendedAction;
    explanation: string;
  }>(
    `
      select mrp_run_lines.id,
             mrp_run_lines.item_id,
             items.sku,
             items.item_type,
             mrp_run_lines.demand_type,
             mrp_run_lines.demand_level,
             mrp_run_lines.bom_path,
             mrp_run_lines.required_quantity::text,
             mrp_run_lines.available_quantity::text,
             mrp_run_lines.reserved_quantity::text,
             mrp_run_lines.shortage_quantity::text,
             mrp_run_lines.recommended_action,
             mrp_run_lines.explanation
      from public.mrp_run_lines
      join public.items
        on items.id = mrp_run_lines.item_id
      where mrp_run_lines.tenant_id = $1
        and mrp_run_lines.mrp_run_id = $2
      order by mrp_run_lines.line_number asc
    `,
    [ctx.tenantId, run.id],
  );
  const lines = lineResult.rows.map((line) => ({
    id: line.id,
    itemId: line.item_id,
    sku: line.sku,
    itemType: line.item_type,
    demandType: line.demand_type,
    demandLevel: line.demand_level,
    bomPath: line.bom_path,
    requiredQuantity: toNumber(line.required_quantity),
    availableQuantity: toNumber(line.available_quantity),
    reservedQuantity: toNumber(line.reserved_quantity),
    shortageQuantity: toNumber(line.shortage_quantity),
    action: line.recommended_action,
    explanation: line.explanation,
  }));
  const [parent, ...components] = lines;

  if (!parent) {
    return null;
  }

  return {
    mrpRunId: run.id,
    status: run.status,
    parent,
    components,
  };
}

async function loadCompletedMrpRunLinesForCommit(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  mrpRunId: string,
) {
  const run = await db.query<{ id: string; status: string }>(
    `
      select id, status
      from public.mrp_runs
      where tenant_id = $1
        and id = $2
      limit 1
    `,
    [ctx.tenantId, mrpRunId],
  );

  if (!run.rows[0]) {
    throw new Error("mrp_run_not_found");
  }

  if (run.rows[0].status !== "completed") {
    throw new Error("mrp_run_not_completed");
  }

  const lines = await db.query<{
    id: string;
    item_id: string;
    sku: string | null;
    shopify_variant_id: string | null;
    item_type: ItemType;
    is_purchasable: boolean;
    is_producible: boolean;
    shortage_quantity: string;
    recommended_action: MrpRecommendedAction;
    explanation: string;
  }>(
    `
      select mrp_run_lines.id,
             mrp_run_lines.item_id,
             items.sku,
             items.shopify_variant_id,
             items.item_type,
             items.is_purchasable,
             items.is_producible,
             mrp_run_lines.shortage_quantity::text,
             mrp_run_lines.recommended_action,
             mrp_run_lines.explanation
      from public.mrp_run_lines
      join public.items
        on items.id = mrp_run_lines.item_id
      where mrp_run_lines.tenant_id = $1
        and mrp_run_lines.mrp_run_id = $2
      order by mrp_run_lines.line_number asc
    `,
    [ctx.tenantId, mrpRunId],
  );

  return lines.rows;
}

export async function createPurchaseNeedsFromMrp(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: { mrpRunId: string },
) {
  const lines = await loadCompletedMrpRunLinesForCommit(
    db,
    ctx,
    input.mrpRunId,
  );
  const purchaseNeeds: MrpNeedCommitItem[] = [];
  const skippedLines: MrpNeedCommitSkippedLine[] = [];

  for (const line of lines) {
    const shortageQuantity = toNumber(line.shortage_quantity);

    if (line.recommended_action !== "purchase" || shortageQuantity <= 0) {
      skippedLines.push({
        mrpRunLineId: line.id,
        sku: line.sku,
        recommendedAction: line.recommended_action,
        reason:
          shortageQuantity <= 0
            ? "no_shortage"
            : "recommended_action_not_purchase",
      });
      continue;
    }

    if (!line.is_purchasable) {
      skippedLines.push({
        mrpRunLineId: line.id,
        sku: line.sku,
        recommendedAction: line.recommended_action,
        reason: "item_not_purchasable",
      });
      continue;
    }

    const existing = await db.query<{
      id: string;
      status: string;
    }>(
      `
        select id, status
        from public.purchase_needs
        where tenant_id = $1
          and item_id = $2
          and source_type = 'mrp_run_line'
          and source_id = $3
          and status in ('open', 'linked_to_po', 'partially_covered')
        limit 1
      `,
      [ctx.tenantId, line.item_id, line.id],
    );

    if (existing.rows[0]) {
      await db.query(
        `
          update public.purchase_needs
          set quantity_needed = $3,
              updated_at = now()
          where tenant_id = $1
            and id = $2
            and status = 'open'
        `,
        [ctx.tenantId, existing.rows[0].id, shortageQuantity],
      );
      await db.query(
        `
          update public.mrp_run_lines
          set purchase_need_id = $3
          where tenant_id = $1
            and id = $2
        `,
        [ctx.tenantId, line.id, existing.rows[0].id],
      );
      purchaseNeeds.push({
        id: existing.rows[0].id,
        mrpRunLineId: line.id,
        sku: line.sku,
        quantity: shortageQuantity,
        status: existing.rows[0].status,
        alreadyCommitted: true,
      });
      continue;
    }

    const created = await db.query<{ id: string; status: string }>(
      `
        insert into public.purchase_needs (
          tenant_id,
          item_id,
          shopify_variant_id,
          sku,
          title,
          quantity_needed,
          status,
          reason,
          source_type,
          source_id,
          mrp_run_line_id
        )
        values ($1, $2, $3, $4, $5, $6, 'open', 'mrp_shortage', 'mrp_run_line', $7, $8)
        returning id, status
      `,
      [
        ctx.tenantId,
        line.item_id,
        line.shopify_variant_id,
        line.sku,
        line.sku ?? "MRP purchase need",
        shortageQuantity,
        line.id,
        line.id,
      ],
    );

    await db.query(
      `
        update public.mrp_run_lines
        set purchase_need_id = $3
        where tenant_id = $1
          and id = $2
      `,
      [ctx.tenantId, line.id, created.rows[0]!.id],
    );

    purchaseNeeds.push({
      id: created.rows[0]!.id,
      mrpRunLineId: line.id,
      sku: line.sku,
      quantity: shortageQuantity,
      status: created.rows[0]!.status,
      alreadyCommitted: false,
    });
  }

  return { purchaseNeeds, skippedLines };
}

export async function createProductionNeedsFromMrp(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: { mrpRunId: string },
) {
  const lines = await loadCompletedMrpRunLinesForCommit(
    db,
    ctx,
    input.mrpRunId,
  );
  const productionNeeds: MrpNeedCommitItem[] = [];
  const skippedLines: MrpNeedCommitSkippedLine[] = [];

  for (const line of lines) {
    const shortageQuantity = toNumber(line.shortage_quantity);

    if (line.recommended_action !== "produce" || shortageQuantity <= 0) {
      skippedLines.push({
        mrpRunLineId: line.id,
        sku: line.sku,
        recommendedAction: line.recommended_action,
        reason:
          shortageQuantity <= 0
            ? "no_shortage"
            : "recommended_action_not_produce",
      });
      continue;
    }

    if (!line.is_producible) {
      skippedLines.push({
        mrpRunLineId: line.id,
        sku: line.sku,
        recommendedAction: line.recommended_action,
        reason: "item_not_producible",
      });
      continue;
    }

    const existing = await db.query<{ id: string; status: string }>(
      `
        select id, status
        from public.production_needs
        where tenant_id = $1
          and item_id = $2
          and source_type = 'mrp_run_line'
          and source_id = $3
          and status = 'pending'
        limit 1
      `,
      [ctx.tenantId, line.item_id, line.id],
    );

    if (existing.rows[0]) {
      await db.query(
        `
          update public.production_needs
          set required_quantity = $3,
              updated_at = now()
          where tenant_id = $1
            and id = $2
            and status = 'pending'
        `,
        [ctx.tenantId, existing.rows[0].id, shortageQuantity],
      );
      await db.query(
        `
          update public.mrp_run_lines
          set production_need_id = $3
          where tenant_id = $1
            and id = $2
        `,
        [ctx.tenantId, line.id, existing.rows[0].id],
      );
      productionNeeds.push({
        id: existing.rows[0].id,
        mrpRunLineId: line.id,
        sku: line.sku,
        quantity: shortageQuantity,
        status: existing.rows[0].status,
        alreadyCommitted: true,
      });
      continue;
    }

    const created = await db.query<{ id: string; status: string }>(
      `
        insert into public.production_needs (
          tenant_id,
          item_id,
          required_quantity,
          status,
          reference_type,
          reference_id,
          source_type,
          source_id,
          mrp_run_line_id
        )
        values ($1, $2, $3, 'pending', 'mrp_run_line', $4::uuid, 'mrp_run_line', $4::text, $4::uuid)
        returning id, status
      `,
      [ctx.tenantId, line.item_id, shortageQuantity, line.id],
    );

    await db.query(
      `
        update public.mrp_run_lines
        set production_need_id = $3
        where tenant_id = $1
          and id = $2
      `,
      [ctx.tenantId, line.id, created.rows[0]!.id],
    );

    productionNeeds.push({
      id: created.rows[0]!.id,
      mrpRunLineId: line.id,
      sku: line.sku,
      quantity: shortageQuantity,
      status: created.rows[0]!.status,
      alreadyCommitted: false,
    });
  }

  return { productionNeeds, skippedLines };
}

export async function commitMrpRunNeeds(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: { mrpRunId: string },
): Promise<MrpNeedCommitResult> {
  const purchaseResult = await createPurchaseNeedsFromMrp(db, ctx, input);
  const productionResult = await createProductionNeedsFromMrp(db, ctx, input);
  const skippedLinesById = new Map<string, MrpNeedCommitSkippedLine>();

  for (const line of [
    ...purchaseResult.skippedLines,
    ...productionResult.skippedLines,
  ]) {
    if (
      line.reason === "recommended_action_not_purchase" ||
      line.reason === "recommended_action_not_produce"
    ) {
      continue;
    }

    skippedLinesById.set(line.mrpRunLineId, line);
  }

  return {
    purchaseNeeds: purchaseResult.purchaseNeeds,
    productionNeeds: productionResult.productionNeeds,
    skippedLines: Array.from(skippedLinesById.values()),
  };
}

export async function loadItemDetail(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  itemId: string,
) {
  const item = await loadItemPlanningRow(db, ctx, itemId);

  if (!item) {
    throw new Error("item_not_found");
  }

  const availableQuantity = await getAvailableQuantity(db, ctx, itemId);
  const relatedBom = await db.query<{
    id: string;
    version: string;
    is_active: boolean;
  }>(
    `
      select id, version, is_active
      from public.boms
      where tenant_id = $1
        and parent_item_id = $2
      order by is_active desc, created_at desc
      limit 1
    `,
    [ctx.tenantId, itemId],
  );
  const mrpLines = await db.query<{
    id: string;
    mrp_run_id: string;
    required_quantity: string;
    shortage_quantity: string;
    recommended_action: MrpRecommendedAction;
    created_at: Date;
  }>(
    `
      select id,
             mrp_run_id,
             required_quantity::text,
             shortage_quantity::text,
             recommended_action,
             created_at
      from public.mrp_run_lines
      where tenant_id = $1
        and item_id = $2
      order by created_at desc
      limit 10
    `,
    [ctx.tenantId, itemId],
  );

  return {
    id: item.id,
    sku: item.sku,
    shopifyVariantId: item.shopify_variant_id,
    itemType: item.item_type,
    unit: item.unit,
    isSellable: item.is_sellable,
    isPurchasable: item.is_purchasable,
    isProducible: item.is_producible,
    canBeBomParent: item.is_producible,
    canBeComponent: item.item_type !== "product" || item.is_purchasable,
    availableQuantity,
    relatedBom: relatedBom.rows[0] ?? null,
    mrpLines: mrpLines.rows.map((line) => ({
      id: line.id,
      mrpRunId: line.mrp_run_id,
      requiredQuantity: toNumber(line.required_quantity),
      shortageQuantity: toNumber(line.shortage_quantity),
      recommendedAction: line.recommended_action,
      createdAt: line.created_at.toISOString(),
    })),
  };
}

export async function loadBomDetail(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  bomId: string,
) {
  const bom = await db.query<{
    id: string;
    parent_item_id: string;
    parent_sku: string | null;
    parent_item_type: ItemType;
    parent_is_producible: boolean;
    version: string;
    is_active: boolean;
  }>(
    `
      select boms.id,
             boms.parent_item_id,
             items.sku as parent_sku,
             items.item_type as parent_item_type,
             items.is_producible as parent_is_producible,
             boms.version,
             boms.is_active
      from public.boms
      join public.items
        on items.id = boms.parent_item_id
      where boms.tenant_id = $1
        and boms.id = $2
      limit 1
    `,
    [ctx.tenantId, bomId],
  );
  const row = bom.rows[0];

  if (!row) {
    throw new Error("bom_not_found");
  }

  const lines = await db.query<{
    id: string;
    component_item_id: string;
    sku: string | null;
    item_type: ItemType;
    quantity: string;
    unit: string;
  }>(
    `
      select bom_lines.id,
             bom_lines.component_item_id,
             items.sku,
             items.item_type,
             bom_lines.quantity::text,
             bom_lines.unit
      from public.bom_lines
      join public.items
        on items.id = bom_lines.component_item_id
      where bom_lines.bom_id = $1
      order by bom_lines.created_at asc
    `,
    [bomId],
  );
  const validation = await validateBom(db, ctx, {
    parentItemId: row.parent_item_id,
    isActive: row.is_active,
    lines: lines.rows.map((line) => ({
      componentItemId: line.component_item_id,
      quantity: toNumber(line.quantity),
      unit: line.unit,
    })),
  });

  return {
    id: row.id,
    parentItemId: row.parent_item_id,
    parentSku: row.parent_sku,
    parentItemType: row.parent_item_type,
    parentIsProducible: row.parent_is_producible,
    version: row.version,
    isActive: row.is_active,
    validation,
    lines: lines.rows.map((line) => ({
      id: line.id,
      componentItemId: line.component_item_id,
      componentSku: line.sku,
      componentItemType: line.item_type,
      quantity: toNumber(line.quantity),
      unit: line.unit,
    })),
  };
}

export async function loadMrpRunList(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  options: { limit?: number } = {},
) {
  const runs = await db.query<{
    id: string;
    run_number: string;
    status: string;
    created_at: Date;
    line_count: string;
    committed_count: string;
  }>(
    `
      select mrp_runs.id,
             mrp_runs.run_number,
             mrp_runs.status,
             mrp_runs.created_at,
             count(mrp_run_lines.id)::text as line_count,
             count(mrp_run_lines.id) filter (
               where mrp_run_lines.purchase_need_id is not null
                  or mrp_run_lines.production_need_id is not null
             )::text as committed_count
      from public.mrp_runs
      left join public.mrp_run_lines
        on mrp_run_lines.mrp_run_id = mrp_runs.id
      where mrp_runs.tenant_id = $1
      group by mrp_runs.id
      order by mrp_runs.created_at desc
      limit $2
    `,
    [ctx.tenantId, options.limit ?? 25],
  );

  return runs.rows.map((run) => ({
    id: run.id,
    runNumber: run.run_number,
    status: run.status,
    createdAt: run.created_at.toISOString(),
    lineCount: toNumber(run.line_count),
    committedCount: toNumber(run.committed_count),
    needsCommitted: toNumber(run.committed_count) > 0,
  }));
}

export async function loadMrpRunDetail(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  mrpRunId: string,
) {
  const run = await db.query<{
    id: string;
    run_number: string;
    status: string;
    demand_source_type: string;
    demand_source_id: string;
    created_at: Date;
  }>(
    `
      select id, run_number, status, demand_source_type, demand_source_id, created_at
      from public.mrp_runs
      where tenant_id = $1
        and id = $2
      limit 1
    `,
    [ctx.tenantId, mrpRunId],
  );
  const row = run.rows[0];

  if (!row) {
    throw new Error("mrp_run_not_found");
  }

  const lines = await db.query<{
    id: string;
    item_id: string;
    sku: string | null;
    required_quantity: string;
    available_quantity: string;
    reserved_quantity: string;
    shortage_quantity: string;
    recommended_action: MrpRecommendedAction;
    explanation: string;
    purchase_need_id: string | null;
    production_need_id: string | null;
  }>(
    `
      select mrp_run_lines.id,
             mrp_run_lines.item_id,
             items.sku,
             mrp_run_lines.required_quantity::text,
             mrp_run_lines.available_quantity::text,
             mrp_run_lines.reserved_quantity::text,
             mrp_run_lines.shortage_quantity::text,
             mrp_run_lines.recommended_action,
             mrp_run_lines.explanation,
             mrp_run_lines.purchase_need_id,
             mrp_run_lines.production_need_id
      from public.mrp_run_lines
      join public.items
        on items.id = mrp_run_lines.item_id
      where mrp_run_lines.tenant_id = $1
        and mrp_run_lines.mrp_run_id = $2
      order by mrp_run_lines.line_number asc
    `,
    [ctx.tenantId, mrpRunId],
  );

  return {
    id: row.id,
    runNumber: row.run_number,
    status: row.status,
    demandSourceType: row.demand_source_type,
    demandSourceId: row.demand_source_id,
    createdAt: row.created_at.toISOString(),
    lines: lines.rows.map((line) => ({
      id: line.id,
      itemId: line.item_id,
      sku: line.sku,
      requiredQuantity: toNumber(line.required_quantity),
      availableQuantity: toNumber(line.available_quantity),
      reservedQuantity: toNumber(line.reserved_quantity),
      shortageQuantity: toNumber(line.shortage_quantity),
      recommendedAction: line.recommended_action,
      explanation: line.explanation,
      purchaseNeedId: line.purchase_need_id,
      productionNeedId: line.production_need_id,
      committed: Boolean(line.purchase_need_id || line.production_need_id),
    })),
  };
}

export async function loadNeedsBoard(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
) {
  const purchaseNeeds = await db.query<{
    id: string;
    item_id: string | null;
    sku: string | null;
    title: string;
    quantity_needed: string;
    quantity_covered: string;
    status: string;
    source_id: string | null;
    mrp_run_id: string | null;
    created_at: Date;
  }>(
    `
      select purchase_needs.id,
             purchase_needs.item_id,
             purchase_needs.sku,
             purchase_needs.title,
             purchase_needs.quantity_needed::text,
             purchase_needs.quantity_covered::text,
             purchase_needs.status,
             purchase_needs.source_id,
             mrp_run_lines.mrp_run_id,
             purchase_needs.created_at
      from public.purchase_needs
      left join public.mrp_run_lines
        on mrp_run_lines.id = purchase_needs.mrp_run_line_id
      where purchase_needs.tenant_id = $1
      order by purchase_needs.created_at desc
      limit 50
    `,
    [ctx.tenantId],
  );
  const productionNeeds = await db.query<{
    id: string;
    item_id: string;
    sku: string | null;
    required_quantity: string;
    status: string;
    source_id: string | null;
    mrp_run_id: string | null;
    created_at: Date;
  }>(
    `
      select production_needs.id,
             production_needs.item_id,
             items.sku,
             production_needs.required_quantity::text,
             production_needs.status,
             production_needs.source_id,
             mrp_run_lines.mrp_run_id,
             production_needs.created_at
      from public.production_needs
      join public.items
        on items.id = production_needs.item_id
      left join public.mrp_run_lines
        on mrp_run_lines.id = production_needs.mrp_run_line_id
      where production_needs.tenant_id = $1
      order by production_needs.created_at desc
      limit 50
    `,
    [ctx.tenantId],
  );

  return {
    purchaseNeeds: purchaseNeeds.rows.map((need) => ({
      id: need.id,
      itemId: need.item_id,
      sku: need.sku,
      title: need.title,
      quantityNeeded: toNumber(need.quantity_needed),
      quantityCovered: toNumber(need.quantity_covered),
      status: need.status,
      sourceId: need.source_id,
      mrpRunId: need.mrp_run_id,
      createdAt: need.created_at.toISOString(),
    })),
    productionNeeds: productionNeeds.rows.map((need) => ({
      id: need.id,
      itemId: need.item_id,
      sku: need.sku,
      requiredQuantity: toNumber(need.required_quantity),
      status: need.status,
      sourceId: need.source_id,
      mrpRunId: need.mrp_run_id,
      createdAt: need.created_at.toISOString(),
    })),
  };
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
