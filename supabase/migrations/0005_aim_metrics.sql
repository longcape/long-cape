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
