-- down_0001_user_consents.sql
--
-- 0001_user_consents の取り消し。**このテーブルを新設した migration の逆操作だけを行う。**
-- 既存の calc_logs / app_config / それらの RLS には一切触れない。
--
-- 実行前の確認:
--   select count(*) from public.user_consents;
--   0件でない場合、ユーザーのデータが消える。実行前に Export を促すこと。

drop table if exists public.user_consents;
