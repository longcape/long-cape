-- 0006_calc_logs_quota.sql
--
-- ★★★ 未適用。本番へはまだ流していない。適用には運営者の承認が要る。 ★★★
--
-- 目的: 「マイ感度ログ」の無料5件枠を、画面側だけでなく DB 側でも守る。
--       API を直接呼んでも、複数の端末・複数の接続から同時に保存しても、上限を超えない。
--
-- 用語:
--   通常の行 … 保存した診断結果・感度メモ。**5件枠に数える。**
--   学習用の行 … 診断時の「現在の感度」から自動で送られる行。**数えない。**
--               source = 'diagnosis_auto' で表す。この印を付けられるのは、
--               「memo が自動収集の決まった文言」「is_custom でない」「ロックされていない」行だけ。
--               つまり **学習用の印を付けた行は、通常のメモとしては使えない形に固定される。**
--               印を外して通常の行へ戻すと、その時点で5件枠の検査を受ける。
--
-- 既存データへの影響:
--   - 行を消さない。既存の列の値も変えない。
--   - 唯一の書き込みは末尾の「印の付け直し」（source が空で、中身が学習用の形をした本人名義の行に
--     source = 'diagnosis_auto' を入れる）。適用前の確認で 0 行（2026-10-10・読み取りのみ）。
--   - 上限を超えている利用者 0 人、1人あたりの最大 4 件（同上）。
--
-- 適用の順序（重要）:
--   1. 先にアプリ側（save_calc_log を呼び、無ければ従来の手順へ戻る版）を公開する
--   2. その後でこのファイルを適用する
--
-- 取り消し: down_0006_calc_logs_quota.sql（関数と trigger を落とすだけ。行は変わらない）
-- 検証:     verify_0006.mjs（手元の Postgres 17。複数接続の同時保存を含む）

begin;

