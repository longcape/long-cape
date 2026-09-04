-- =====================================================================
-- ロングケープの定理 — Supabase スキーマ / RLS ポリシー
--
-- 【⛔ 本番へこのファイル全体を再実行してはいけない】
--   本番へは supabase/migrations/ の additive migration を順に適用すること。
--   このファイルは「最新の完全 schema」を人が読むための正本であり、適用手順ではない。
--   全体再実行は drop policy → create policy に相当する状態を作りうるため、
--   保護が一時的に消える危険がある。
--
--   * 新規環境の初期構築  … このファイルを使ってよい
--   * 既存の本番環境      … supabase/migrations/ のみを使う
--
-- 【重要】このファイルは自動では適用されません。
-- Supabase ダッシュボード → SQL Editor に貼り付けて実行してください。
--
-- 現状、管理画面（loadAdminData）はクライアント側のメールアドレス判定だけで
-- 全ログを取得しています。ブラウザ側の判定は誰でも書き換えられるため、
-- 「他人の感度ログを読めないこと」はサーバー側の RLS で担保する必要があります。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. app_config : 学習で更新される係数の置き場
-- ---------------------------------------------------------------------
create table if not exists public.app_config (
    key         text primary key,          -- upsert(on_conflict="key") のために PRIMARY KEY が必須
    value       numeric not null,
    updated_at  timestamptz not null default now()
);

alter table public.app_config enable row level security;

-- 誰でも読める（フロントが計算に使うため）／書き込みは service_role のみ（学習ジョブ）。
-- 書き込みを許す旧ポリシーが残っていると係数を誰にでも改ざんされるため、
-- app_config 側にも INSERT / UPDATE / DELETE のポリシーが無いことを確認すること。
drop policy if exists "app_config は全員が読み取り可" on public.app_config;
create policy "app_config は全員が読み取り可"
    on public.app_config for select
    to anon, authenticated
    using (true);

-- ---------------------------------------------------------------------
-- 2. calc_logs : 診断ログ・感度メモ・学習用データ
-- ---------------------------------------------------------------------
create table if not exists public.calc_logs (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid references auth.users(id) on delete cascade,
    game                text not null,
    dpi                 numeric,
    final_sens          text,              -- 単位記号を含めず数値文字列で保存する
    height              numeric,
    dexterity           text,              -- 手先の器用さ  (1〜5)
    play_style          text,              -- 腕の太さ      (slim / normal / heavy)
    mouse_weight        text,              -- マウス重量    (ultra / standard / mid / heavy / ultraheavy)
    aim_part            text,              -- エイムの支点  (wrist / arm / shoulder)
    is_custom           boolean not null default false,
    memo                text,
    rating              text default 'good',
    is_locked           boolean not null default false,
    is_deleted_by_user  boolean not null default false,
    created_at          timestamptz not null default now(),

    -- ▼ 2026-09-01 追加。すべて nullable で、既存行・既存コードには影響しない。
    source              text,          -- 行の出どころ。下記 2-A 参照
    session_id          text,          -- 同一セッション（1 回の試行錯誤）をまとめる識別子
    input_params        jsonb,         -- 入力条件のスナップショット。項目追加時に migration を不要にする
    config_version      timestamptz,   -- 診断時点の app_config.updated_at（後から再計算するため）
    client_lang         text           -- 表示言語（ja / en / ko）
);

