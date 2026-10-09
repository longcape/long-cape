// 0006_calc_logs_quota.sql を、手元だけで動く本物の Postgres 17 に流して確かめる。
// 複数の接続から同時に保存する試験を含む。
//
//   （このリポジトリの外の作業用フォルダで）
//   npm install embedded-postgres pg
//   node verify_0006.mjs <このフォルダのパス>
//
// 本番にも、どの Supabase プロジェクトにも接続しない。CI には入れていない（Postgres 本体が要るため）。
//
// 再現しているもの:
//   - 本番と同じ列（null を許す is_locked / is_deleted_by_user を含む）と、本番と同じ3つの RLS policy
//   - Supabase と同じ役割（anon / authenticated / service_role）と auth.uid() / auth.role() / auth.jwt()
//   - PostgREST と同じ呼び出し方（1回の要求 = 1トランザクション。役割と JWT の中身を set local で渡す）
// 再現していないもの:
//   - 本物の PostgREST / GoTrue（HTTP の層、エラーの JSON への変換、関数の一覧の更新）

import fs from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const dir = process.argv[2] || '.';
const UP = fs.readFileSync(path.join(dir, '0006_calc_logs_quota.sql'), 'utf8');
const DOWN = fs.readFileSync(path.join(dir, 'down_0006_calc_logs_quota.sql'), 'utf8');

const PORT = 54331;
const dataDir = path.resolve('pgdata-verify-0006');
fs.rmSync(dataDir, { recursive: true, force: true });
const server = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'local-only', port: PORT,
    persistent: false, onLog: () => {}, onError: () => {},
    postgresFlags: ['-c', 'max_connections=200'] });
await server.initialise();
await server.start();
const conn = (database) => ({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'local-only', database });

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const ADMIN = '00000000-0000-0000-0000-0000000000ad';
const AUTO = '自動学習収集データ';

