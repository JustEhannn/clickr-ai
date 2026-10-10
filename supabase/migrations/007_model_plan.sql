-- Model plan: Free = Flash-Lite (hard cooldown); Pro = 2.5 Pro then Flash-Lite after the daily cap;
-- Pro+ = 2.5 Pro, with Claude escalation handled in the ask function (stops past the fair-use ceiling).
update public.tier_config set primary_model = 'gemini-2.5-flash-lite', fallback_model = null,                   over_cap = 'block'              where tier = 'free';
update public.tier_config set primary_model = 'gemini-2.5-pro',        fallback_model = 'gemini-2.5-flash-lite', over_cap = 'fallback_model'     where tier = 'pro';
update public.tier_config set primary_model = 'gemini-2.5-pro',        fallback_model = 'gemini-2.5-pro',        over_cap = 'disable_escalation' where tier = 'pro_plus';
