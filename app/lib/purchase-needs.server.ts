import type { QueryExecutor } from "./foundation-db.server";
import type { MaterialTenantContext } from "./material-planning.server";

export type PurchaseNeedsBoardFilter =
  | "open"
  | "assigned"
  | "ready_for_po"
  | "all";

export interface SupplierOption {
  id: string;
  name: string;
  email: string | null;
  active: boolean;
  linkedItemCount?: number;
  openPurchaseNeedCount?: number;
}

export interface SupplierItemLink {
  id: string;
  supplierId: string;
  supplierName: string;
  supplierActive: boolean;
  itemId: string;
  itemSku: string | null;
  supplierSku: string | null;
  purchaseUnit: string;
  isPreferred: boolean;
  active: boolean;
}

export interface PurchaseNeedBoardRow {
  id: string;
  itemId: string | null;
  sku: string | null;
  title: string;
  quantityNeeded: number;
  quantityCovered: number;
  status: string;
  sourceId: string | null;
  mrpRunId: string | null;
  recommendedSupplierId: string | null;
  recommendedSupplierName: string | null;
  assignedSupplierId: string | null;
  assignedSupplierName: string | null;
  assignedSupplierEmail: string | null;
  readyForPoDraftAt: string | null;
  createdAt: string;
}

export interface ProductionNeedBoardRow {
  id: string;
  itemId: string;
  sku: string | null;
  requiredQuantity: number;
  status: string;
  sourceId: string | null;
  mrpRunId: string | null;
  createdAt: string;
}

export interface PurchaseOrderDraftPreviewGroup {
  supplierId: string;
  supplierName: string;
  supplierEmail: string | null;
  needCount: number;
  totalQuantity: number;
  lines: Array<{
    purchaseNeedId: string;
    itemId: string | null;
    sku: string | null;
    title: string;
    quantityNeeded: number;
    quantityCovered: number;
    quantityToOrder: number;
    sourceMrpRunId: string | null;
  }>;
}

function toNumber(value: string | number | null | undefined) {
  return Number(value ?? 0);
}

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function activePurchaseNeedStatusSql() {
  return "lower(purchase_needs.status) in ('open', 'linked_to_po', 'partially_covered')";
}

function filterWhereClause(filter: PurchaseNeedsBoardFilter) {
  if (filter === "assigned") {
    return `and purchase_needs.assigned_supplier_id is not null
            and purchase_needs.ready_for_po_draft_at is null
            and ${activePurchaseNeedStatusSql()}`;
  }

  if (filter === "ready_for_po") {
    return `and purchase_needs.assigned_supplier_id is not null
            and purchase_needs.ready_for_po_draft_at is not null
            and ${activePurchaseNeedStatusSql()}`;
  }

  if (filter === "open") {
    return `and purchase_needs.ready_for_po_draft_at is null
            and ${activePurchaseNeedStatusSql()}`;
  }

  return "";
}

export async function listSuppliers(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
): Promise<SupplierOption[]> {
  const result = await db.query<{
    id: string;
    name: string;
    email: string | null;
    active: boolean;
    linked_item_count: string;
    open_purchase_need_count: string;
  }>(
    `
      select suppliers.id,
             suppliers.name,
             suppliers.email,
             suppliers.active,
             count(distinct supplier_items.item_id) filter (
               where supplier_items.active = true
             )::text as linked_item_count,
             count(distinct purchase_needs.id) filter (
               where ${activePurchaseNeedStatusSql()}
             )::text as open_purchase_need_count
      from public.suppliers
      left join public.supplier_items
        on supplier_items.supplier_id = suppliers.id
      left join public.purchase_needs
        on purchase_needs.assigned_supplier_id = suppliers.id
       and purchase_needs.tenant_id = suppliers.tenant_id
      where suppliers.tenant_id = $1
      group by suppliers.id
      order by suppliers.active desc, suppliers.name asc
    `,
    [ctx.tenantId],
  );

  return result.rows.map((supplier) => ({
    id: supplier.id,
    name: supplier.name,
    email: supplier.email,
    active: supplier.active,
    linkedItemCount: toNumber(supplier.linked_item_count),
    openPurchaseNeedCount: toNumber(supplier.open_purchase_need_count),
  }));
}

