-- Pro+ custom model endpoints (OpenAI-compatible base URL).
alter table public.custom_models add column if not exists base_url text;
