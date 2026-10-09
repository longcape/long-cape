-- 0006_calc_logs_quota.sql
--
-- ★★★ 未適用の設計案。本番へはまだ流していない。適用には運営者の承認が要る。 ★★★
--
-- 目的: 「マイ感度ログ」の無料5件枠を、画面側だけでなく DB 側でも守る。
--       API を直接呼んでも、複数の端末から同時に保存しても、上限を超えない。
--
-- 何を数えるか（＝アプリが一覧に出す行）:
--   user_id がある / is_deleted_by_user が true でない / 学習用の自動収集（memo が下の2つ）でない
--
-- 既存データへの影響: **行は1つも書き換えない・消さない。** 追加するのは関数3つと trigger 1つだけ。
--   適用前の確認（2026-10-10・読み取りのみ）: 上限を超えている利用者 0 人、1人あたりの最大 4 件。
--
-- 適用の順序（重要）:
--   1. 先にアプリ側を「save_calc_log を使い、無ければ従来の手順へ戻る」版にして公開する
--   2. その後でこのファイルを適用する
--   逆順にすると、従来の手順（古い行を隠す → 追加する、の2回の通信）が別端末との競合時に
--   「戻そうとして上限に当たる」ことがあり、利用者に不要な警告が出る。
--
-- 取り消し: rollback/down_0006_calc_logs_quota.sql（関数と trigger を落とすだけ。データは残る）

begin;

-- ---------------------------------------------------------------------
-- 1. 上限。将来の有料枠（50件）は **この関数だけ** を差し替える。
--    例: entitlements テーブルを見て 50 を返す。null を返すと無制限。
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
-- 2. 上限に数える行かどうか。アプリ（index.html の isAutoCollected）と同じ定義。
--    本番の is_deleted_by_user は null を許すため、null は「表示中」として扱う。
-- ---------------------------------------------------------------------
create or replace function public.calc_logs_is_countable(p_user uuid, p_deleted boolean, p_memo text)
returns boolean
language sql
immutable
as $$
    select p_user is not null
       and not coalesce(p_deleted, false)
       and coalesce(p_memo, '') not in ('自動学習収集データ', '自動収集データ');
$$;

-- ---------------------------------------------------------------------
-- 3. 利用者ごとの直列化に使う鍵。trigger と save_calc_log が同じ鍵を使う。
-- ---------------------------------------------------------------------
create or replace function public.calc_logs_quota_lock(p_user uuid)
returns void
language sql
volatile
as $$
    -- トランザクションが終わるまで保持され、自動で外れる。同じトランザクション内では何度取ってもよい。
    select pg_advisory_xact_lock(hashtextextended('calc_logs_quota:' || p_user::text, 0));
$$;

-- ---------------------------------------------------------------------
-- 4. trigger: 「数える行」が増える操作のたびに、鍵を取ってから数える。
--
--    増える操作 = 追加 / 非表示からの復元 / 学習用の memo から通常の memo への書き換え / user_id の付け替え
--    増えない操作（ロックの切替・非表示にする・既に数えられている行の編集）は素通しする。
--
--    READ COMMITTED（PostgREST の既定）では、鍵を取った後の select は
--    先に終わった他のトランザクションの結果を見る。だから「数えてから入れる」が原子的になる。
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
    if not public.calc_logs_is_countable(new.user_id, new.is_deleted_by_user, new.memo) then
        return new;
    end if;
    if tg_op = 'UPDATE'
       and old.user_id is not distinct from new.user_id
       and public.calc_logs_is_countable(old.user_id, old.is_deleted_by_user, old.memo) then
        return new;
    end if;
    -- 学習ジョブ等（service_role）と管理者は対象外（既存の仕様: 管理者は無制限）
    if coalesce(auth.role(), '') = 'service_role' or public.is_admin() then
        return new;
    end if;

    v_limit := public.calc_logs_limit(new.user_id);
    if v_limit is null then
        return new;
    end if;

    perform public.calc_logs_quota_lock(new.user_id);

    select count(*) into v_count
      from public.calc_logs c
     where c.user_id = new.user_id
       and c.id is distinct from new.id
       and public.calc_logs_is_countable(c.user_id, c.is_deleted_by_user, c.memo);

    if v_count >= v_limit then
        raise exception 'calc_logs_quota_exceeded'
            using errcode = 'P0001',
                  detail = format('limit=%s current=%s', v_limit, v_count),
                  hint = '保存できる件数の上限に達しています。';
    end if;
    return new;
end;
$$;

drop trigger if exists calc_logs_quota on public.calc_logs;
create trigger calc_logs_quota
    before insert or update of user_id, is_deleted_by_user, memo
    on public.calc_logs
    for each row
    execute function public.calc_logs_enforce_quota();

-- ---------------------------------------------------------------------
-- 5. 原子的な保存。「上限なら古い未ロックの行を隠す → 追加する」を1つのトランザクションで行う。
--    途中で失敗すれば全部が取り消されるので、「古い行だけ隠れた」状態は起きない
--    （アプリ側の「復元」処理そのものが要らなくなる）。
--
--    security invoker なので RLS はそのまま効く（自分の行しか読めない・書けない）。
--    user_id は引数から受け取らず、必ず auth.uid() を使う。
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
begin
    if v_uid is null then
        raise exception 'not_authenticated' using errcode = '28000';
    end if;

    perform public.calc_logs_quota_lock(v_uid);

    v_limit := case when public.is_admin() then null else public.calc_logs_limit(v_uid) end;

    if v_limit is not null
       and public.calc_logs_is_countable(v_uid, false, p->>'memo') then
        loop
            select count(*) into v_count
              from public.calc_logs c
             where c.user_id = v_uid
               and public.calc_logs_is_countable(c.user_id, c.is_deleted_by_user, c.memo);
            exit when v_count < v_limit;

            select c.id into v_victim
              from public.calc_logs c
             where c.user_id = v_uid
               and public.calc_logs_is_countable(c.user_id, c.is_deleted_by_user, c.memo)
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
        mouse_weight, aim_part, is_custom, memo, rating, is_locked, is_deleted_by_user
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
        coalesce((p->>'is_custom')::boolean, false),
        p->>'memo',
        coalesce(p->>'rating', 'good'),
        false,
        false
    )
    returning id into v_id;

    return v_id;
end;
$$;

revoke all on function public.save_calc_log(jsonb) from public, anon;
grant execute on function public.save_calc_log(jsonb) to authenticated;

commit;