-- ---------------------------------------------------------------------
-- 2-A. 既存環境への追加（このファイルを再実行しても安全）
--
-- create table if not exists は既存テーブルに列を足さないため、
-- 本番へは下記の alter が必要。いずれも nullable かつデフォルト無しなので
-- 既存行の書き換えは発生せず、実行は一瞬で終わる。
--
-- 【重要】列を追加する前にフロント側から書き込むと insert が失敗する。
--   適用順序: このファイルを本番へ適用する → その後で index.html 側の書き込みを追加する。
--   2026-09-01 時点では index.html はこれらの列へ一切書き込んでいない。
--
-- source に入れる想定値（現在は memo 文字列で判別しており、表記揺れに弱い）:
--   'diagnosis_auto'   … 診断フォームの「現在の感度」自動収集（学習に使う）
--   'memo'             … 感度メモタブからの保存（学習に使う）
--   'diagnosis_result' … 診断結果そのものの保存（自己強化ループ防止のため学習に使わない）
--   'import'           … 将来の外部データ取込
-- 値が入り始めたら train_model.py の教師データ選別を memo 判定から source 判定へ
-- 切り替える。切替は「source が null の行は従来どおり memo で判定」する併用から始める。
-- ---------------------------------------------------------------------
alter table public.calc_logs add column if not exists source         text;
alter table public.calc_logs add column if not exists session_id     text;
alter table public.calc_logs add column if not exists input_params   jsonb;
alter table public.calc_logs add column if not exists config_version timestamptz;
alter table public.calc_logs add column if not exists client_lang    text;

create index if not exists calc_logs_user_idx    on public.calc_logs (user_id, created_at desc);
create index if not exists calc_logs_learn_idx   on public.calc_logs (game, is_custom, created_at);
-- 学習ジョブが source で絞り込めるようになったとき用
create index if not exists calc_logs_source_idx  on public.calc_logs (source, game, created_at);

-- 追加した列は行単位の RLS で保護されるため、既存ポリシーの変更は不要。
-- （Postgres の RLS は列単位ではなく行単位で効く）

alter table public.calc_logs enable row level security;

-- 管理者判定はサーバー側（JWT のメールアドレス）で行う
create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
    select coalesce(auth.jwt() ->> 'email', '') = 'rokikiroki@gmail.com';
$$;

-- 旧ポリシーの削除。
-- Postgres の PERMISSIVE ポリシーは条件が OR で結合されるため、緩い旧ポリシーが
-- 残っていると下記の制限が無効化される。特に "Allow select for own logs or anonymous"
-- は未ログインで作成された行を誰にでも見せてしまうので、必ず削除する。
drop policy if exists "Allow insert for all users" on public.calc_logs;
drop policy if exists "Allow select for own logs or anonymous" on public.calc_logs;
drop policy if exists "Users can update their own calc_logs" on public.calc_logs;

-- 参照：自分のログ、または管理者のみ
drop policy if exists "自分のログのみ参照可（管理者は全件）" on public.calc_logs;
create policy "自分のログのみ参照可（管理者は全件）"
    on public.calc_logs for select
    to anon, authenticated
    using (
        (auth.uid() is not null and user_id = auth.uid())
        or public.is_admin()
    );

-- 追加：ログイン中は自分の user_id でのみ、未ログインは user_id = null でのみ挿入可
drop policy if exists "自分名義のログのみ追加可" on public.calc_logs;
create policy "自分名義のログのみ追加可"
    on public.calc_logs for insert
    to anon, authenticated
    with check (
        (auth.uid() is not null and user_id = auth.uid())
        or (auth.uid() is null and user_id is null)
    );

-- 更新：自分のログのみ（ロック・削除フラグの操作用）
drop policy if exists "自分のログのみ更新可" on public.calc_logs;
create policy "自分のログのみ更新可"
    on public.calc_logs for update
    to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid());

-- 物理削除は許可しない（アプリは is_deleted_by_user フラグで論理削除する）
-- 学習ジョブは service_role キーを使うため、RLS を迂回して全件を集計できる。

-- ---------------------------------------------------------------------
-- 3. 既存データの後始末（任意・1回だけ実行）
--    旧実装が Fortnite / Overwatch の感度を "6.50%" のような文字列で
--    保存していたぶんを、数値文字列に正規化する。
-- ---------------------------------------------------------------------
-- update public.calc_logs
--    set final_sens = replace(final_sens, '%', '')
--  where final_sens like '%\%';


-- =====================================================================
-- Aim 系（G-4 で追加予定）
--
-- 【正本表示用】実際の適用は supabase/migrations/0001〜0005 で行う。
-- 以下は「適用後にこうなる」という完全 schema の記述であり、ここから
-- コピーして本番へ流さないこと。
-- =====================================================================

