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