export async function createSupplier(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: { name: string; email?: string | null },
): Promise<SupplierOption> {
  const name = normalizeName(input.name);

  if (!name) {
    throw new Error("supplier_name_required");
  }

  const result = await db.query<{
    id: string;
    name: string;
    email: string | null;
    active: boolean;
  }>(
    `
      insert into public.suppliers (tenant_id, name, email, active)
      values ($1, $2, $3, true)
      on conflict (tenant_id, name)
      do update
      set email = coalesce(excluded.email, public.suppliers.email),
          active = true,
          updated_at = now()
      returning id, name, email, active
    `,
    [ctx.tenantId, name, input.email?.trim() || null],
  );

  return {
    id: result.rows[0]!.id,
    name: result.rows[0]!.name,
    email: result.rows[0]!.email,
    active: result.rows[0]!.active,
  };
}

export async function updateSupplier(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: { supplierId: string; name: string; email?: string | null },
): Promise<SupplierOption> {
  const name = normalizeName(input.name);

  if (!name) {
    throw new Error("supplier_name_required");
  }

  const result = await db.query<{
    id: string;
    name: string;
    email: string | null;
    active: boolean;
  }>(
    `
      update public.suppliers
      set name = $3,
          email = $4,
          updated_at = now()
      where tenant_id = $1
        and id = $2
      returning id, name, email, active
    `,
    [ctx.tenantId, input.supplierId, name, input.email?.trim() || null],
  );

  if (!result.rows[0]) {
    throw new Error("supplier_not_found");
  }

  return {
    id: result.rows[0].id,
    name: result.rows[0].name,
    email: result.rows[0].email,
    active: result.rows[0].active,
  };
}

export async function setSupplierActive(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: { supplierId: string; active: boolean },
) {
  const result = await db.query<{ id: string; active: boolean }>(
    `
      update public.suppliers
      set active = $3,
          updated_at = now()
      where tenant_id = $1
        and id = $2
      returning id, active
    `,
    [ctx.tenantId, input.supplierId, input.active],
  );

  if (!result.rows[0]) {
    throw new Error("supplier_not_found");
  }

  return {
    supplierId: result.rows[0].id,
    active: result.rows[0].active,
  };
}

export async function listSupplierItemLinks(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
): Promise<SupplierItemLink[]> {
  const result = await db.query<{
    id: string;
    supplier_id: string;
    supplier_name: string;
    supplier_active: boolean;
    item_id: string;
    item_sku: string | null;
    supplier_sku: string | null;
    purchase_unit: string;
    is_preferred: boolean;
    active: boolean;
  }>(
    `
      select supplier_items.id,
             supplier_items.supplier_id,
             suppliers.name as supplier_name,
             suppliers.active as supplier_active,
             supplier_items.item_id,
             items.sku as item_sku,
             supplier_items.supplier_sku,
             supplier_items.purchase_unit,
             supplier_items.is_preferred,
             supplier_items.active
      from public.supplier_items
      join public.suppliers
        on suppliers.id = supplier_items.supplier_id
      join public.items
        on items.id = supplier_items.item_id
      where supplier_items.tenant_id = $1
      order by supplier_items.active desc,
               supplier_items.is_preferred desc,
               suppliers.name asc,
               items.sku asc
    `,
    [ctx.tenantId],
  );

  return result.rows.map((link) => ({
    id: link.id,
    supplierId: link.supplier_id,
    supplierName: link.supplier_name,
    supplierActive: link.supplier_active,
    itemId: link.item_id,
    itemSku: link.item_sku,
    supplierSku: link.supplier_sku,
    purchaseUnit: link.purchase_unit,
    isPreferred: link.is_preferred,
    active: link.active,
  }));
}

