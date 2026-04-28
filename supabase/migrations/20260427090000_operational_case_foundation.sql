create table public.operation_cases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  shop_installation_id uuid null references public.shopify_installations(id) on delete set null,
  case_type text not null check (
    case_type in (
      'order_clarification',
      'fulfillment_exception',
      'refund_approval',
      'return_case',
      'inventory_discrepancy',
      'purchase_need',
      'general_operations_case'
    )
  ),
  status text not null check (
    status in (
      'open',
      'in_progress',
      'blocked',
      'waiting_for_decision',
      'closed',
      'cancelled'
    )
  ),
  priority text not null check (priority in ('low', 'normal', 'high', 'urgent')),
  summary text not null,
  description text null,
  owner_user_id uuid null references public.app_users(id) on delete set null,
  assigned_user_id uuid null references public.app_users(id) on delete set null,
  assigned_role_id uuid null references public.roles(id) on delete set null,
  primary_shopify_object_type text null,
  primary_shopify_object_id text null,
  primary_shopify_object_gid text null,
  blocked_reason text null,
  due_at timestamptz null,
  closed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index operation_cases_tenant_status_idx on public.operation_cases (tenant_id, status, priority);
create index operation_cases_assigned_user_idx on public.operation_cases (tenant_id, assigned_user_id);
create index operation_cases_assigned_role_idx on public.operation_cases (tenant_id, assigned_role_id);
create index operation_cases_shopify_object_idx
on public.operation_cases (tenant_id, primary_shopify_object_type, primary_shopify_object_id);

create trigger set_operation_cases_updated_at
before update on public.operation_cases
for each row
execute function public.set_updated_at();

create table public.case_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  operation_case_id uuid not null references public.operation_cases(id) on delete cascade,
  event_type text not null,
  title text not null,
  message text null,
  actor_type text not null check (actor_type in ('system', 'user', 'shopify', 'job')),
  actor_id text null,
  source text not null,
  source_ref text null,
  metadata jsonb null,
  idempotency_key text null,
  created_at timestamptz not null default now()
);

create index case_events_case_created_idx on public.case_events (operation_case_id, created_at desc);
create index case_events_tenant_type_idx on public.case_events (tenant_id, event_type);
create unique index case_events_idempotency_uidx
on public.case_events (tenant_id, idempotency_key)
where idempotency_key is not null;

create table public.case_comments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  operation_case_id uuid not null references public.operation_cases(id) on delete cascade,
  author_user_id uuid null references public.app_users(id) on delete set null,
  body text not null,
  internal boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index case_comments_case_created_idx on public.case_comments (operation_case_id, created_at desc);

create trigger set_case_comments_updated_at
before update on public.case_comments
for each row
execute function public.set_updated_at();

create table public.case_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  operation_case_id uuid not null references public.operation_cases(id) on delete cascade,
  title text not null,
  description text null,
  status text not null check (status in ('open', 'in_progress', 'done', 'cancelled')),
  assigned_user_id uuid null references public.app_users(id) on delete set null,
  assigned_role_id uuid null references public.roles(id) on delete set null,
  due_at timestamptz null,
  completed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index case_tasks_case_status_idx on public.case_tasks (operation_case_id, status);
create index case_tasks_assigned_user_idx on public.case_tasks (tenant_id, assigned_user_id, status);
create index case_tasks_assigned_role_idx on public.case_tasks (tenant_id, assigned_role_id, status);

create trigger set_case_tasks_updated_at
before update on public.case_tasks
for each row
execute function public.set_updated_at();

create table public.case_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  operation_case_id uuid not null references public.operation_cases(id) on delete cascade,
  decision_type text not null check (
    decision_type in (
      'approve_refund',
      'approve_fulfillment',
      'approve_purchase',
      'resolve_discrepancy',
      'close_case'
    )
  ),
  status text not null check (status in ('requested', 'approved', 'rejected', 'cancelled')),
  requested_by_user_id uuid null references public.app_users(id) on delete set null,
  decided_by_user_id uuid null references public.app_users(id) on delete set null,
  decision_value text null,
  reason text null,
  decided_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index case_decisions_case_status_idx on public.case_decisions (operation_case_id, status);
create index case_decisions_tenant_status_idx on public.case_decisions (tenant_id, status, decision_type);

create trigger set_case_decisions_updated_at
before update on public.case_decisions
for each row
execute function public.set_updated_at();

create table public.case_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  operation_case_id uuid not null references public.operation_cases(id) on delete cascade,
  linked_object_type text not null,
  linked_object_id text not null,
  linked_object_gid text null,
  relation_type text not null,
  created_at timestamptz not null default now()
);

create index case_links_case_idx on public.case_links (operation_case_id);
create index case_links_object_idx on public.case_links (tenant_id, linked_object_type, linked_object_id);
create unique index case_links_relation_uidx
on public.case_links (tenant_id, operation_case_id, linked_object_type, linked_object_id, relation_type);

alter table public.operations_orders
add column operation_case_id uuid null references public.operation_cases(id) on delete set null;

create index operations_orders_operation_case_idx on public.operations_orders (tenant_id, operation_case_id);
