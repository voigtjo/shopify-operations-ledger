alter table public.purchase_orders
add column if not exists display_number text null,
add column if not exists source_type text null,
add column if not exists source_id uuid null,
add column if not exists created_by text null,
add column if not exists sent_at timestamptz null,
add column if not exists acknowledged_at timestamptz null,
add column if not exists cancelled_at timestamptz null;

update public.purchase_orders
set status = lower(status)
where status in ('DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CLOSED', 'CANCELLED');

update public.purchase_orders
set status = 'received'
where status = 'fully_received';

do $$
declare
  constraint_record record;
begin
  for constraint_record in
    select conname
    from pg_constraint
    where conrelid = 'public.purchase_orders'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%'
  loop
    execute format('alter table public.purchase_orders drop constraint %I', constraint_record.conname);
  end loop;
end $$;

alter table public.purchase_orders
add constraint purchase_orders_status_check
check (status in (
  'draft',
  'sent',
  'acknowledged',
  'cancelled',
  'pending_approval',
  'approved',
  'partially_received',
  'received',
  'closed',
  'DRAFT',
  'SENT',
  'PARTIALLY_RECEIVED',
  'FULLY_RECEIVED',
  'CLOSED',
  'CANCELLED'
));

create unique index if not exists purchase_orders_display_number_uidx
on public.purchase_orders (tenant_id, display_number)
where display_number is not null;

create index if not exists purchase_orders_lifecycle_status_idx
on public.purchase_orders (tenant_id, status, created_at);

alter table public.purchase_order_lines
add column if not exists item_id uuid null references public.items(id) on delete restrict,
add column if not exists source_purchase_need_id uuid null references public.purchase_needs(id) on delete set null,
add column if not exists quantity numeric(18,4) null check (quantity is null or quantity > 0),
add column if not exists unit text not null default 'pcs',
add column if not exists status text not null default 'open';

update public.purchase_order_lines
set quantity = quantity_ordered
where quantity is null;

update public.purchase_order_lines
set source_purchase_need_id = purchase_need_id
where source_purchase_need_id is null
  and purchase_need_id is not null;

do $$
declare
  constraint_record record;
begin
  for constraint_record in
    select conname
    from pg_constraint
    where conrelid = 'public.purchase_order_lines'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%'
  loop
    execute format('alter table public.purchase_order_lines drop constraint %I', constraint_record.conname);
  end loop;
end $$;

alter table public.purchase_order_lines
add constraint purchase_order_lines_status_check
check (status in (
  'open',
  'cancelled',
  'fulfilled_later',
  'partially_received',
  'received'
));

create index if not exists purchase_order_lines_item_idx
on public.purchase_order_lines (tenant_id, item_id);

create index if not exists purchase_order_lines_source_need_idx
on public.purchase_order_lines (tenant_id, source_purchase_need_id);

create unique index if not exists purchase_order_lines_active_source_need_uidx
on public.purchase_order_lines (tenant_id, source_purchase_need_id)
where source_purchase_need_id is not null
  and status <> 'cancelled';