export async function linkSupplierToItem(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: {
    supplierId: string;
    itemId: string;
    supplierSku?: string | null;
    purchaseUnit?: string | null;
    isPreferred?: boolean;
  },
) {
  const supplier = await db.query<{ id: string; active: boolean }>(
    `
      select id, active
      from public.suppliers
      where tenant_id = $1
        and id = $2
      limit 1
    `,
    [ctx.tenantId, input.supplierId],
  );

  if (!supplier.rows[0]) {
    throw new Error("supplier_not_found");
  }

  if (!supplier.rows[0].active) {
    throw new Error("supplier_inactive");
  }

  const item = await db.query<{ id: string }>(
    `
      select id
      from public.items
      where tenant_id = $1
        and id = $2
      limit 1
    `,
    [ctx.tenantId, input.itemId],
  );

  if (!item.rows[0]) {
    throw new Error("item_not_found");
  }

  if (input.isPreferred) {
    await setPreferredSupplierForItem(db, ctx, {
      supplierId: input.supplierId,
      itemId: input.itemId,
    });
  }

  const result = await db.query<{ id: string }>(
    `
      insert into public.supplier_items (
        tenant_id,
        supplier_id,
        item_id,
        supplier_sku,
        purchase_unit,
        is_preferred,
        active
      )
      values ($1, $2, $3, $4, $5, $6, true)
      on conflict (tenant_id, supplier_id, item_id)
      do update
      set supplier_sku = excluded.supplier_sku,
          purchase_unit = excluded.purchase_unit,
          is_preferred = excluded.is_preferred,
          active = true,
          updated_at = now()
      returning id
    `,
    [
      ctx.tenantId,
      input.supplierId,
      input.itemId,
      input.supplierSku?.trim() || null,
      input.purchaseUnit?.trim() || "pcs",
      Boolean(input.isPreferred),
    ],
  );

  return { supplierItemId: result.rows[0]!.id };
}

export async function setPreferredSupplierForItem(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: { supplierId: string; itemId: string },
) {
  const supplier = await db.query<{ id: string; active: boolean }>(
    `
      select id, active
      from public.suppliers
      where tenant_id = $1
        and id = $2
      limit 1
    `,
    [ctx.tenantId, input.supplierId],
  );

  if (!supplier.rows[0]) {
    throw new Error("supplier_not_found");
  }

  if (!supplier.rows[0].active) {
    throw new Error("supplier_inactive");
  }

  await db.query(
    `
      update public.supplier_items
      set is_preferred = false,
          updated_at = now()
      where tenant_id = $1
        and item_id = $2
        and active = true
        and is_preferred = true
        and supplier_id <> $3
    `,
    [ctx.tenantId, input.itemId, input.supplierId],
  );

  const result = await db.query<{ id: string }>(
    `
      insert into public.supplier_items (
        tenant_id,
        supplier_id,
        item_id,
        is_preferred,
        active
      )
      values ($1, $2, $3, true, true)
      on conflict (tenant_id, supplier_id, item_id)
      do update
      set is_preferred = true,
          active = true,
          updated_at = now()
      returning id
    `,
    [ctx.tenantId, input.supplierId, input.itemId],
  );

  return { supplierItemId: result.rows[0]!.id };
}

export async function unlinkSupplierFromItem(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: { supplierItemId: string },
) {
  const result = await db.query<{ id: string }>(
    `
      update public.supplier_items
      set active = false,
          is_preferred = false,
          updated_at = now()
      where tenant_id = $1
        and id = $2
      returning id
    `,
    [ctx.tenantId, input.supplierItemId],
  );

  if (!result.rows[0]) {
    throw new Error("supplier_item_link_not_found");
  }

  return { supplierItemId: result.rows[0].id };
}

