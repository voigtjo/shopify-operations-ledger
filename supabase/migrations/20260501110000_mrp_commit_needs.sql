alter table public.purchase_needs
add column if not exists source_type text null,
add column if not exists source_id text null,
add column if not exists mrp_run_line_id uuid null references public.mrp_run_lines(id) on delete set null;

alter table public.production_needs
add column if not exists source_type text null,
add column if not exists source_id text null,
add column if not exists mrp_run_line_id uuid null references public.mrp_run_lines(id) on delete set null;

alter table public.mrp_run_lines
add column if not exists purchase_need_id uuid null references public.purchase_needs(id) on delete set null,
add column if not exists production_need_id uuid null references public.production_needs(id) on delete set null;

do $$
declare
  constraint_record record;
begin
  for constraint_record in
    select conname
    from pg_constraint
    where conrelid = 'public.purchase_needs'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%'
  loop
    execute format('alter table public.purchase_needs drop constraint %I', constraint_record.conname);
  end loop;
end $$;

alter table public.purchase_needs
add constraint purchase_needs_status_check
check (status in (
  'OPEN',
  'LINKED_TO_PO',
  'PARTIALLY_COVERED',
  'COVERED',
  'CANCELLED',
  'open',
  'linked_to_po',
  'partially_covered',
  'covered',
  'cancelled'
));

do $$
declare
  constraint_record record;
begin
  for constraint_record in
    select conname
    from pg_constraint
    where conrelid = 'public.production_needs'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%'
  loop
    execute format('alter table public.production_needs drop constraint %I', constraint_record.conname);
  end loop;
end $$;

alter table public.production_needs
add constraint production_needs_status_check
check (status in (
  'PENDING',
  'PLANNED',
  'RELEASED',
  'COMPLETED',
  'CANCELLED',
  'pending',
  'planned',
  'converted_to_order',
  'cancelled'
));

create index if not exists purchase_needs_mrp_run_line_idx
on public.purchase_needs (tenant_id, mrp_run_line_id);

create index if not exists production_needs_mrp_run_line_idx
on public.production_needs (tenant_id, mrp_run_line_id);

create unique index purchase_needs_active_mrp_source_uidx
on public.purchase_needs (tenant_id, item_id, source_type, source_id)
where status in ('open', 'linked_to_po', 'partially_covered');

create unique index production_needs_pending_mrp_source_uidx
on public.production_needs (tenant_id, item_id, source_type, source_id)
where status = 'pending';
