-- One-time codes that hand a website sign-in over to the desktop app (PKCE).
-- Only the Edge Functions (service role) touch this table.
create table if not exists public.app_auth_codes (
  code_hash text primary key,          -- sha256 of the one-time code
  challenge text not null,             -- PKCE challenge created by the app
  token_hash text not null,            -- single-use Supabase OTP hash for this user
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null
);
alter table public.app_auth_codes enable row level security;   -- no policies on purpose