export async function listPurchaseNeedsBoard(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: { filter?: PurchaseNeedsBoardFilter } = {},
) {
  const filter = input.filter ?? "open";
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
    recommended_supplier_id: string | null;
    recommended_supplier_name: string | null;
    assigned_supplier_id: string | null;
    assigned_supplier_name: string | null;
    assigned_supplier_email: string | null;
    ready_for_po_draft_at: Date | null;
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
             recommended_suppliers.id as recommended_supplier_id,
             recommended_suppliers.name as recommended_supplier_name,
             assigned_suppliers.id as assigned_supplier_id,
             assigned_suppliers.name as assigned_supplier_name,
             assigned_suppliers.email as assigned_supplier_email,
             purchase_needs.ready_for_po_draft_at,
             purchase_needs.created_at
      from public.purchase_needs
      left join public.mrp_run_lines
        on mrp_run_lines.id = purchase_needs.mrp_run_line_id
      left join public.supplier_items
        on supplier_items.tenant_id = purchase_needs.tenant_id
       and supplier_items.item_id = purchase_needs.item_id
       and supplier_items.active = true
       and supplier_items.is_preferred = true
      left join public.suppliers as recommended_suppliers
        on recommended_suppliers.id = supplier_items.supplier_id
       and recommended_suppliers.active = true
      left join public.suppliers as assigned_suppliers
        on assigned_suppliers.id = purchase_needs.assigned_supplier_id
      where purchase_needs.tenant_id = $1
      ${filterWhereClause(filter)}
      order by purchase_needs.created_at desc
      limit 100
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
      recommendedSupplierId: need.recommended_supplier_id,
      recommendedSupplierName: need.recommended_supplier_name,
      assignedSupplierId: need.assigned_supplier_id,
      assignedSupplierName: need.assigned_supplier_name,
      assignedSupplierEmail: need.assigned_supplier_email,
      readyForPoDraftAt: need.ready_for_po_draft_at?.toISOString() ?? null,
      createdAt: need.created_at.toISOString(),
    })) satisfies PurchaseNeedBoardRow[],
    productionNeeds: productionNeeds.rows.map((need) => ({
      id: need.id,
      itemId: need.item_id,
      sku: need.sku,
      requiredQuantity: toNumber(need.required_quantity),
      status: need.status,
      sourceId: need.source_id,
      mrpRunId: need.mrp_run_id,
      createdAt: need.created_at.toISOString(),
    })) satisfies ProductionNeedBoardRow[],
  };
}

export async function assignSupplierToPurchaseNeed(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: {
    purchaseNeedId: string;
    supplierId: string;
    rememberForItem?: boolean;
  },
) {
  const supplier = await db.query<{ id: string; active: boolean }>(
    `
      select id, active
      from public.suppliers
      where tenant_id = $1
        and id = $2
      limit 1
    `,
    [ctx.tenantId, input.supplierId],
  );

  if (!supplier.rows[0]) {
    throw new Error("supplier_not_found");
  }

  if (!supplier.rows[0].active) {
    throw new Error("supplier_inactive");
  }

  const need = await db.query<{
    id: string;
    item_id: string | null;
    assigned_supplier_id: string | null;
  }>(
    `
      select id, item_id, assigned_supplier_id
      from public.purchase_needs
      where tenant_id = $1
        and id = $2
        and ${activePurchaseNeedStatusSql()}
      limit 1
    `,
    [ctx.tenantId, input.purchaseNeedId],
  );

  if (!need.rows[0]) {
    throw new Error("purchase_need_not_found_or_closed");
  }

  await db.query(
    `
      update public.purchase_needs
      set assigned_supplier_id = $3,
          supplier_assigned_at = coalesce(supplier_assigned_at, now()),
          ready_for_po_draft_at = null,
          updated_at = now()
      where tenant_id = $1
        and id = $2
    `,
    [ctx.tenantId, input.purchaseNeedId, input.supplierId],
  );

  if (input.rememberForItem && need.rows[0].item_id) {
    await db.query(
      `
        update public.supplier_items
        set is_preferred = false,
            updated_at = now()
        where tenant_id = $1
          and item_id = $2
          and active = true
          and is_preferred = true
          and supplier_id <> $3
      `,
      [ctx.tenantId, need.rows[0].item_id, input.supplierId],
    );
    await db.query(
      `
        insert into public.supplier_items (
          tenant_id,
          supplier_id,
          item_id,
          is_preferred,
          active
        )
        values ($1, $2, $3, true, true)
        on conflict (tenant_id, supplier_id, item_id)
        do update
        set is_preferred = true,
            active = true,
            updated_at = now()
      `,
      [ctx.tenantId, input.supplierId, need.rows[0].item_id],
    );
  }

  return {
    purchaseNeedId: input.purchaseNeedId,
    supplierId: input.supplierId,
    alreadyAssigned: need.rows[0].assigned_supplier_id === input.supplierId,
  };
}

