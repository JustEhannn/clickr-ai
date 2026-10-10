-- Gemini 2.x / 2.5 models are closed to new accounts; move every plan to Gemini 3.
update public.tier_config set primary_model = 'gemini-3.5-flash-lite', fallback_model = null,                    over_cap = 'block'              where tier = 'free';
update public.tier_config set primary_model = 'gemini-pro-latest',     fallback_model = 'gemini-3.5-flash-lite', over_cap = 'fallback_model'     where tier = 'pro';
update public.tier_config set primary_model = 'gemini-pro-latest',     fallback_model = 'gemini-pro-latest',     over_cap = 'disable_escalation' where tier = 'pro_plus';
