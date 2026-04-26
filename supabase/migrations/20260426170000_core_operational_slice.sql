create table public.shopify_order_refs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  shopify_order_id text not null,
  shopify_order_name text null,
  shopify_created_at timestamptz null,
  raw_payload jsonb null,
  created_at timestamptz not null default now(),
  unique (tenant_id, shopify_order_id)
);

create index shopify_order_refs_tenant_id_idx on public.shopify_order_refs (tenant_id);

create table public.operations_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  origin_type text not null check (origin_type in ('SHOPIFY_ORDER', 'MANUAL', 'QUOTE', 'RECURRING', 'API')),
  origin_ref_id uuid null,
  order_number text null,
  customer_name text null,
  customer_external_id text null,
  status text not null check (status in ('DRAFT', 'OPEN', 'SUPPLY_CHECKED', 'SUPPLY_PENDING', 'SUPPLY_READY', 'CANCELLED')),
  currency text null,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index operations_orders_tenant_status_idx on public.operations_orders (tenant_id, status);

create trigger set_operations_orders_updated_at
before update on public.operations_orders
for each row
execute function public.set_updated_at();

create table public.operations_order_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  operations_order_id uuid not null references public.operations_orders(id) on delete cascade,
  shopify_variant_id text null,
  sku text null,
  title text not null,
  quantity_required numeric(18,4) not null check (quantity_required > 0),
  quantity_reserved numeric(18,4) not null default 0 check (quantity_reserved >= 0),
  quantity_missing numeric(18,4) not null default 0 check (quantity_missing >= 0),
  supply_status text not null check (supply_status in ('UNCHECKED', 'AVAILABLE', 'RESERVED', 'MISSING', 'PARTIALLY_RESERVED', 'CANCELLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index operations_order_lines_order_idx on public.operations_order_lines (operations_order_id);
create index operations_order_lines_tenant_variant_idx on public.operations_order_lines (tenant_id, shopify_variant_id);
create index operations_order_lines_tenant_sku_idx on public.operations_order_lines (tenant_id, sku);

create trigger set_operations_order_lines_updated_at
before update on public.operations_order_lines
for each row
execute function public.set_updated_at();

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  email text null,
  external_ref text null,
  active boolean not null default true,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create index suppliers_tenant_active_idx on public.suppliers (tenant_id, active);

create trigger set_suppliers_updated_at
before update on public.suppliers
for each row
execute function public.set_updated_at();

create table public.purchase_needs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  operations_order_id uuid null references public.operations_orders(id) on delete set null,
  operations_order_line_id uuid null references public.operations_order_lines(id) on delete set null,
  shopify_variant_id text null,
  sku text null,
  title text not null,
  quantity_needed numeric(18,4) not null check (quantity_needed > 0),
  quantity_covered numeric(18,4) not null default 0 check (quantity_covered >= 0),
  status text not null check (status in ('OPEN', 'LINKED_TO_PO', 'PARTIALLY_COVERED', 'COVERED', 'CANCELLED')),
  reason text not null default 'SUPPLY_SHORTAGE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index purchase_needs_tenant_status_idx on public.purchase_needs (tenant_id, status);
create index purchase_needs_order_line_idx on public.purchase_needs (operations_order_line_id);

create unique index purchase_needs_active_line_uidx
on public.purchase_needs (tenant_id, operations_order_line_id)
where status in ('OPEN', 'LINKED_TO_PO', 'PARTIALLY_COVERED');

create trigger set_purchase_needs_updated_at
before update on public.purchase_needs
for each row
execute function public.set_updated_at();

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id),
  po_number text null,
  status text not null check (status in ('DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CLOSED', 'CANCELLED')),
  expected_delivery_date date null,
  currency text null,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, po_number)
);

create index purchase_orders_tenant_status_idx on public.purchase_orders (tenant_id, status);
create index purchase_orders_supplier_idx on public.purchase_orders (supplier_id);

create trigger set_purchase_orders_updated_at
before update on public.purchase_orders
for each row
execute function public.set_updated_at();

create table public.purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  purchase_need_id uuid null references public.purchase_needs(id) on delete set null,
  shopify_variant_id text null,
  sku text null,
  title text not null,
  quantity_ordered numeric(18,4) not null check (quantity_ordered > 0),
  quantity_received numeric(18,4) not null default 0 check (quantity_received >= 0),
  unit_cost numeric(18,4) null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index purchase_order_lines_order_idx on public.purchase_order_lines (purchase_order_id);
create index purchase_order_lines_need_idx on public.purchase_order_lines (purchase_need_id);

create trigger set_purchase_order_lines_updated_at
before update on public.purchase_order_lines
for each row
execute function public.set_updated_at();

create table public.goods_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  purchase_order_id uuid not null references public.purchase_orders(id),
  receipt_number text null,
  status text not null check (status in ('DRAFT', 'POSTED', 'VOIDED')),
  received_at timestamptz not null default now(),
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, receipt_number)
);

create index goods_receipts_tenant_purchase_order_idx on public.goods_receipts (tenant_id, purchase_order_id);

create trigger set_goods_receipts_updated_at
before update on public.goods_receipts
for each row
execute function public.set_updated_at();

create table public.goods_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  goods_receipt_id uuid not null references public.goods_receipts(id) on delete cascade,
  purchase_order_line_id uuid not null references public.purchase_order_lines(id),
  shopify_variant_id text null,
  sku text null,
  title text not null,
  quantity_received numeric(18,4) not null check (quantity_received > 0),
  created_at timestamptz not null default now()
);

create index goods_receipt_lines_receipt_idx on public.goods_receipt_lines (goods_receipt_id);
create index goods_receipt_lines_purchase_order_line_idx on public.goods_receipt_lines (purchase_order_line_id);

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  shopify_variant_id text null,
  sku text null,
  title text null,
  movement_type text not null check (
    movement_type in (
      'INITIAL_BALANCE',
      'MANUAL_ADJUSTMENT',
      'GOODS_RECEIPT',
      'RESERVATION_CREATED',
      'RESERVATION_RELEASED'
    )
  ),
  quantity_delta numeric(18,4) not null,
  reservation_delta numeric(18,4) not null default 0,
  source_type text not null,
  source_id uuid null,
  reason text null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index inventory_movements_variant_idx on public.inventory_movements (tenant_id, shopify_variant_id);
create index inventory_movements_sku_idx on public.inventory_movements (tenant_id, sku);
create index inventory_movements_source_idx on public.inventory_movements (tenant_id, source_type, source_id);

create table public.domain_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  event_type text not null,
  aggregate_type text not null,
  aggregate_id uuid null,
  idempotency_key text null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create index domain_events_tenant_type_idx on public.domain_events (tenant_id, event_type);
create index domain_events_aggregate_idx on public.domain_events (tenant_id, aggregate_type, aggregate_id);

create table public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  key text not null,
  purpose text not null,
  result_ref_type text null,
  result_ref_id uuid null,
  created_at timestamptz not null default now(),
  unique (tenant_id, key)
);

create index idempotency_keys_tenant_purpose_idx on public.idempotency_keys (tenant_id, purpose);