-- ---------------------------------------------------------------------
-- 1. 上限。将来の有料枠（50件）は **この関数だけ** を差し替える。null を返すと無制限。
--    例: entitlements テーブルを見て、有効な有料プランなら 50 を返す。
-- ---------------------------------------------------------------------
create or replace function public.calc_logs_limit(p_user uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select 5;
$$;

-- ---------------------------------------------------------------------
-- 2. 5件枠に数える行かどうか。
--    本番の is_deleted_by_user は null を許すため、null は「表示中」として扱う。
--    memo は見ない（memo は利用者が自由に書けるので、判定に使うと偽装できる）。
-- ---------------------------------------------------------------------
create or replace function public.calc_logs_is_countable(p_user uuid, p_deleted boolean, p_source text)
returns boolean
language sql
immutable
as $$
    select p_user is not null
       and not coalesce(p_deleted, false)
       and p_source is distinct from 'diagnosis_auto';
$$;

create or replace function public.calc_logs_is_auto_memo(p_memo text)
returns boolean
language sql
immutable
as $$
    select coalesce(p_memo, '') in ('自動学習収集データ', '自動収集データ');
$$;

-- ---------------------------------------------------------------------
-- 3. 利用者ごとの直列化に使う鍵。trigger と save_calc_log が同じ鍵を使う。
--    トランザクションが終わるまで保持され、自動で外れる。同じトランザクション内では何度取ってもよい。
-- ---------------------------------------------------------------------
create or replace function public.calc_logs_quota_lock(p_user uuid)
returns void
language sql
volatile
as $$
    select pg_advisory_xact_lock(hashtextextended('calc_logs_quota:' || p_user::text, 0));
$$;

-- ---------------------------------------------------------------------
-- 4. trigger その1: 学習用の印の整合。（名前順で quota より先に動く）
--
--    - 古い版のアプリ（source を送らない）が入れた学習用の行に、印を付ける
--    - 学習用の印が付いた行は、決まった形（自動収集の memo・is_custom でない・未ロック）しか許さない
--      → 学習用の印を付けたまま、通常のメモとして使うことはできない
-- ---------------------------------------------------------------------
create or replace function public.calc_logs_guard_source()
returns trigger
language plpgsql
as $$
begin
    if tg_op = 'INSERT'
       and new.source is null
       and new.user_id is not null
       and public.calc_logs_is_auto_memo(new.memo)
       and not coalesce(new.is_custom, false) then
        new.source := 'diagnosis_auto';
    end if;

    if new.source = 'diagnosis_auto' then
        if not public.calc_logs_is_auto_memo(new.memo)
           or coalesce(new.is_custom, false)
           or coalesce(new.is_locked, false) then
            raise exception 'calc_logs_learning_row_invalid'
                using errcode = '23514',
                      hint = '学習用の行は、自動収集の memo・is_custom=false・未ロックでなければなりません。';
        end if;
    end if;
    return new;
end;
$$;

drop trigger if exists calc_logs_a_guard_source on public.calc_logs;
create trigger calc_logs_a_guard_source
    before insert or update
    on public.calc_logs
    for each row
    execute function public.calc_logs_guard_source();

-- ---------------------------------------------------------------------
-- 5. trigger その2: 5件枠。
--
--    「数える行」が増える操作のたびに、鍵を取ってから数える。
--    増える操作 = 追加 / 非表示からの復元 / 学習用の印を外す / user_id の付け替え
--    増えない操作（ロックの切替・非表示にする・既に数えられている行の編集）は素通しする。
--
--    READ COMMITTED（PostgREST の既定）では、鍵を取った後の select は、
--    先に終わった他のトランザクションの結果を見る。だから「数えてから入れる」が原子的になる。
--
--    対象外: ログインした利用者の操作でないもの（auth.uid() が空 = 学習ジョブ・管理画面からの SQL）と、
--            管理者（既存の仕様: 管理者は無制限）。
--            未ログインの利用者は user_id が空の行しか入れられない（RLS）ので、そもそも数える行を作れない。
-- ---------------------------------------------------------------------
create or replace function public.calc_logs_enforce_quota()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_limit integer;
    v_count integer;
begin
    if not public.calc_logs_is_countable(new.user_id, new.is_deleted_by_user, new.source) then
        return new;
    end if;
    if tg_op = 'UPDATE'
       and old.user_id is not distinct from new.user_id
       and public.calc_logs_is_countable(old.user_id, old.is_deleted_by_user, old.source) then
        return new;
    end if;
    if auth.uid() is null or public.is_admin() then
        return new;
    end if;

    v_limit := public.calc_logs_limit(new.user_id);
    if v_limit is null then
        return new;
    end if;

    -- 件数の検査は「鍵を取った後に、他の保存の結果が見える」ことに頼っている。
    -- スナップショットを固定する分離レベル（REPEATABLE READ / SERIALIZABLE）ではそれが成り立たないので、断る。
    -- PostgREST（Supabase の API）は READ COMMITTED で動くため、通常の利用では起きない。
    if current_setting('transaction_isolation') <> 'read committed' then
        raise exception 'calc_logs_isolation_not_supported' using errcode = '0A000';
    end if;

    perform public.calc_logs_quota_lock(new.user_id);

    select count(*) into v_count
      from public.calc_logs c
     where c.user_id = new.user_id
       and c.id is distinct from new.id
       and public.calc_logs_is_countable(c.user_id, c.is_deleted_by_user, c.source);

    if v_count >= v_limit then
        raise exception 'calc_logs_quota_exceeded'
            using errcode = 'P0001',
                  detail = format('limit=%s current=%s', v_limit, v_count),
                  hint = '保存できる件数の上限に達しています。';
    end if;
    return new;
end;
$$;

drop trigger if exists calc_logs_b_quota on public.calc_logs;
create trigger calc_logs_b_quota
    before insert or update
    on public.calc_logs
    for each row
    execute function public.calc_logs_enforce_quota();

-- ---------------------------------------------------------------------
-- 6. 原子的な保存。「上限なら古い未ロックの行を隠す → 追加する」を1つのトランザクションで行う。
--    途中で失敗すれば全部が取り消されるので、「古い行だけ隠れた」状態は起きない。
--
--    security invoker なので RLS はそのまま効く（自分の行しか読めない・書けない）。
--    user_id は引数から受け取らず、必ず auth.uid() を使う。
--    source は 'memo'（感度メモ）か 'diagnosis_result'（診断結果の保存）で、学習用の印は付けられない。
-- ---------------------------------------------------------------------
create or replace function public.save_calc_log(p jsonb)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
    v_uid    uuid := auth.uid();
    v_limit  integer;
    v_count  integer;
    v_victim uuid;
    v_id     uuid;
    v_custom boolean := coalesce((p->>'is_custom')::boolean, false);
begin
    if v_uid is null then
        raise exception 'not_authenticated' using errcode = '28000';
    end if;

    -- 件数の検査は「鍵を取った後に、他の保存の結果が見える」ことに頼っている。
    -- スナップショットを固定する分離レベル（REPEATABLE READ / SERIALIZABLE）ではそれが成り立たないので、断る。
    -- PostgREST（Supabase の API）は READ COMMITTED で動くため、通常の利用では起きない。
    if current_setting('transaction_isolation') <> 'read committed' then
        raise exception 'calc_logs_isolation_not_supported' using errcode = '0A000';
    end if;

    perform public.calc_logs_quota_lock(v_uid);

    v_limit := case when public.is_admin() then null else public.calc_logs_limit(v_uid) end;

    if v_limit is not null then
        loop
            select count(*) into v_count
              from public.calc_logs c
             where c.user_id = v_uid
               and public.calc_logs_is_countable(c.user_id, c.is_deleted_by_user, c.source);
            exit when v_count < v_limit;

            select c.id into v_victim
              from public.calc_logs c
             where c.user_id = v_uid
               and public.calc_logs_is_countable(c.user_id, c.is_deleted_by_user, c.source)
               and not coalesce(c.is_locked, false)
             order by c.created_at asc, c.id asc
             limit 1;

            if v_victim is null then
                raise exception 'calc_logs_all_locked' using errcode = 'P0001';
            end if;

            update public.calc_logs set is_deleted_by_user = true where id = v_victim;
        end loop;
    end if;

    insert into public.calc_logs (
        user_id, game, dpi, final_sens, height, dexterity, play_style,
        mouse_weight, aim_part, is_custom, memo, rating, is_locked, is_deleted_by_user, source
    ) values (
        v_uid,
        p->>'game',
        (p->>'dpi')::numeric,
        p->>'final_sens',
        nullif(p->>'height', '')::numeric,
        p->>'dexterity',
        p->>'play_style',
        p->>'mouse_weight',
        p->>'aim_part',
        v_custom,
        p->>'memo',
        coalesce(p->>'rating', 'good'),
        false,
        false,
        case when v_custom then 'memo' else 'diagnosis_result' end
    )
    returning id into v_id;

    return v_id;
end;
$$;

revoke all on function public.save_calc_log(jsonb) from public, anon;
grant execute on function public.save_calc_log(jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 7. 印の付け直し（1回だけ意味がある。繰り返しても同じ結果）
--    アプリが source を送り始める前に入った「学習用の形をした本人名義の行」に印を付ける。
--    これをしないと、その行が通常の行として数えられ、画面に出ないのに枠を消費してしまう。
--    値を入れるのは空だった source だけで、ほかの列・行には触れない。
-- ---------------------------------------------------------------------
update public.calc_logs
   set source = 'diagnosis_auto'
 where source is null
   and user_id is not null
   and public.calc_logs_is_auto_memo(memo)
   and not coalesce(is_custom, false)
   and not coalesce(is_locked, false);

commit;
