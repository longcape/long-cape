-- 0004_aim_sessions.sql
--
-- 1回の測定セッション。
--
-- 時刻の扱い（重要）:
--   KovaaK のファイル名も CSV 内の時刻も timezone を持たない。
--   勝手に UTC とみなすと、日をまたぐ再現性の判定が壊れる。したがって
--     observed_at_local  … ファイルに書かれていた壁時計の値（timezone なし）
--     observed_at_tz     … 判明している場合の IANA 名（例 Asia/Tokyo）
--     observed_at_utc    … timezone が判明したときだけ埋める
--     timezone_status    … unknown / client_reported / confirmed
--   としてある。unknown のまま UTC 列を埋めることを constraint で禁止する。

create table if not exists public.aim_sessions (
    id                    uuid primary key default gen_random_uuid(),
    user_id               uuid not null references auth.users (id) on delete cascade,
    batch_id              uuid not null references public.aim_import_batches (id) on delete cascade,

    external_id           text,          -- 取り込み元での識別子（ファイル名由来）

    -- 比較スコープの構成要素。**Registry には入れず、ここ（セッション側）に持つ。**
    scenario_name         text,          -- 表示名。改名されうる
    scenario_identity     text,          -- KovaaK の Hash。比較の鍵はこちら
    context_group         text,          -- DPI / 感度スケール / FOV / 解像度 / 入力機器 の署名

    -- 時刻
    observed_at_local     timestamp,     -- timezone なし。ファイルの見たままの値
    observed_at_tz        text,
    observed_at_utc       timestamptz,
    timezone_status       text not null default 'unknown'
        constraint aim_sessions_tz_status_chk
        check (timezone_status in ('unknown', 'client_reported', 'confirmed')),
    constraint aim_sessions_tz_consistency_chk
        check (
            (timezone_status = 'unknown' and observed_at_utc is null and observed_at_tz is null)
            or (timezone_status <> 'unknown' and observed_at_tz is not null)
        ),

    -- 測定条件
    dpi_confirmed         integer
        constraint aim_sessions_dpi_chk check (dpi_confirmed is null or dpi_confirmed > 0),
    dpi_source            text
        constraint aim_sessions_dpi_source_chk
        check (dpi_source is null or dpi_source in
               ('user_confirmed_file_value', 'user_entered', 'file_self_declared', 'unknown')),
    dpi_in_file           integer,       -- KovaaK の自己申告値。confirmed とは別に保持する
    sens_scale            text,
    in_game_sens          numeric
        constraint aim_sessions_sens_chk check (in_game_sens is null or in_game_sens > 0),
    fov                   numeric,
    cm360                 numeric        -- **DPI が確定した場合のみ入れる**
        constraint aim_sessions_cm360_chk check (cm360 is null or cm360 > 0),
    constraint aim_sessions_cm360_requires_dpi_chk
        check (cm360 is null or dpi_confirmed is not null),

    -- 比較可能性
    difficulty_varied     boolean not null default false,
    difficulty_varied_basis text,        -- 例 avg_target_scale=1.367143

    -- 来歴
    source                text not null
        constraint aim_sessions_source_chk check (source in ('kovaak', 'manual')),
    raw_content_hash      text not null
        constraint aim_sessions_hash_chk check (raw_content_hash ~ '^[0-9a-f]{64}$'),
    -- idempotency key の構成要素。batch 側にも持つが、再解析の判定に使うため
    -- session 側にも保持する（batch を消しても判定が壊れないようにする）。
    parser_version        text not null,
    -- **logical_fingerprint は raw_content_hash とは別概念。** 一意制約も張らない。
    logical_fingerprint   text,
    logical_fingerprint_status text not null default 'not_implemented',

    created_at            timestamptz not null default now(),

    -- ---------------------------------------------------------------
    -- idempotency key
    --
    --   user_id + source + raw_content_hash + parser_version
    --
    -- 同じファイルを同じ parser で入れ直しても二重にならない。
    -- **parser を更新したあとの再取り込みは許可する。** 解釈が変わりうるため。
    --
    -- raw_content_hash 単独では unique にしない。単独にすると
    -- parser 更新後の再解析ができなくなる。
    --
    -- 再取り込みは既存行を上書きせず新しい行として増える。これにより
    -- 「どの parser 版で解釈した結果か」が両方残り、将来 supersedes 等の
    -- 世代関係を後から足せる（今は列を作らない）。
    -- ---------------------------------------------------------------
    constraint aim_sessions_idempotency_uniq
        unique (user_id, source, raw_content_hash, parser_version)
);

create index if not exists aim_sessions_user_idx
    on public.aim_sessions (user_id, observed_at_local desc);
create index if not exists aim_sessions_scope_idx
    on public.aim_sessions (user_id, scenario_identity, context_group);
create index if not exists aim_sessions_batch_idx
    on public.aim_sessions (batch_id);
-- 再解析の世代を並べて見るための索引
create index if not exists aim_sessions_reanalysis_idx
    on public.aim_sessions (user_id, raw_content_hash, parser_version);

-- ---------------------------------------------------------------- RLS
alter table public.aim_sessions enable row level security;

create policy "aim_sessions_select_own"
    on public.aim_sessions for select
    to authenticated
    using (auth.uid() = user_id);

create policy "aim_sessions_insert_own"
    on public.aim_sessions for insert
    to authenticated
    with check (
        auth.uid() = user_id
        and exists (
            select 1 from public.aim_import_batches b
            where b.id = batch_id and b.user_id = auth.uid()
        )
    );

-- DPI を後から確定したときに cm360 等を埋められるようにする。
create policy "aim_sessions_update_own"
    on public.aim_sessions for update
    to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

create policy "aim_sessions_delete_own"
    on public.aim_sessions for delete
    to authenticated
    using (auth.uid() = user_id);

comment on table public.aim_sessions is
    '測定セッション。時刻は timezone を勝手に UTC とみなさない。cm360 は DPI 確定時のみ。';
