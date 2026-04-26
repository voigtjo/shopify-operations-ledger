create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text null,
  primary_shop_domain text not null unique,
  status text not null check (status in ('ACTIVE', 'SUSPENDED', 'UNINSTALLED', 'DELETED')),
  plan_code text not null default 'DEV',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_tenants_updated_at
before update on public.tenants
for each row
execute function public.set_updated_at();

create table public.shopify_installations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  shop_domain text not null unique,
  shop_name text null,
  access_token_encrypted text not null,
  scopes text not null,
  installed_at timestamptz not null default now(),
  uninstalled_at timestamptz null,
  status text not null check (status in ('ACTIVE', 'UNINSTALLED', 'TOKEN_REVOKED', 'ERROR'))
);

create index shopify_installations_tenant_id_idx on public.shopify_installations (tenant_id);
create index shopify_installations_status_idx on public.shopify_installations (status);

create table public.tenant_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  key text not null,
  value jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key)
);

create index tenant_settings_tenant_id_idx on public.tenant_settings (tenant_id);

create trigger set_tenant_settings_updated_at
before update on public.tenant_settings
for each row
execute function public.set_updated_at();

create table public.integration_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source text not null,
  topic text not null,
  external_event_id text null,
  external_resource_id text null,
  payload_hash text not null,
  payload jsonb not null,
  processing_status text not null check (
    processing_status in ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED_DUPLICATE')
  ),
  processed_at timestamptz null,
  error_message text null,
  created_at timestamptz not null default now()
);

create index integration_events_tenant_id_idx on public.integration_events (tenant_id);
create index integration_events_processing_status_idx on public.integration_events (processing_status);
create index integration_events_created_at_idx on public.integration_events (created_at);

create unique index integration_events_external_event_id_uidx
on public.integration_events (tenant_id, source, topic, external_event_id)
where external_event_id is not null;

create index integration_events_payload_dedup_idx
on public.integration_events (tenant_id, source, topic, external_resource_id, payload_hash, created_at)
where external_resource_id is not null;

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid null references public.tenants(id) on delete set null,
  actor_type text not null,
  actor_id text null,
  action text not null,
  target_type text null,
  target_id text null,
  severity text not null check (severity in ('INFO', 'WARNING', 'SECURITY', 'ERROR')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_events_tenant_id_idx on public.audit_events (tenant_id);
create index audit_events_action_idx on public.audit_events (action);
create index audit_events_created_at_idx on public.audit_events (created_at);

create table public.app_users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  email text not null,
  display_name text null,
  status text not null check (status in ('ACTIVE', 'INVITED', 'SUSPENDED', 'DELETED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, email)
);

create index app_users_tenant_id_idx on public.app_users (tenant_id);
create index app_users_status_idx on public.app_users (status);

create trigger set_app_users_updated_at
before update on public.app_users
for each row
execute function public.set_updated_at();

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name text not null,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create index roles_tenant_id_idx on public.roles (tenant_id);

create table public.permissions (
  code text primary key,
  description text not null
);

create table public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_code text not null references public.permissions(code) on delete cascade,
  primary key (role_id, permission_code)
);

create index role_permissions_permission_code_idx on public.role_permissions (permission_code);

create table public.user_roles (
  user_id uuid not null references public.app_users(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete cascade,
  primary key (user_id, role_id)
);

create index user_roles_role_id_idx on public.user_roles (role_id);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  job_type text not null,
  status text not null check (status in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTER')),
  priority integer not null default 100,
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text null,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  run_after timestamptz not null default now(),
  locked_at timestamptz null,
  locked_by text null,
  last_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, job_type, idempotency_key)
);

create index jobs_tenant_id_idx on public.jobs (tenant_id);
create index jobs_status_run_after_idx on public.jobs (status, run_after, priority);
create index jobs_locked_at_idx on public.jobs (locked_at);

create trigger set_jobs_updated_at
before update on public.jobs
for each row
execute function public.set_updated_at();
