-- down_0006_calc_logs_quota.sql
--
-- 0006_calc_logs_quota.sql の取り消し。**関数と trigger を落とすだけ。**
-- calc_logs の行・列・RLS・policy には一切触れないので、データは何も変わらない。
-- 取り消した後は、5件枠は従来どおり画面側だけの制御に戻る。
--
-- アプリが save_calc_log を呼ぶ版になっていても、関数が無ければ従来の手順へ戻る作りにしてあること
-- （適用の順序は 0006 の冒頭を参照）。

begin;

drop trigger if exists calc_logs_quota on public.calc_logs;
drop function if exists public.save_calc_log(jsonb);
drop function if exists public.calc_logs_enforce_quota();
drop function if exists public.calc_logs_quota_lock(uuid);
drop function if exists public.calc_logs_is_countable(uuid, boolean, text);
drop function if exists public.calc_logs_limit(uuid);

commit;
