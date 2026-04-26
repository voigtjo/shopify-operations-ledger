create table public.tenant_onboarding (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  status text not null check (status in ('NOT_STARTED', 'STARTED', 'COMPLETED', 'SKIPPED')),
  current_step text not null,
  completed_steps jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id)
);

create index tenant_onboarding_tenant_id_idx on public.tenant_onboarding (tenant_id);
create index tenant_onboarding_status_idx on public.tenant_onboarding (status);

create trigger set_tenant_onboarding_updated_at
before update on public.tenant_onboarding
for each row
execute function public.set_updated_at();
