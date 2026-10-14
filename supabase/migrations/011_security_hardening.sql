-- Security hardening
--  1. Custom-model API keys are no longer stored as plain text: they live in Supabase Vault
--     (encrypted at rest, key held outside the database). custom_models.api_key now holds only
--     the Vault secret id, and only the server (service role) can read the real key.
--  2. Table permissions are narrowed to exactly what the app does, so row-level security is no
--     longer the only thing standing between a logged-in user and the data.

create extension if not exists supabase_vault with schema vault;

-- ---- 1. Vault-backed API keys ------------------------------------------------------------

create or replace function public.custom_models_protect_key()
returns trigger language plpgsql security definer set search_path = public, vault, pg_temp as $$
begin
  new.id := coalesce(new.id, gen_random_uuid());
  -- Store the real key in Vault and keep only its id in this column.
  new.api_key := vault.create_secret(new.api_key, 'custom_model:' || new.id::text)::text;
  return new;
end $$;

create or replace function public.custom_models_forget_key()
returns trigger language plpgsql security definer set search_path = public, vault, pg_temp as $$
begin
  delete from vault.secrets where id = old.api_key::uuid;
  return old;
end $$;

drop trigger if exists custom_models_protect_key on public.custom_models;
create trigger custom_models_protect_key before insert on public.custom_models
  for each row execute function public.custom_models_protect_key();

drop trigger if exists custom_models_forget_key on public.custom_models;
create trigger custom_models_forget_key after delete on public.custom_models
  for each row execute function public.custom_models_forget_key();

-- Move any key that is still plain text into Vault (idempotent: skips rows that already hold an id).
do $$
declare r record;
begin
  for r in select id, api_key from public.custom_models
           where api_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' loop
    update public.custom_models
       set api_key = vault.create_secret(r.api_key, 'custom_model:' || r.id::text)::text
     where id = r.id;
  end loop;
end $$;

-- Server-only way to read a key back (used by the `ask` Edge Function).
create or replace function public.custom_model_key(p_model_id uuid)
returns text language sql security definer set search_path = public, vault, pg_temp as $$
  select ds.decrypted_secret
    from public.custom_models m
    join vault.decrypted_secrets ds on ds.id = m.api_key::uuid
   where m.id = p_model_id
$$;
revoke all on function public.custom_model_key(uuid) from public, anon, authenticated;
grant execute on function public.custom_model_key(uuid) to service_role;

-- ---- 2. Least-privilege table permissions -------------------------------------------------

revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

-- Read-only for the signed-in user (row-level security still limits them to their own rows).
grant select on public.profiles, public.subscriptions, public.usage_windows, public.tier_config to authenticated;

-- What the app writes with the user's own login.
grant select, insert, update, delete on public.chat_history   to authenticated;
grant select, insert, update, delete on public.user_memories  to authenticated;
grant select, insert, update, delete on public.user_devices   to authenticated;
grant select, insert, update          on public.agent_waitlist to authenticated;
grant insert, delete                  on public.custom_models  to authenticated;
-- The saved key (a Vault id) is never readable by the client: list only the harmless columns.
grant select (id, user_id, name, provider, model_id, base_url, created_at) on public.custom_models to authenticated;

-- Tables created in future are private by default; each one must be granted deliberately.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
