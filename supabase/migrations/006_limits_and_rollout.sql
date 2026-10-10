-- 1. Friendlier single-device: a Free user may remove other devices (to take over).
create policy "dev_delete_own" on public.user_devices for delete using (auth.uid() = user_id);

-- 2. Daily web-search quota (counted only when Gemini actually searched).
alter table public.tier_config add column if not exists web_searches_per_day int not null default 10;
update public.tier_config set web_searches_per_day = 10  where tier = 'free';
update public.tier_config set web_searches_per_day = 50  where tier = 'pro';
update public.tier_config set web_searches_per_day = 100 where tier = 'pro_plus';

create table if not exists public.web_search_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null default ((now() at time zone 'utc')::date),
  count int not null default 0,
  primary key (user_id, day)
);
alter table public.web_search_usage enable row level security;   -- service role only

create or replace function public.web_search_remaining(p_user uuid)
returns int language sql security definer stable set search_path = public as $$
  select greatest(0,
    coalesce((select c.web_searches_per_day from public.tier_config c
              where c.tier = coalesce((select s.tier from public.subscriptions s where s.user_id = p_user), 'free'::public.tier)), 10)
    - coalesce((select u.count from public.web_search_usage u
                where u.user_id = p_user and u.day = (now() at time zone 'utc')::date), 0));
$$;

create or replace function public.record_web_search(p_user uuid)
returns void language sql security definer set search_path = public as $$
  insert into public.web_search_usage (user_id, count) values (p_user, 1)
  on conflict (user_id, day) do update set count = public.web_search_usage.count + 1;
$$;
revoke all on function public.web_search_remaining(uuid), public.record_web_search(uuid) from public, anon, authenticated;
grant execute on function public.web_search_remaining(uuid), public.record_web_search(uuid) to service_role;

-- 3. Agent Mode staged rollout: kill switch + allow-list + waitlist + audit log.
create table if not exists public.app_config (key text primary key, value jsonb not null);
alter table public.app_config enable row level security;          -- no policies: service role / definer functions only
insert into public.app_config (key, value) values
  ('agent_enabled', 'true'::jsonb),        -- global kill switch
  ('agent_open_to_all', 'false'::jsonb)    -- flip to true to release to every Pro+ user
on conflict (key) do nothing;

create table if not exists public.agent_beta_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.agent_beta_users enable row level security;

create table if not exists public.agent_waitlist (
  user_id uuid primary key references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now()
);
alter table public.agent_waitlist enable row level security;
create policy "waitlist_insert_own" on public.agent_waitlist for insert with check (auth.uid() = user_id);
create policy "waitlist_select_own" on public.agent_waitlist for select using (auth.uid() = user_id);

-- Every agent step is logged by tool name only (never typed text or file contents).
create table if not exists public.agent_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  tool text not null,
  errored boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.agent_events enable row level security;

create or replace function public.agent_access_for(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select (value)::text = 'true' from public.app_config where key = 'agent_enabled'), false)
     and exists (select 1 from public.subscriptions s where s.user_id = p_user and s.tier = 'pro_plus')
     and (coalesce((select (value)::text = 'true' from public.app_config where key = 'agent_open_to_all'), false)
          or exists (select 1 from public.agent_beta_users b where b.user_id = p_user));
$$;
create or replace function public.has_agent_access()
returns boolean language sql security definer stable set search_path = public as $$
  select public.agent_access_for(auth.uid());
$$;
revoke all on function public.agent_access_for(uuid) from public, anon, authenticated;
grant execute on function public.agent_access_for(uuid) to service_role;
grant execute on function public.has_agent_access() to authenticated;

-- Handy for watching the rollout:
create or replace view public.agent_daily_stats as
  select created_at::date as day, count(*) as steps, count(distinct user_id) as users,
         count(*) filter (where errored) as errors
  from public.agent_events group by 1 order by 1 desc;
revoke all on public.agent_daily_stats from public, anon, authenticated;
