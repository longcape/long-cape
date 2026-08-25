-- =====================================================================
-- ロングケープの定理 — Supabase スキーマ / RLS ポリシー
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

-- 誰でも読める（フロントが計算に使うため）／書き込みは service_role のみ（学習ジョブ）
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
    created_at          timestamptz not null default now()
);

create index if not exists calc_logs_user_idx    on public.calc_logs (user_id, created_at desc);
create index if not exists calc_logs_learn_idx   on public.calc_logs (game, is_custom, created_at);

alter table public.calc_logs enable row level security;

-- 管理者判定はサーバー側（JWT のメールアドレス）で行う
create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
    select coalesce(auth.jwt() ->> 'email', '') = 'rokikiroki@gmail.com';
$$;

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
