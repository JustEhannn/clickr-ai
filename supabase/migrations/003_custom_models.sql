-- Pro+ custom AI models. If you already applied your own 003, diff against this
-- instead of running it: the app expects columns
-- id, user_id, name, provider, model_id, api_key, created_at.
-- NOTE: api_key is stored in plaintext (known limitation; encrypt before launch).
create table if not exists public.custom_models (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  provider text not null default 'openai_compatible',
  model_id text not null,
  api_key text not null,
  created_at timestamptz not null default now()
);

alter table public.custom_models enable row level security;

drop policy if exists "custom_models_select_own" on public.custom_models;
create policy "custom_models_select_own" on public.custom_models
  for select using (auth.uid() = user_id);

drop policy if exists "custom_models_insert_pro_plus" on public.custom_models;
create policy "custom_models_insert_pro_plus" on public.custom_models
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.subscriptions s
      where s.user_id = auth.uid() and s.tier = 'pro_plus'
    )
  );

drop policy if exists "custom_models_delete_own" on public.custom_models;
create policy "custom_models_delete_own" on public.custom_models
  for delete using (auth.uid() = user_id);

-- No select policy exposes api_key to the client app: the app only selects
-- id,name,provider,model_id. (Column-level revoke can be added later.)