const admin = new pg.Client(conn('postgres'));
await admin.connect();
await admin.query(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;`);

const BASE_SCHEMA = `
    create schema auth;
    create function auth.jwt() returns jsonb language sql stable as
        $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select nullif(auth.jwt() ->> 'role', '') $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on all functions in schema auth to anon, authenticated, service_role;

    create table public.calc_logs (
        id uuid primary key default gen_random_uuid(),
        user_id uuid,
        game text not null, dpi numeric not null, final_sens text not null,
        is_custom boolean default false, memo text,
        created_at timestamptz not null default clock_timestamp(),
        rating varchar default 'good', height numeric, dexterity text, play_style text,
        mouse_weight text, aim_part text,
        is_locked boolean default false, is_deleted_by_user boolean default false,
        source text, session_id text, input_params jsonb, config_version timestamptz, client_lang text
    );
    create function public.is_admin() returns boolean language sql stable as
        $$ select coalesce(auth.jwt() ->> 'email', '') = 'rokikiroki@gmail.com' $$;
    alter table public.calc_logs enable row level security;
    create policy sel on public.calc_logs for select to anon, authenticated
        using ((auth.uid() is not null and user_id = auth.uid()) or public.is_admin());
    create policy ins on public.calc_logs for insert to anon, authenticated
        with check ((auth.uid() is not null and user_id = auth.uid()) or (auth.uid() is null and user_id is null));
    create policy upd on public.calc_logs for update to authenticated
        using (user_id = auth.uid()) with check (user_id = auth.uid());
    grant all on public.calc_logs to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
`;

let dbSeq = 0;
/** テストごとに新しいデータベースを作る。接続は必要なだけ増える（同時実行のため）。 */
async function fresh({ apply = true } = {}) {
    const name = 't' + (++dbSeq);
    await admin.query(`create database ${name}`);
    const pool = new pg.Pool({ ...conn(name), max: 60 });
    pool.on('error', () => {});
    await pool.query(BASE_SCHEMA);
    if (apply) await pool.query(UP);
    const db = { name, pool };
    db.su = (sql, params) => pool.query(sql, params);
    return db;
}
async function dispose(db) { await db.pool.end(); await admin.query(`drop database ${db.name} with (force)`); }

function claims(who) {
    if (who === 'anon') return { role: 'anon' };
    if (who === 'service') return { role: 'service_role' };
    return { role: 'authenticated', sub: who, email: who === ADMIN ? 'rokikiroki@gmail.com' : 'user@example.com' };
}
/** PostgREST と同じ形の1要求。専用の接続で、1トランザクションとして実行する。 */
async function req(db, who, sql, params = [], { isolation } = {}) {
    const c = await db.pool.connect();
    const cl = claims(who);
    const role = cl.role === 'service_role' ? 'service_role' : cl.role;
    try {
        await c.query(isolation ? `begin isolation level ${isolation}` : 'begin');
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(cl)]);
        await c.query(`set local role ${role}`);
        const r = await c.query(sql, params);
        await c.query('commit');
        return { ok: true, rows: r.rows, affected: r.rowCount };
    } catch (e) {
        try { await c.query('rollback'); } catch (_) { /* 接続が切れていても続ける */ }
        return { ok: false, message: e.message, code: e.code };
    } finally {
        c.release();
    }
}
const insert = (db, who, over = {}) => {
    const row = { user_id: who === 'anon' || who === 'service' ? null : who, game: 'valo', dpi: 800, final_sens: '0.3', memo: 'memo', ...over };
    const keys = Object.keys(row);
    return req(db, who, `insert into public.calc_logs (${keys.join(',')}) values (${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
        keys.map((k) => row[k]));
};
const rpc = (db, who, over = {}, opt) =>
    req(db, who, `select public.save_calc_log($1::jsonb) as id`,
        [JSON.stringify({ game: 'valo', dpi: 800, final_sens: '0.353', memo: 'new', is_custom: false, ...over })], opt);
const visible = async (db, uid) => (await db.su(`select count(*)::int n from public.calc_logs
    where user_id = $1 and not coalesce(is_deleted_by_user,false) and source is distinct from 'diagnosis_auto'`, [uid])).rows[0].n;
const total = async (db, uid) => (await db.su(`select count(*)::int n from public.calc_logs where user_id = $1`, [uid])).rows[0].n;
const checksum = async (db, cols = 'c::text') => (await db.su(`select md5(coalesce(string_agg(${cols}, '|' order by id), '')) h from public.calc_logs c`)).rows[0].h;
async function seed(db, uid, n, over = {}) {
    for (let i = 0; i < n; i++) {
        const row = { user_id: uid, game: 'valo', dpi: 800, final_sens: '0.3', memo: 'm' + i, ...over };
        const keys = Object.keys(row);
        await db.su(`insert into public.calc_logs (${keys.join(',')}) values (${keys.map((_, j) => '$' + (j + 1)).join(',')})`, keys.map((k) => row[k]));
    }
}

let passed = 0; const failures = [];
async function check(name, fn, opt) {
    const db = await fresh(opt);
    try { await fn(db); passed++; } catch (e) { failures.push(name + '\n     ' + e.message); }
    finally { await dispose(db); }
}
function eq(a, b, l) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${l || ''} 期待 ${JSON.stringify(b)} / 実際 ${JSON.stringify(a)}`); }
function ok(c, l) { if (!c) throw new Error(l || '条件を満たしません'); }
const quota = (r) => !r.ok && /calc_logs_quota_exceeded/.test(r.message);

// ============================================================ 適用前後・既存データ

await check('適用前: 直接の追加で6件目が入る（現状の再現）', async (db) => {
    for (let i = 0; i < 6; i++) ok((await insert(db, A)).ok);
    eq(await visible(db, A), 6);
}, { apply: false });

await check('適用しても既存の行は変わらない。印が付くのは「学習用の形をした本人名義の行」の source だけ', async (db) => {
    await seed(db, A, 7);                                                         // 上限を超えた通常の行
    await seed(db, A, 3, { memo: AUTO });                                         // 学習用の形（印なし）
    await seed(db, A, 1, { memo: AUTO, is_custom: true });                        // 形が違う → 通常の行のまま
    await seed(db, null, 4, { memo: AUTO });                                      // 未ログインの学習用の行
    await seed(db, B, 2, { is_locked: null, is_deleted_by_user: null });
    const cols = `concat_ws('~', id, user_id, game, dpi, final_sens, is_custom, memo, created_at, rating, is_locked, is_deleted_by_user)`;
    const before = await checksum(db, cols); const n = (await db.su('select count(*)::int n from public.calc_logs')).rows[0].n;
    await db.su(UP);
    eq(await checksum(db, cols), before, 'source 以外の列');
    eq((await db.su('select count(*)::int n from public.calc_logs')).rows[0].n, n, '行数');
    eq((await db.su(`select count(*)::int n from public.calc_logs where source = 'diagnosis_auto'`)).rows[0].n, 3, '印が付いた行');
    eq((await db.su(`select count(*)::int n from public.calc_logs where source is not null and source <> 'diagnosis_auto'`)).rows[0].n, 0);
    await db.su(UP);                                                              // もう一度流しても同じ
    eq(await checksum(db, cols), before, '再適用');
    // 上限を超えている利用者: ロック・非表示はできる。追加はできない。原子的な保存なら5件へ収まる
    ok((await req(db, A, `update public.calc_logs set is_locked = true where id = (select id from public.calc_logs where user_id = $1 and memo = 'm0')`, [A])).ok);
    ok(quota(await insert(db, A)), '追加は拒否');
    ok((await rpc(db, A)).ok, 'save_calc_log');
    eq(await visible(db, A), 5); eq(await total(db, A), 12, '行は消えていない');
}, { apply: false });

// ============================================================ 上限と直接呼び出し

await check('API を直接呼んでも6件目は入らない', async (db) => {
    for (let i = 0; i < 5; i++) ok((await insert(db, A)).ok, i + ' 件目');
    ok(quota(await insert(db, A)));
    eq(await visible(db, A), 5);
});
await check('非表示にすれば空きができ、非表示からの復元は上限を超えられない', async (db) => {
    await seed(db, A, 5);
    const first = (await db.su(`select id from public.calc_logs order by created_at limit 1`)).rows[0].id;
    ok((await req(db, A, `update public.calc_logs set is_deleted_by_user = true where id = $1`, [first])).ok);
    ok((await insert(db, A)).ok, '空いた分は入る');
    ok(quota(await req(db, A, `update public.calc_logs set is_deleted_by_user = false where id = $1`, [first])), '復元で6件にできない');
    ok(quota(await req(db, A, `update public.calc_logs set is_deleted_by_user = null where id = $1`, [first])), 'null へ戻すのも同じ');
    eq(await visible(db, A), 5);
});
await check('ロックの切替・数えられている行の編集は、上限いっぱいでもできる', async (db) => {
    await seed(db, A, 5);
    ok((await req(db, A, `update public.calc_logs set is_locked = true`)).ok);
    ok((await req(db, A, `update public.calc_logs set memo = 'edited', rating = 'god', source = 'memo'`)).ok);
    ok((await req(db, A, `update public.calc_logs set is_locked = null`)).ok, 'null（本番で許されている値）');
    eq(await visible(db, A), 5);
});

// ============================================================ 学習用の印の偽装

await check('学習用の行は数えない（新しいアプリ: 印つき / 古いアプリ: 印なしでも自動で印が付く）', async (db) => {
    await seed(db, A, 5);
    for (let i = 0; i < 10; i++) ok((await insert(db, A, { memo: AUTO, source: 'diagnosis_auto' })).ok, '印つき ' + i);
    for (let i = 0; i < 10; i++) ok((await insert(db, A, { memo: AUTO })).ok, '印なし ' + i);
    eq((await db.su(`select count(*)::int n from public.calc_logs where source = 'diagnosis_auto'`)).rows[0].n, 20);
    eq(await visible(db, A), 5); eq(await total(db, A), 25);
    ok((await insert(db, 'anon', { memo: AUTO })).ok, '未ログインの学習用の行（既存の仕様）');
});
await check('学習用の印を、通常のメモに付けて件数を逃れることはできない', async (db) => {
    await seed(db, A, 5);
    const bad = [
        { memo: '自分のメモ', source: 'diagnosis_auto' },                       // memo が自由文
        { memo: AUTO, source: 'diagnosis_auto', is_custom: true },              // 感度メモの形
        { memo: AUTO, source: 'diagnosis_auto', is_locked: true },              // ロック付き
        { memo: null, source: 'diagnosis_auto' },
    ];
    for (const b of bad) {
        const r = await insert(db, A, b);
        ok(!r.ok && /calc_logs_learning_row_invalid/.test(r.message), JSON.stringify(b) + ' → ' + r.message);
    }
    // memo だけ学習用の文言にしても（印なし・感度メモの形）、通常の行として数えられる
    ok(quota(await insert(db, A, { memo: AUTO, is_custom: true })), 'memo の偽装');
    eq(await visible(db, A), 5); eq(await total(db, A), 5);
});
await check('学習用の行を後から通常のメモへ作り変えることも、上限を超えてはできない', async (db) => {
    await seed(db, A, 5);
    await insert(db, A, { memo: AUTO, source: 'diagnosis_auto' });
    const id = (await db.su(`select id from public.calc_logs where source = 'diagnosis_auto'`)).rows[0].id;
    let r = await req(db, A, `update public.calc_logs set memo = '自分のメモ' where id = $1`, [id]);
    ok(!r.ok && /learning_row_invalid/.test(r.message), '印を付けたまま memo を変える: ' + r.message);
    r = await req(db, A, `update public.calc_logs set is_locked = true where id = $1`, [id]);
    ok(!r.ok && /learning_row_invalid/.test(r.message), '印を付けたままロック');
    ok(quota(await req(db, A, `update public.calc_logs set source = null, memo = '自分のメモ' where id = $1`, [id])), '印を外すと数えられ、上限なら拒否');
    ok(quota(await req(db, A, `update public.calc_logs set source = 'memo' where id = $1`, [id])), '別の印へ変えても同じ');
    // 既にある通常の行に、後から学習用の印を付けて枠を空けることもできない
    r = await req(db, A, `update public.calc_logs set source = 'diagnosis_auto' where id = (select id from public.calc_logs where memo = 'm0')`);
    ok(!r.ok && /learning_row_invalid/.test(r.message), '通常の行に印を付ける');
    eq(await visible(db, A), 5);
    // 枠に空きがあれば、印を外して通常の行にできる（数えられる）
    await req(db, A, `update public.calc_logs set is_deleted_by_user = true where memo = 'm0'`);
    ok((await req(db, A, `update public.calc_logs set source = null, memo = '自分のメモ' where id = $1`, [id])).ok);
    eq(await visible(db, A), 5);
});

// ============================================================ 原子的な保存

await check('save_calc_log: 上限なら最も古い未ロックを隠して追加する。印は学習用にならない', async (db) => {
    await seed(db, A, 5);
    await req(db, A, `update public.calc_logs set is_locked = true where memo = 'm0'`);
    ok((await rpc(db, A, { memo: AUTO })).ok, 'memo に学習用の文言を入れても通常の行として保存される');
    const rows = (await db.su(`select memo, coalesce(is_deleted_by_user,false) d, source from public.calc_logs order by created_at`)).rows;
    eq(rows.filter((r) => r.d).map((r) => r.memo), ['m1'], 'ロック中の m0 は残り、次に古い m1 が隠れる');
    eq(rows[rows.length - 1].source, 'diagnosis_result');
    ok((await rpc(db, A, { is_custom: true })).ok);
    eq((await db.su(`select source from public.calc_logs order by created_at desc limit 1`)).rows[0].source, 'memo');
    eq(await visible(db, A), 5); eq(await total(db, A), 7);
});
await check('save_calc_log: すべてロックなら何も変えずに断る', async (db) => {
    await seed(db, A, 5, { is_locked: true });
    const r = await rpc(db, A);
    ok(!r.ok && /calc_logs_all_locked/.test(r.message), r.message);
    eq(await visible(db, A), 5); eq(await total(db, A), 5);
});
await check('save_calc_log: 追加に失敗したら、隠した行も元のまま（部分的な失敗が残らない）', async (db) => {
    await seed(db, A, 5);
    const before = await checksum(db);
    ok(!(await rpc(db, A, { game: null })).ok, 'game は必須');
    ok(!(await rpc(db, A, { dpi: 'abc' })).ok, 'dpi が数値でない');
    ok(!(await rpc(db, A, { is_custom: 'maybe' })).ok);
    eq(await checksum(db), before, '1行も変わっていない');
});
await check('save_calc_log: 未ログインでは使えない。user_id を引数で偽れない', async (db) => {
    const r = await rpc(db, 'anon');
    ok(!r.ok && /permission denied|not_authenticated/.test(r.message), r.message);
    ok((await rpc(db, A, { user_id: B })).ok);
    eq(await total(db, B), 0, '他人の名義では入らない'); eq(await total(db, A), 1);
});

// ============================================================ RLS

await check('RLS はそのまま: 他人の行は読めない・書き換えられない・他人の件数に影響しない', async (db) => {
    await seed(db, A, 5);
    for (let i = 0; i < 5; i++) ok((await insert(db, B)).ok, 'B の ' + i);
    eq((await req(db, B, `select count(*)::int n from public.calc_logs`)).rows[0].n, 5, 'B に見えるのは自分の5件だけ');
    eq((await req(db, B, `update public.calc_logs set is_deleted_by_user = true where user_id = $1`, [A])).affected, 0, 'A の行は変えられない');
    ok(!(await insert(db, B, { user_id: A })).ok, 'A の名義で追加できない');
    ok(!(await req(db, B, `update public.calc_logs set user_id = $1`, [A])).ok, '自分の行を他人へ付け替えられない');
    ok(!(await req(db, B, `delete from public.calc_logs where user_id = $1`, [B])).affected, '物理削除はできない（policy が無い）');
    eq((await req(db, 'anon', `select count(*)::int n from public.calc_logs`)).rows[0].n, 0, '未ログインには何も見えない');
    ok(!(await insert(db, 'anon', { user_id: A })).ok, '未ログインが他人の名義で追加できない');
    eq(await visible(db, A), 5); eq(await visible(db, B), 5); eq(await total(db, A), 5); eq(await total(db, B), 5);
    eq((await db.su(`select count(*)::int n from pg_policies where tablename = 'calc_logs'`)).rows[0].n, 3, 'policy は3つのまま');
});
await check('管理者・学習ジョブ（service_role）・管理画面からの SQL は対象外', async (db) => {
    for (let i = 0; i < 8; i++) ok((await insert(db, ADMIN)).ok, '管理者 ' + i);
    for (let i = 0; i < 8; i++) ok((await rpc(db, ADMIN, { memo: 'a' + i })).ok);
    eq(await visible(db, ADMIN), 16);
    for (let i = 0; i < 7; i++) ok((await insert(db, 'service', { user_id: A })).ok, 'service ' + i);
    await seed(db, B, 7);   // 管理画面（JWT なし）
    eq(await visible(db, B), 7);
});
await check('上限は関数1つの差し替えで変えられる（将来の50件枠）', async (db) => {
    await db.su(`create or replace function public.calc_logs_limit(p_user uuid) returns integer language sql stable
        security definer set search_path = public, pg_temp as $$ select case when p_user = '${B}' then 50 else 5 end $$;`);
    for (let i = 0; i < 50; i++) ok((await insert(db, B)).ok, 'B の ' + i);
    ok(quota(await insert(db, B)), '51件目は拒否');
    ok((await rpc(db, B)).ok); eq(await visible(db, B), 50);
    await seed(db, A, 5);
    ok(quota(await insert(db, A)), '無料は5件のまま');
});

// ============================================================ 同時保存（複数の接続）

const many = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));

await check('同時: 4件ある状態で 30 の接続が同時に直接追加しても、入るのは1件だけ', async (db) => {
    await seed(db, A, 4);
    const rs = await many(30, (i) => insert(db, A, { memo: 'c' + i }));
    eq(rs.filter((r) => r.ok).length, 1, '成功した数');
    ok(rs.filter((r) => !r.ok).every(quota), '失敗はすべて上限: ' + rs.filter((r) => !r.ok && !quota(r)).map((r) => r.message)[0]);
    eq(await visible(db, A), 5);
});
await check('同時: 0件から 40 の接続が同時に直接追加しても、ちょうど5件（10回くり返す）', async (db) => {
    for (let round = 0; round < 10; round++) {
        await db.su('truncate public.calc_logs');
        const rs = await many(40, (i) => insert(db, A, { memo: 'c' + i }));
        eq(rs.filter((r) => r.ok).length, 5, round + ' 回目の成功数');
        eq(await visible(db, A), 5, round + ' 回目');
    }
});
await check('同時: 5件ある状態で 30 の接続が同時に save_calc_log しても、全部成功して5件のまま・行は消えない', async (db) => {
    await seed(db, A, 5);
    const rs = await many(30, (i) => rpc(db, A, { memo: 'r' + i }));
    eq(rs.filter((r) => r.ok).length, 30, '失敗: ' + (rs.find((r) => !r.ok) || {}).message);
    eq(await visible(db, A), 5); eq(await total(db, A), 35);
    eq((await db.su(`select count(distinct id)::int n from public.calc_logs`)).rows[0].n, 35);
});
await check('同時: 保存・直接追加・復元・非表示・ロックを2人ぶん混ぜて 400 回。どの時点でも5件以下・行は消えない・デッドロックなし', async (db) => {
    await seed(db, A, 5); await seed(db, B, 3);
    const errors = {};
    let inserted = 8;
    for (let round = 0; round < 8; round++) {
        const ops = await many(50, async (i) => {
            const who = i % 2 ? A : B; const k = (i + round) % 5;
            let r;
            if (k === 0) r = await rpc(db, who, { memo: 'x' + round + '-' + i });
            else if (k === 1) r = await insert(db, who, { memo: 'd' + round + '-' + i });
            else if (k === 2) r = await req(db, who, `update public.calc_logs set is_deleted_by_user = false where id = (select id from public.calc_logs where coalesce(is_deleted_by_user,false) order by random() limit 1)`);
            else if (k === 3) r = await req(db, who, `update public.calc_logs set is_deleted_by_user = true where id = (select id from public.calc_logs where not coalesce(is_deleted_by_user,false) order by random() limit 1)`);
            else r = await req(db, who, `update public.calc_logs set is_locked = not coalesce(is_locked,false) where id = (select id from public.calc_logs order by random() limit 1)`);
            if (!r.ok) { const key = /quota_exceeded|all_locked/.test(r.message) ? 'expected' : r.message; errors[key] = (errors[key] || 0) + 1; }
            else if (k === 0 || k === 1) inserted++;
            return r;
        });
        ok(ops.length === 50);
        ok(await visible(db, A) <= 5, `${round} 回目 A = ${await visible(db, A)}`);
        ok(await visible(db, B) <= 5, `${round} 回目 B = ${await visible(db, B)}`);
    }
    const unexpected = Object.keys(errors).filter((k) => k !== 'expected');
    eq(unexpected, [], '想定外のエラー');
    eq((await db.su('select count(*)::int n from public.calc_logs')).rows[0].n, inserted, '入った行は1つも消えていない');
});
await check('対照: 鍵を外した版では、同じ同時試験で上限を超える（＝この試験は競合を検出できる）', async (db) => {
    // 鍵を取らず、数えた後に少し待つ版へ差し替える。これで超えなければ、上の試験は何も証明していない。
    const def = (await db.su(`select pg_get_functiondef('public.calc_logs_enforce_quota()'::regprocedure) d`)).rows[0].d;
    ok(def.includes('perform public.calc_logs_quota_lock(new.user_id);'));
    ok(def.includes('if v_count >= v_limit then'));
    await db.su(def.replace('perform public.calc_logs_quota_lock(new.user_id);', '')
        .replace('if v_count >= v_limit then', 'perform pg_sleep(0.05); if v_count >= v_limit then'));
    const rs = await many(20, (i) => insert(db, A, { memo: 'c' + i }));
    ok(rs.filter((r) => r.ok).length > 5, '鍵なしでも5件に収まってしまった: ' + rs.filter((r) => r.ok).length);
    ok(await visible(db, A) > 5);
});
await check('スナップショットを固定する分離レベル（REPEATABLE READ / SERIALIZABLE）では断る（上限を超えさせない）', async (db) => {
    for (const iso of ['repeatable read', 'serializable']) {
        await db.su('truncate public.calc_logs');
        await seed(db, A, 4);
        // 4件の状態から、固定スナップショットの接続どうしを同時にぶつける
        const direct = await many(15, (i) => req(db, A, `insert into public.calc_logs (user_id, game, dpi, final_sens, memo) values ($1,'valo',800,'0.3',$2)`, [A, 'iso' + i], { isolation: iso }));
        const viaRpc = await many(15, (i) => rpc(db, A, { memo: 'rpc' + i }, { isolation: iso }));
        ok(direct.concat(viaRpc).every((r) => !r.ok && /calc_logs_isolation_not_supported/.test(r.message)),
            iso + ': ' + (direct.concat(viaRpc).find((r) => r.ok || !/isolation_not_supported/.test(r.message)) || {}).message);
        eq(await visible(db, A), 4, iso);
        // 数える行が増えない操作（ロックの切替・非表示）は、分離レベルに関係なくできる
        ok((await req(db, A, 'update public.calc_logs set is_locked = true', [], { isolation: iso })).ok, iso + ' ロック');
    }
});
await check('対照: 分離レベルの検査を外すと、REPEATABLE READ の同時追加で上限を超える（＝検査が必要な理由）', async (db) => {
    const def = (await db.su(`select pg_get_functiondef('public.calc_logs_enforce_quota()'::regprocedure) d`)).rows[0].d;
    ok(def.includes("raise exception 'calc_logs_isolation_not_supported'"));
    await db.su(def.replace("current_setting('transaction_isolation') <> 'read committed'", 'false'));
    let exceeded = false;
    for (let round = 0; round < 5 && !exceeded; round++) {
        await db.su('truncate public.calc_logs');
        await seed(db, A, 4);
        await many(20, (i) => req(db, A, `insert into public.calc_logs (user_id, game, dpi, final_sens, memo) values ($1,'valo',800,'0.3',$2)`, [A, 'c' + i], { isolation: 'repeatable read' }));
        exceeded = (await visible(db, A)) > 5;
    }
    ok(exceeded, '検査なしでも5件に収まってしまった');
});

// ============================================================ 取り消し

await check('取り消し: 関数と trigger だけが消え、行はそのまま。制限は画面側だけに戻る。繰り返しても安全', async (db) => {
    await seed(db, A, 5); await insert(db, A, { memo: AUTO });
    const before = await checksum(db);
    await db.su(DOWN);
    eq(await checksum(db), before, '行は変わらない');
    eq((await db.su(`select count(*)::int n from pg_trigger where tgrelid = 'public.calc_logs'::regclass and not tgisinternal`)).rows[0].n, 0);
    eq((await db.su(`select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'calc_logs_%' or proname = 'save_calc_log')`)).rows[0].n, 0);
    ok((await insert(db, A)).ok, '6件目が入る（適用前と同じ）');
    eq((await db.su(`select count(*)::int n from pg_policies where tablename = 'calc_logs'`)).rows[0].n, 3, 'policy は3つのまま');
    const r = await rpc(db, A);
    ok(!r.ok && r.code === '42883', '関数が無い: ' + r.code);
    await db.su(DOWN); await db.su(UP); await db.su(DOWN);
    eq(await total(db, A), 7);
});

await admin.end();
await server.stop();
fs.rmSync(dataDir, { recursive: true, force: true });

const all = passed + failures.length;
if (failures.length === 0) { console.log(`✅ 0006 の検証成功: ${passed}/${all} 件（Postgres 17・複数接続の同時保存を含む）`); process.exit(0); }
console.error(`❌ 0006 の検証失敗: ${failures.length}/${all} 件`);
for (const f of failures) console.error('   - ' + f);
process.exit(1);
