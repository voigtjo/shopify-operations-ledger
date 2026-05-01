create table if not exists public.supplier_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  supplier_sku text null,
  lead_time_days integer null check (lead_time_days is null or lead_time_days >= 0),
  minimum_order_quantity numeric(18,4) null check (minimum_order_quantity is null or minimum_order_quantity > 0),
  purchase_unit text not null default 'pcs',
  is_preferred boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, supplier_id, item_id)
);

create index if not exists supplier_items_tenant_item_idx
on public.supplier_items (tenant_id, item_id);

create index if not exists supplier_items_tenant_supplier_idx
on public.supplier_items (tenant_id, supplier_id);

create unique index if not exists supplier_items_one_preferred_active_item_uidx
on public.supplier_items (tenant_id, item_id)
where active = true and is_preferred = true;

drop trigger if exists set_supplier_items_updated_at on public.supplier_items;

create trigger set_supplier_items_updated_at
before update on public.supplier_items
for each row
execute function public.set_updated_at();

alter table public.purchase_needs
add column if not exists assigned_supplier_id uuid null references public.suppliers(id) on delete set null,
add column if not exists supplier_assigned_at timestamptz null,
add column if not exists ready_for_po_draft_at timestamptz null;

create index if not exists purchase_needs_assigned_supplier_idx
on public.purchase_needs (tenant_id, assigned_supplier_id);

create index if not exists purchase_needs_ready_for_po_draft_idx
on public.purchase_needs (tenant_id, ready_for_po_draft_at)
where ready_for_po_draft_at is not null;
