-- down_0005_aim_metrics.sql
--
-- 0005_aim_metrics の取り消し。**このテーブルを新設した migration の逆操作だけを行う。**
-- 既存の calc_logs / app_config / それらの RLS には一切触れない。
--
-- 実行前の確認:
--   select count(*) from public.aim_metrics;
--   0件でない場合、ユーザーのデータが消える。実行前に Export を促すこと。

drop table if exists public.aim_metrics;