export async function findPreferredSupplierForPurchaseNeed(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: { purchaseNeedId: string },
): Promise<SupplierOption | null> {
  const result = await db.query<{
    id: string;
    name: string;
    email: string | null;
    active: boolean;
  }>(
    `
      select suppliers.id,
             suppliers.name,
             suppliers.email,
             suppliers.active
      from public.purchase_needs
      join public.supplier_items
        on supplier_items.tenant_id = purchase_needs.tenant_id
       and supplier_items.item_id = purchase_needs.item_id
       and supplier_items.active = true
       and supplier_items.is_preferred = true
      join public.suppliers
        on suppliers.id = supplier_items.supplier_id
       and suppliers.active = true
      where purchase_needs.tenant_id = $1
        and purchase_needs.id = $2
      limit 1
    `,
    [ctx.tenantId, input.purchaseNeedId],
  );

  if (!result.rows[0]) {
    return null;
  }

  return {
    id: result.rows[0].id,
    name: result.rows[0].name,
    email: result.rows[0].email,
    active: result.rows[0].active,
  };
}

export async function assignPreferredSupplierToPurchaseNeed(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: { purchaseNeedId: string },
) {
  const preferredSupplier = await findPreferredSupplierForPurchaseNeed(
    db,
    ctx,
    input,
  );

  if (!preferredSupplier) {
    throw new Error("preferred_supplier_not_found");
  }

  return assignSupplierToPurchaseNeed(db, ctx, {
    purchaseNeedId: input.purchaseNeedId,
    supplierId: preferredSupplier.id,
    rememberForItem: false,
  });
}

export async function markPurchaseNeedReadyForPo(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
  input: { purchaseNeedId: string },
) {
  const need = await db.query<{
    id: string;
    assigned_supplier_id: string | null;
    ready_for_po_draft_at: Date | null;
    supplier_active: boolean | null;
  }>(
    `
      select purchase_needs.id,
             purchase_needs.assigned_supplier_id,
             purchase_needs.ready_for_po_draft_at,
             suppliers.active as supplier_active
      from public.purchase_needs
      left join public.suppliers
        on suppliers.id = purchase_needs.assigned_supplier_id
      where purchase_needs.tenant_id = $1
        and purchase_needs.id = $2
        and ${activePurchaseNeedStatusSql()}
      limit 1
    `,
    [ctx.tenantId, input.purchaseNeedId],
  );

  if (!need.rows[0]) {
    throw new Error("purchase_need_not_found_or_closed");
  }

  if (!need.rows[0].assigned_supplier_id) {
    throw new Error("purchase_need_missing_supplier");
  }

  if (!need.rows[0].supplier_active) {
    throw new Error("supplier_inactive");
  }

  await db.query(
    `
      update public.purchase_needs
      set ready_for_po_draft_at = coalesce(ready_for_po_draft_at, now()),
          updated_at = now()
      where tenant_id = $1
        and id = $2
    `,
    [ctx.tenantId, input.purchaseNeedId],
  );

  return {
    purchaseNeedId: input.purchaseNeedId,
    alreadyReady: Boolean(need.rows[0].ready_for_po_draft_at),
  };
}

