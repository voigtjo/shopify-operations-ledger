create table public.items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  shopify_product_id text null,
  shopify_variant_id text not null,
  item_type text not null check (item_type in ('product', 'component', 'raw_material', 'assembly')),
  sku text null,
  unit text not null default 'pcs',
  is_sellable boolean not null default false,
  is_purchasable boolean not null default false,
  is_producible boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, shopify_variant_id)
);

create index items_tenant_type_idx on public.items (tenant_id, item_type);
create index items_tenant_sku_idx on public.items (tenant_id, sku);

create trigger set_items_updated_at
before update on public.items
for each row
execute function public.set_updated_at();

create table public.boms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  parent_item_id uuid not null references public.items(id) on delete cascade,
  version text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, parent_item_id, version)
);

create unique index boms_one_active_per_item_uidx
on public.boms (tenant_id, parent_item_id)
where is_active = true;

create index boms_tenant_parent_idx on public.boms (tenant_id, parent_item_id);

create table public.bom_lines (
  id uuid primary key default gen_random_uuid(),
  bom_id uuid not null references public.boms(id) on delete cascade,
  component_item_id uuid not null references public.items(id) on delete cascade,
  quantity numeric(18,4) not null check (quantity > 0),
  unit text not null default 'pcs',
  created_at timestamptz not null default now(),
  unique (bom_id, component_item_id)
);

create index bom_lines_component_idx on public.bom_lines (component_item_id);

create table public.production_needs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete restrict,
  required_quantity numeric(18,4) not null check (required_quantity > 0),
  status text not null check (status in ('PENDING', 'PLANNED', 'RELEASED', 'COMPLETED', 'CANCELLED')),
  reference_type text not null,
  reference_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index production_needs_tenant_status_idx on public.production_needs (tenant_id, status);
create index production_needs_reference_idx on public.production_needs (tenant_id, reference_type, reference_id);
create unique index production_needs_pending_reference_item_uidx
on public.production_needs (tenant_id, item_id, reference_type, reference_id)
where status = 'PENDING';

create trigger set_production_needs_updated_at
before update on public.production_needs
for each row
execute function public.set_updated_at();

alter table public.operations_order_lines
add column item_id uuid null references public.items(id) on delete set null;

create index operations_order_lines_item_idx on public.operations_order_lines (tenant_id, item_id);

alter table public.purchase_needs
add column item_id uuid null references public.items(id) on delete set null;

create index purchase_needs_item_idx on public.purchase_needs (tenant_id, item_id);

drop index if exists public.purchase_needs_active_line_uidx;

create unique index purchase_needs_active_line_item_uidx
on public.purchase_needs (
  tenant_id,
  operations_order_line_id,
  coalesce(item_id, '00000000-0000-0000-0000-000000000000'::uuid)
)
where status in ('OPEN', 'LINKED_TO_PO', 'PARTIALLY_COVERED');
