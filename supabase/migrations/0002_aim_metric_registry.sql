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
