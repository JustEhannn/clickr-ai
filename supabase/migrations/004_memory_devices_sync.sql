-- Run this in the Supabase SQL editor (the project's edge functions/tables are
-- managed there). Assumes public.subscriptions(user_id, tier).

create or replace function public.is_paid(min_tier text)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.subscriptions s
    where s.user_id = auth.uid()
      and (s.tier = 'pro_plus' or (min_tier = 'pro' and s.tier = 'pro'))
  );
$$;

-- Pro: persistent memory ------------------------------------------------
create table if not exists public.user_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (char_length(content) <= 500),
  created_at timestamptz not null default now()
);
alter table public.user_memories enable row level security;
create policy "mem_select_own" on public.user_memories for select using (auth.uid() = user_id);
create policy "mem_insert_pro" on public.user_memories for insert
  with check (auth.uid() = user_id and public.is_paid('pro'));
create policy "mem_delete_own" on public.user_memories for delete using (auth.uid() = user_id);

-- Free: one device; Pro+: unlimited ------------------------------------
create table if not exists public.user_devices (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, device_id)
);
alter table public.user_devices enable row level security;
create policy "dev_select_own" on public.user_devices for select using (auth.uid() = user_id);
-- Free accounts may register only if they have no device yet.
create policy "dev_insert" on public.user_devices for insert with check (
  auth.uid() = user_id
  and (public.is_paid('pro') or not exists (select 1 from public.user_devices d where d.user_id = auth.uid()))
);

-- Pro: conversation history synced across devices ----------------------
create table if not exists public.chat_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  data jsonb not null,
  updated_at bigint not null,
  primary key (user_id, id)
);
alter table public.chat_history enable row level security;
create policy "hist_select_pro" on public.chat_history for select using (auth.uid() = user_id and public.is_paid('pro'));
create policy "hist_insert_pro" on public.chat_history for insert with check (auth.uid() = user_id and public.is_paid('pro'));
create policy "hist_update_pro" on public.chat_history for update using (auth.uid() = user_id and public.is_paid('pro'));
create policy "hist_delete_own" on public.chat_history for delete using (auth.uid() = user_id);