-- ----- 0001_user_consents.sql -----
-- 0001_user_consents.sql
--
-- 同意の記録。**Aim 系のデータを保存する前に、これが無いと何も保存しない。**
--
-- 方針:
--   * 目的ごとに1行。1つのチェックボックスへまとめない。
--   * model_improvement を他の同意と同じ行に入れない（purpose が別行なので構造的に混ざらない）。
--   * 付与と取り消しの履歴を残す。revoked_at が null の行が「今有効な同意」。
--
-- このファイルは additive のみ。既存の calc_logs / app_config には一切触れない。

create table if not exists public.user_consents (
    id             uuid primary key default gen_random_uuid(),
    user_id        uuid not null references auth.users (id) on delete cascade,

    -- 目的。増やすときは新しい migration で constraint を張り替える。
    purpose        text not null
        constraint user_consents_purpose_chk
        check (purpose in ('profile_storage', 'anonymized_statistics', 'model_improvement')),

    -- 同意文言の版。文言を変えたら版を上げ、再同意を求める。
    consent_version text not null,

    granted_at     timestamptz not null default now(),
    revoked_at     timestamptz,

    -- 監査用。個人を特定しうる値は入れない。
    source         text not null default 'web_ui',

    created_at     timestamptz not null default now(),

    constraint user_consents_revoked_after_granted_chk
        check (revoked_at is null or revoked_at >= granted_at)
);

-- 同じ目的で有効な同意は同時に1つだけ。取り消し済みは履歴として複数残る。
create unique index if not exists user_consents_active_uniq
    on public.user_consents (user_id, purpose)
    where revoked_at is null;

create index if not exists user_consents_user_idx
    on public.user_consents (user_id, purpose, granted_at desc);

-- ---------------------------------------------------------------- RLS
-- テーブル作成と同じ migration で有効化する。保護が無い時間帯を作らない。
alter table public.user_consents enable row level security;

-- 本人のみ。anon には policy を一切作らないので、未ログインは全操作が拒否される。
create policy "user_consents_select_own"
    on public.user_consents for select
    to authenticated
    using (auth.uid() = user_id);

create policy "user_consents_insert_own"
    on public.user_consents for insert
    to authenticated
    with check (auth.uid() = user_id);

-- 取り消し（revoked_at を立てる）のための更新。user_id の付け替えは with check で禁止。
create policy "user_consents_update_own"
    on public.user_consents for update
    to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

create policy "user_consents_delete_own"
    on public.user_consents for delete
    to authenticated
    using (auth.uid() = user_id);

comment on table public.user_consents is
    '同意の記録。目的ごとに1行で、まとめない。revoked_at が null の行が有効な同意。';


-- ----- 0002_aim_metric_registry.sql -----
-- 0002_aim_metric_registry.sql
--
-- Metric Registry の DB 側の写し。
--
-- 【重要】**正本は Git の metrics.json であり、この表ではない。**
-- 人間がこの表を直接編集してはいけない。中身は tools/sync-metric-registry-sql.mjs が
-- metrics.json から生成し、drift detection（--check）が CI で差分を検出する。
--
-- なぜ DB にも持つのか:
--   aim_metrics から (metric_key, metric_version, unit) を外部キーで参照させることで、
--   単位の取り違え（accuracy を 0〜1 と 0〜100 で混ぜる、ms と s を混ぜる等）を
--   アプリの実装ミスに関係なくDB側で弾くため。

create table if not exists public.aim_metric_registry (
    metric_key             text not null,
    metric_version         text not null,
    unit                   text not null,
    layer                  text not null,
    concept                text not null,
    comparability_group    text not null,
    comparability_rule     text not null
        constraint aim_metric_registry_rule_chk
        check (comparability_rule in
               ('same_scenario', 'cross_scenario', 'condition', 'kill_level', 'unresolved')),
    rating_status          text not null
        constraint aim_metric_registry_status_chk
        check (rating_status in ('rated', 'unrated')),
    recommendation_eligible boolean not null,
    recommendation_hold     boolean not null default false,
    usage_prohibited        boolean not null default false,

    -- 生成元の追跡
    registry_version       text not null,
    synced_at              timestamptz not null default now(),

    primary key (metric_key, metric_version),

    -- aim_metrics からの外部キーの受け先。単位まで含めて一致を要求する。
    constraint aim_metric_registry_key_unit_uniq
        unique (metric_key, metric_version, unit)
);

