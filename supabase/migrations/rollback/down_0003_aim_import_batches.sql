-- down_0003_aim_import_batches.sql
--
-- 0003_aim_import_batches の取り消し。**このテーブルを新設した migration の逆操作だけを行う。**
-- 既存の calc_logs / app_config / それらの RLS には一切触れない。
--
-- 実行前の確認:
--   select count(*) from public.aim_import_batches;
--   0件でない場合、ユーザーのデータが消える。実行前に Export を促すこと。

drop table if exists public.aim_import_batches;
