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
