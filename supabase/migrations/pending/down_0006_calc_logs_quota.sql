-- down_0006_calc_logs_quota.sql
--
-- 0006_calc_logs_quota.sql の取り消し。**関数と trigger を落とすだけ。**
-- calc_logs の行・列・RLS・policy には一切触れないので、データは何も変わらない。
-- （0006 が付けた source = 'diagnosis_auto' の印は残す。害は無く、消すと再適用のときに判別できなくなる）
-- 取り消した後は、5件枠は従来どおり画面側だけの制御に戻る。
-- アプリは save_calc_log が無ければ従来の手順へ戻る作りなので、取り消しても保存は動く。

begin;

drop trigger if exists calc_logs_b_quota on public.calc_logs;
drop trigger if exists calc_logs_a_guard_source on public.calc_logs;
drop function if exists public.save_calc_log(jsonb);
drop function if exists public.calc_logs_enforce_quota();
drop function if exists public.calc_logs_guard_source();
drop function if exists public.calc_logs_quota_lock(uuid);
drop function if exists public.calc_logs_is_countable(uuid, boolean, text);
drop function if exists public.calc_logs_is_auto_memo(text);
drop function if exists public.calc_logs_limit(uuid);

commit;
