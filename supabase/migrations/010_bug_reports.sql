-- Bug reports sent from the app (Settings -> Report a bug, or the "Report this problem" prompts).
-- Written only by the submit-bug-report Edge Function and read by the admin site (service role).
create table if not exists public.bug_reports (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  email text,
  message text not null check (char_length(message) between 3 and 4000),
  context jsonb not null default '{}'::jsonb,   -- app version, OS, plan, the error that triggered it
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists bug_reports_status_created on public.bug_reports (status, created_at desc);
alter table public.bug_reports enable row level security;   -- no policies on purpose