create index if not exists aim_metric_registry_group_idx
    on public.aim_metric_registry (comparability_group);

-- ---------------------------------------------------------------- RLS
alter table public.aim_metric_registry enable row level security;

-- 参照は誰でも可（個人データではない定義情報）。
create policy "aim_metric_registry_select_all"
    on public.aim_metric_registry for select
    to anon, authenticated
    using (true);

-- **書き込みの policy を作らない。** これにより anon / authenticated からの
-- INSERT / UPDATE / DELETE はすべて拒否される。更新は migration（service role）だけが行う。

comment on table public.aim_metric_registry is
    '正本は Git の metrics.json。この表は生成物であり手で編集しない。単位の取り違えを外部キーで防ぐために存在する。';


-- ----- 0003_aim_import_batches.sql -----
-- 0003_aim_import_batches.sql
--
-- 1回の取り込み操作。来歴（provenance）をここに集める。
--
-- 【方針】**元の CSV そのものは保存しない。**
-- 保存するのは SHA-256 / source / parser 版 / normalization 版 / 取り込み時刻 / schema。
-- 理由は G-4A レビュー第10節に記載（個人情報・容量・規約・削除対応を単純にするため）。

create table if not exists public.aim_import_batches (
    id                    uuid primary key default gen_random_uuid(),
    user_id               uuid not null references auth.users (id) on delete cascade,

    -- どこから来たか
    source                text not null
        constraint aim_import_batches_source_chk
        check (source in ('kovaak', 'manual')),
    source_app_version    text,          -- 例: KovaaK の Game Version
    adapter_format        text,          -- 例: current_stats_csv
    adapter_confidence    numeric
        constraint aim_import_batches_confidence_chk
        check (adapter_confidence is null or (adapter_confidence >= 0 and adapter_confidence <= 1)),

    -- どう解釈したか。版が変われば再解釈が要ることが分かる。
    parser_version        text not null,
    normalization_version text not null,
    registry_version      text not null,

    -- 何件受け取り、何件解析できたか
    files_received        integer not null default 0
        constraint aim_import_batches_files_chk check (files_received >= 0),
    sessions_parsed       integer not null default 0
        constraint aim_import_batches_parsed_chk check (sessions_parsed >= 0),
    files_rejected        integer not null default 0
        constraint aim_import_batches_rejected_chk check (files_rejected >= 0),

    -- どの同意にもとづいて保存したか。**同意が無ければ保存しない**ことを構造で示す。
    consent_id            uuid not null references public.user_consents (id) on delete cascade,

    imported_at           timestamptz not null default now(),
    created_at            timestamptz not null default now()
);

create index if not exists aim_import_batches_user_idx
    on public.aim_import_batches (user_id, imported_at desc);

-- ---------------------------------------------------------------- RLS
alter table public.aim_import_batches enable row level security;

create policy "aim_import_batches_select_own"
    on public.aim_import_batches for select
    to authenticated
    using (auth.uid() = user_id);

-- 挿入時に「自分の、かつ有効な profile_storage 同意」が必要。
-- 同意していないユーザーは、そもそも1行も作れない。
create policy "aim_import_batches_insert_own_with_consent"
    on public.aim_import_batches for insert
    to authenticated
    with check (
        auth.uid() = user_id
        and exists (
            select 1 from public.user_consents c
            where c.id = consent_id
              and c.user_id = auth.uid()
              and c.purpose = 'profile_storage'
              and c.revoked_at is null
        )
    );

create policy "aim_import_batches_delete_own"
    on public.aim_import_batches for delete
    to authenticated
    using (auth.uid() = user_id);

-- **UPDATE の policy を作らない。** 取り込み記録は後から書き換えない（来歴の改変防止）。
-- 取り消したいときは削除する。

comment on table public.aim_import_batches is
    '取り込み1回分の来歴。元CSVは保存しない。profile_storage 同意が無ければ INSERT できない。';


