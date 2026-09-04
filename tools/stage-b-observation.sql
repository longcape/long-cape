-- Stage B 観察クエリ
--
--   Supabase の SQL Editor に貼って実行する。読み取りだけで、何も変更しない。
--
-- 【方針】この観察のために **新しい収集を増やしていない。**
-- すでに保存している列（files_received / sessions_parsed / files_rejected /
-- dpi_confirmed / difficulty_varied 等）から導ける範囲だけを見る。
-- 保存前の画面内だけで完結する操作（未ログインの取り込み等）は、
-- そもそもサーバーへ届かないのでここには出ない。第2部の注記を参照。

-- =====================================================================
-- 1. 全体の規模
-- =====================================================================
select
    (select count(*) from auth.users)                                      as 登録ユーザー数,
    (select count(distinct user_id) from public.aim_import_batches)        as 取り込みをしたユーザー数,
    (select count(distinct user_id) from public.aim_sessions)              as 保存したユーザー数,
    (select count(*) from public.aim_import_batches)                       as 取り込み回数,
    (select count(*) from public.aim_sessions)                             as 保存セッション数,
    (select count(*) from public.aim_metrics)                              as 保存metric数,
    (select count(*) from public.user_consents where revoked_at is null)   as 有効な同意数;

-- =====================================================================
-- 2. Import の成功 / 失敗 / unsupported
--    aim_import_batches に保存済みの件数から求める（保存した人のぶんだけ）
-- =====================================================================
select
    count(*)                                             as 取り込み回数,
    sum(files_received)                                  as 受け取ったファイル数,
    sum(sessions_parsed)                                 as 読み取れた数,
    sum(files_rejected)                                  as 読み取れなかった数,
    case when sum(files_received) > 0
         then round(100.0 * sum(files_rejected) / sum(files_received), 1)
         else null end                                   as 失敗率_percent,
    round(avg(adapter_confidence)::numeric, 3)           as 形式判別の確信度_平均
from public.aim_import_batches;

-- 形式ごとの内訳
select coalesce(adapter_format, '(不明)') as 形式,
       count(*) as 回数,
       sum(files_rejected) as 拒否件数
from public.aim_import_batches
group by 1 order by 2 desc;

-- =====================================================================
-- 3. DPI 未確認の割合
-- =====================================================================
select
    count(*)                                                          as 保存セッション数,
    count(*) filter (where dpi_confirmed is null)                     as DPI未確認,
    count(*) filter (where dpi_confirmed is not null)                 as DPI確認済み,
    case when count(*) > 0
         then round(100.0 * count(*) filter (where dpi_confirmed is null) / count(*), 1)
         else null end                                                as DPI未確認率_percent,
    count(*) filter (where dpi_source = 'user_entered')                as 手入力で訂正,
    count(*) filter (where dpi_source = 'user_confirmed_file_value')   as ファイル値を承認
from public.aim_sessions;

-- =====================================================================
-- 4. Recommendation withheld の推定
--    推奨は画面で計算するのでサーバーには残らない。
--    代わりに「推奨が出せる条件を満たしているか」をユーザーごとに数える。
--    条件: 検証済み感度水準が3つ以上、かつ対象セッションが6件以上
-- =====================================================================
with per_user as (
    select user_id,
           count(*) filter (where difficulty_varied = false)                       as 使えるセッション,
           count(distinct cm360) filter (where cm360 is not null
                                           and difficulty_varied = false)          as 感度水準数
    from public.aim_sessions
    group by user_id
)
select
    count(*)                                                                as ユーザー数,
    count(*) filter (where 感度水準数 >= 3 and 使えるセッション >= 6)          as 推奨が出せる人数,
    count(*) filter (where not (感度水準数 >= 3 and 使えるセッション >= 6))    as まだ出せない人数,
    round(avg(感度水準数), 1)                                                as 平均の感度水準数,
    round(avg(使えるセッション), 1)                                           as 平均の使えるセッション数
from per_user;

-- =====================================================================
-- 5. 保存の成功（保存できている人の実態）
-- =====================================================================
select
    date_trunc('day', created_at) as 日,
    count(distinct user_id)       as 保存したユーザー数,
    count(*)                      as 保存セッション数,
    count(*) filter (where difficulty_varied)     as うち適応型,
    count(distinct scenario_identity)             as シナリオ数,
    count(distinct parser_version)                as parser版数
from public.aim_sessions
group by 1 order by 1 desc limit 30;

-- =====================================================================
-- 6. delete / export の痕跡
--    削除は行が消えるので直接は数えられない。
--    「同意はあるが保存が0件」＝削除した可能性が高い、として近似する。
--    Export はサーバーへ何も送らないので **ここには出ない**（第2部を参照）。
-- =====================================================================
select
    c.user_id,
    min(c.granted_at)                                        as 最初の同意,
    count(distinct s.id)                                     as 保存セッション数,
    case when count(distinct s.id) = 0 then '削除済みの可能性' else '保存あり' end as 状態
from public.user_consents c
left join public.aim_sessions s on s.user_id = c.user_id
where c.purpose = 'profile_storage'
group by c.user_id
order by 最初の同意 desc;

-- =====================================================================
-- 7. 同意の内訳（どの目的が選ばれているか）
-- =====================================================================
select purpose                                       as 目的,
       count(*)                                      as 付与の回数,
       count(*) filter (where revoked_at is null)    as いま有効,
       count(*) filter (where revoked_at is not null) as 取り消し済み
from public.user_consents
group by 1 order by 1;

-- =====================================================================
-- 8. 既存への影響がないことの再確認（毎回見る）
-- =====================================================================
select
    (select count(*) from public.calc_logs)   as calc_logs,   -- 27 から増えるのは正常（新規診断）。減っていないこと
    (select count(*) from public.app_config)  as app_config,  -- 18 のまま
    (select count(*) from pg_policies where schemaname='public' and tablename='calc_logs')  as calc_logs_policy,  -- 3
    (select count(*) from pg_policies where schemaname='public' and tablename='app_config') as app_config_policy, -- 2
    (select bool_and(relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind='r') as rls_all_enabled;  -- true
