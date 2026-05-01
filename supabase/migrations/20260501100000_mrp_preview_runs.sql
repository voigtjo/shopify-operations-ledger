create table public.mrp_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  run_number text not null,
  status text not null check (status in ('draft', 'running', 'completed', 'failed', 'cancelled')),
  demand_source_type text not null,
  demand_source_id text not null,
  idempotency_key text not null,
  error_message text null,
  started_at timestamptz null,
  completed_at timestamptz null,
  created_by_user_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create index mrp_runs_tenant_status_idx on public.mrp_runs (tenant_id, status);
create index mrp_runs_source_idx on public.mrp_runs (tenant_id, demand_source_type, demand_source_id);

create trigger set_mrp_runs_updated_at
before update on public.mrp_runs
for each row
execute function public.set_updated_at();

create table public.mrp_run_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  mrp_run_id uuid not null references public.mrp_runs(id) on delete cascade,
  line_number integer not null,
  line_key text not null,
  item_id uuid not null references public.items(id) on delete restrict,
  source_type text not null,
  source_id text not null,
  source_line_id text null,
  demand_type text not null check (demand_type in ('direct', 'production', 'component')),
  demand_level integer not null default 0,
  bom_path jsonb not null default '[]'::jsonb,
  required_quantity numeric(18,4) not null check (required_quantity >= 0),
  available_quantity numeric(18,4) not null default 0,
  reserved_quantity numeric(18,4) not null default 0,
  shortage_quantity numeric(18,4) not null default 0,
  recommended_action text not null check (recommended_action in ('none', 'reserve', 'purchase', 'produce', 'review')),
  explanation text not null,
  created_at timestamptz not null default now(),
  unique (mrp_run_id, line_number),
  unique (mrp_run_id, line_key)
);

create index mrp_run_lines_tenant_run_idx on public.mrp_run_lines (tenant_id, mrp_run_id);
create index mrp_run_lines_item_idx on public.mrp_run_lines (tenant_id, item_id);
create index mrp_run_lines_action_idx on public.mrp_run_lines (tenant_id, recommended_action);