export async function loadPurchaseNeedsSummary(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
) {
  const result = await db.query<{
    open_count: string;
    missing_supplier_count: string;
    preferred_available_count: string;
    ready_for_po_count: string;
  }>(
    `
      select
        count(*) filter (where ${activePurchaseNeedStatusSql()})::text as open_count,
        count(*) filter (
          where ${activePurchaseNeedStatusSql()}
            and purchase_needs.assigned_supplier_id is null
        )::text as missing_supplier_count,
        count(distinct purchase_needs.id) filter (
          where ${activePurchaseNeedStatusSql()}
            and purchase_needs.assigned_supplier_id is null
            and suppliers.id is not null
        )::text as preferred_available_count,
        count(*) filter (
          where ${activePurchaseNeedStatusSql()}
            and purchase_needs.assigned_supplier_id is not null
            and purchase_needs.ready_for_po_draft_at is not null
        )::text as ready_for_po_count
      from public.purchase_needs
      left join public.supplier_items
        on supplier_items.tenant_id = purchase_needs.tenant_id
       and supplier_items.item_id = purchase_needs.item_id
       and supplier_items.active = true
       and supplier_items.is_preferred = true
      left join public.suppliers
        on suppliers.id = supplier_items.supplier_id
       and suppliers.active = true
      where purchase_needs.tenant_id = $1
    `,
    [ctx.tenantId],
  );

  return {
    openPurchaseNeeds: toNumber(result.rows[0]?.open_count),
    missingSupplierPurchaseNeeds: toNumber(
      result.rows[0]?.missing_supplier_count,
    ),
    preferredSupplierAvailablePurchaseNeeds: toNumber(
      result.rows[0]?.preferred_available_count,
    ),
    readyForPoDraftPurchaseNeeds: toNumber(result.rows[0]?.ready_for_po_count),
  };
}

export async function preparePurchaseOrderDraftPreview(
  db: QueryExecutor,
  ctx: MaterialTenantContext,
): Promise<{ groups: PurchaseOrderDraftPreviewGroup[] }> {
  const result = await db.query<{
    id: string;
    item_id: string | null;
    sku: string | null;
    title: string;
    quantity_needed: string;
    quantity_covered: string;
    assigned_supplier_id: string;
    supplier_name: string;
    supplier_email: string | null;
    mrp_run_id: string | null;
  }>(
    `
      select purchase_needs.id,
             purchase_needs.item_id,
             purchase_needs.sku,
             purchase_needs.title,
             purchase_needs.quantity_needed::text,
             purchase_needs.quantity_covered::text,
             purchase_needs.assigned_supplier_id,
             suppliers.name as supplier_name,
             suppliers.email as supplier_email,
             mrp_run_lines.mrp_run_id
      from public.purchase_needs
      join public.suppliers
        on suppliers.id = purchase_needs.assigned_supplier_id
       and suppliers.active = true
      left join public.mrp_run_lines
        on mrp_run_lines.id = purchase_needs.mrp_run_line_id
      where purchase_needs.tenant_id = $1
        and purchase_needs.ready_for_po_draft_at is not null
        and ${activePurchaseNeedStatusSql()}
      order by suppliers.name asc, purchase_needs.created_at asc
    `,
    [ctx.tenantId],
  );

  const groupsBySupplier = new Map<string, PurchaseOrderDraftPreviewGroup>();

  for (const row of result.rows) {
    const quantityNeeded = toNumber(row.quantity_needed);
    const quantityCovered = toNumber(row.quantity_covered);
    const quantityToOrder = Math.max(quantityNeeded - quantityCovered, 0);
    let group = groupsBySupplier.get(row.assigned_supplier_id);

    if (!group) {
      group = {
        supplierId: row.assigned_supplier_id,
        supplierName: row.supplier_name,
        supplierEmail: row.supplier_email,
        needCount: 0,
        totalQuantity: 0,
        lines: [],
      };
      groupsBySupplier.set(row.assigned_supplier_id, group);
    }

    group.needCount += 1;
    group.totalQuantity += quantityToOrder;
    group.lines.push({
      purchaseNeedId: row.id,
      itemId: row.item_id,
      sku: row.sku,
      title: row.title,
      quantityNeeded,
      quantityCovered,
      quantityToOrder,
      sourceMrpRunId: row.mrp_run_id,
    });
  }

  return { groups: Array.from(groupsBySupplier.values()) };
}