-- ----- 0004_aim_sessions.sql -----
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
    -- **logical_fingerprint は raw_content_hash とは別概念。** 一意制約も張らない。
    logical_fingerprint   text,
    logical_fingerprint_status text not null default 'not_implemented',

    created_at            timestamptz not null default now(),

    -- 同じユーザーが同じ中身のファイルを何度取り込んでも増殖させない。
    constraint aim_sessions_user_hash_uniq unique (user_id, raw_content_hash)
);

create index if not exists aim_sessions_user_idx
    on public.aim_sessions (user_id, observed_at_local desc);
create index if not exists aim_sessions_scope_idx
    on public.aim_sessions (user_id, scenario_identity, context_group);
create index if not exists aim_sessions_batch_idx
    on public.aim_sessions (batch_id);

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


-- ----- 0005_aim_metrics.sql -----
-- 0005_aim_metrics.sql
--
-- セッションに紐づく metric の値。
--
-- 単位の取り違え対策（G-4A 第13節）:
--   1. (metric_key, metric_version, unit) を aim_metric_registry へ外部キーで参照する。
--      Registry に登録されていない単位では、そもそも INSERT できない。
--   2. 単位ごとの値域を CHECK で縛る。ratio は 0〜1、percent は 0〜100。
--      これにより accuracy を 0〜100 で入れる事故が DB 側で止まる。

create table if not exists public.aim_metrics (
    id             uuid primary key default gen_random_uuid(),

    -- RLS を単純にするため user_id を非正規化して持つ。session 側と一致することを
    -- INSERT policy で検証する。
    user_id        uuid not null references auth.users (id) on delete cascade,
    session_id     uuid not null references public.aim_sessions (id) on delete cascade,

    metric_key     text not null,
    metric_version text not null,
    unit           text not null,
    value          numeric not null,

    -- 武器別の値のとき。session レベルの値は null。
    weapon         text,

    created_at     timestamptz not null default now(),

    -- Registry に無い metric / 単位は登録できない
    constraint aim_metrics_registry_fk
        foreign key (metric_key, metric_version, unit)
        references public.aim_metric_registry (metric_key, metric_version, unit),

    -- 単位ごとの値域。行の列だけで判定できるので CHECK で書ける。
    constraint aim_metrics_ratio_range_chk
        check (unit <> 'ratio' or (value >= 0 and value <= 1)),
    constraint aim_metrics_percent_range_chk
        check (unit <> 'percent' or (value >= 0 and value <= 100)),
    constraint aim_metrics_count_nonneg_chk
        check (unit <> 'count' or value >= 0),
    constraint aim_metrics_seconds_nonneg_chk
        check (unit <> 's' or value >= 0),
    constraint aim_metrics_cm360_positive_chk
        check (unit <> 'cm' or value > 0),
    constraint aim_metrics_dpi_positive_chk
        check (unit <> 'dpi' or value > 0),

    -- 同一セッション・同一 metric・同一武器で二重登録しない
    constraint aim_metrics_session_metric_uniq
        unique (session_id, metric_key, metric_version, weapon)
);

create index if not exists aim_metrics_user_metric_idx
    on public.aim_metrics (user_id, metric_key, created_at desc);
create index if not exists aim_metrics_session_idx
    on public.aim_metrics (session_id);

-- ---------------------------------------------------------------- RLS
alter table public.aim_metrics enable row level security;

create policy "aim_metrics_select_own"
    on public.aim_metrics for select
    to authenticated
    using (auth.uid() = user_id);

create policy "aim_metrics_insert_own"
    on public.aim_metrics for insert
    to authenticated
    with check (
        auth.uid() = user_id
        and exists (
            select 1 from public.aim_sessions s
            where s.id = session_id and s.user_id = auth.uid()
        )
    );

create policy "aim_metrics_delete_own"
    on public.aim_metrics for delete
    to authenticated
    using (auth.uid() = user_id);

-- **UPDATE の policy を作らない。** 測定値は後から書き換えない。
-- 取り直したいときはセッションごと削除して入れ直す。

comment on table public.aim_metrics is
    'metric の値。単位は Registry への外部キーと CHECK で縛り、0〜1 と 0〜100 の混在を防ぐ。';

