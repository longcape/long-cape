// 0006_calc_logs_quota.sql を、手元だけで動く Postgres（PGlite）に流して確かめる。
//
//   npm install @electric-sql/pglite   （このリポジトリの外の作業用フォルダで）
//   node verify_0006.mjs <このフォルダのパス>
//
// 本番にも、どの Supabase プロジェクトにも接続しない。CI には入れていない。
//
// 再現しているもの: 本番と同じ列（null を許す is_locked / is_deleted_by_user を含む）、
//   本番と同じ3つの RLS policy、is_admin()、auth.uid() / auth.role() / auth.jwt() の代用品。
// 再現できないもの: **複数の接続からの同時実行**（PGlite は接続が1本）。
//   同時保存で上限を超えないことは、鍵の取り方からの設計上の根拠であり、ここでは実測していない。

import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const dir = process.argv[2] || '.';
const UP = fs.readFileSync(path.join(dir, '0006_calc_logs_quota.sql'), 'utf8');
const DOWN = fs.readFileSync(path.join(dir, 'down_0006_calc_logs_quota.sql'), 'utf8');

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const ADMIN = '00000000-0000-0000-0000-0000000000ad';
const AUTO = '自動学習収集データ';

async function fresh() {
    const db = new PGlite();
    await db.exec(`
        create role anon; create role authenticated; create role service_role bypassrls;
        create schema auth;
        create function auth.uid() returns uuid language sql stable as
            $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        create function auth.role() returns text language sql stable as
            $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
        create function auth.jwt() returns jsonb language sql stable as
            $$ select jsonb_build_object('email', nullif(current_setting('request.jwt.claim.email', true), '')) $$;
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
    `);
    return db;
}

/** 指定の利用者として1文を実行する。失敗したらメッセージを返す。 */
async function as(db, who, sql, params = []) {
    const role = who === 'anon' ? 'anon' : who === 'service' ? 'service_role' : 'authenticated';
    const sub = who === 'anon' || who === 'service' ? '' : who;
    const email = who === ADMIN ? 'rokikiroki@gmail.com' : (sub ? 'user@example.com' : '');
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${sub}', false),
        set_config('request.jwt.claim.role', '${role}', false), set_config('request.jwt.claim.email', '${email}', false);
        set role ${role};`);
    try { const r = await db.query(sql, params); return { ok: true, rows: r.rows, affected: r.affectedRows }; }
    catch (e) { return { ok: false, message: e.message }; }
    finally { await db.exec('reset role;'); }
}
const insert = (db, who, memo = 'memo', uid = who) =>
    as(db, who, `insert into public.calc_logs (user_id, game, dpi, final_sens, memo) values ($1, 'valo', 800, '0.3', $2)`,
        [uid === 'anon' ? null : uid, memo]);
const rpc = (db, who, over = {}) =>
    as(db, who, `select public.save_calc_log($1::jsonb) as id`,
        [JSON.stringify({ game: 'valo', dpi: 800, final_sens: '0.353', memo: 'new', is_custom: false, ...over })]);
async function visible(db, uid) {
    const r = await db.query(`select count(*)::int n from public.calc_logs where user_id = $1
        and not coalesce(is_deleted_by_user,false) and coalesce(memo,'') not in ('自動学習収集データ','自動収集データ')`, [uid]);
    return r.rows[0].n;
}
const total = async (db, uid) => (await db.query(`select count(*)::int n from public.calc_logs where user_id = $1`, [uid])).rows[0].n;

let passed = 0; const failures = [];
async function check(name, fn) {
    try { await fn(); passed++; } catch (e) { failures.push(name + '\n     ' + e.message); }
}
function eq(a, b, l) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${l || ''} 期待 ${JSON.stringify(b)} / 実際 ${JSON.stringify(a)}`); }
function ok(c, l) { if (!c) throw new Error(l || '条件を満たしません'); }

await check('適用前: 直接の追加で6件目が入る（現状の再現）', async () => {
    const db = await fresh();
    for (let i = 0; i < 6; i++) ok((await insert(db, A)).ok);
    eq(await visible(db, A), 6);
});
await check('適用しても既存の行は1つも変わらない（上限を超えている利用者がいても）', async () => {
    const db = await fresh();
    for (let i = 0; i < 7; i++) await insert(db, A);
    const before = (await db.query(`select md5(string_agg(c::text, '|' order by id)) h from public.calc_logs c`)).rows[0].h;
    await db.exec(UP);
    const after = (await db.query(`select md5(string_agg(c::text, '|' order by id)) h from public.calc_logs c`)).rows[0].h;
    eq(after, before);
    // 超えている利用者: ロックの切替や非表示はできる。追加はできない
    ok((await as(db, A, `update public.calc_logs set is_locked = true where id = (select id from public.calc_logs limit 1)`)).ok, 'ロックはできる');
    ok(!(await insert(db, A)).ok, '追加は拒否');
    // 原子的な保存なら、古い未ロックを隠して5件へ収める
    ok((await rpc(db, A)).ok, 'save_calc_log');
    eq(await visible(db, A), 5); eq(await total(db, A), 8, '行は消えていない');
});
await check('API を直接呼んでも6件目は入らない', async () => {
    const db = await fresh(); await db.exec(UP);
    for (let i = 0; i < 5; i++) ok((await insert(db, A)).ok, i + ' 件目');
    const r = await insert(db, A);
    ok(!r.ok && /calc_logs_quota_exceeded/.test(r.message), r.message);
    eq(await visible(db, A), 5);
});
await check('学習用の行は数えない。ただし通常のメモへ書き換えて上限を超えることはできない', async () => {
    const db = await fresh(); await db.exec(UP);
    for (let i = 0; i < 5; i++) await insert(db, A);
    for (let i = 0; i < 20; i++) ok((await insert(db, A, AUTO)).ok, '学習用 ' + i);
    eq(await visible(db, A), 5); eq(await total(db, A), 25);
    const r = await as(db, A, `update public.calc_logs set memo = 'x' where id = (select id from public.calc_logs where memo = $1 limit 1)`, [AUTO]);
    ok(!r.ok && /quota_exceeded/.test(r.message), '書き換えで増やせない');
    ok((await insert(db, 'anon', AUTO, 'anon')).ok, '未ログインの学習用の行（既存の仕様）は入る');
});
await check('非表示にすれば空きができ、非表示からの復元は上限を超えられない', async () => {
    const db = await fresh(); await db.exec(UP);
    for (let i = 0; i < 5; i++) await insert(db, A);
    const first = (await db.query(`select id from public.calc_logs order by created_at limit 1`)).rows[0].id;
    ok((await as(db, A, `update public.calc_logs set is_deleted_by_user = true where id = $1`, [first])).ok);
    ok((await insert(db, A)).ok, '空いた分は入る');
    const r = await as(db, A, `update public.calc_logs set is_deleted_by_user = false where id = $1`, [first]);
    ok(!r.ok && /quota_exceeded/.test(r.message), '復元で6件にできない');
    eq(await visible(db, A), 5);
});
await check('ロックの切替・数えられている行の編集は、上限いっぱいでもできる', async () => {
    const db = await fresh(); await db.exec(UP);
    for (let i = 0; i < 5; i++) await insert(db, A);
    ok((await as(db, A, `update public.calc_logs set is_locked = true`)).ok);
    ok((await as(db, A, `update public.calc_logs set memo = 'edited', rating = 'god'`)).ok);
    ok((await as(db, A, `update public.calc_logs set is_locked = null, is_deleted_by_user = null`)).ok, 'null（本番で許されている値）');
    eq(await visible(db, A), 5);
});
await check('save_calc_log: 上限なら最も古い未ロックを隠して追加する（1回の処理で完結）', async () => {
    const db = await fresh(); await db.exec(UP);
    for (let i = 0; i < 5; i++) await insert(db, A, 'm' + i);
    await as(db, A, `update public.calc_logs set is_locked = true where memo = 'm0'`);
    ok((await rpc(db, A)).ok);
    const rows = (await db.query(`select memo, coalesce(is_deleted_by_user,false) d from public.calc_logs order by created_at`)).rows;
    eq(rows.filter((r) => r.d).map((r) => r.memo), ['m1'], 'ロック中の m0 は残り、次に古い m1 が隠れる');
    eq(await visible(db, A), 5); eq(await total(db, A), 6);
});
await check('save_calc_log: すべてロックなら何も変えずに断る', async () => {
    const db = await fresh(); await db.exec(UP);
    for (let i = 0; i < 5; i++) await insert(db, A);
    await as(db, A, `update public.calc_logs set is_locked = true`);
    const r = await rpc(db, A);
    ok(!r.ok && /calc_logs_all_locked/.test(r.message), r.message);
    eq(await visible(db, A), 5); eq(await total(db, A), 5);
});
await check('save_calc_log: 追加に失敗したら、隠した行も元のまま（部分的な失敗が残らない）', async () => {
    const db = await fresh(); await db.exec(UP);
    for (let i = 0; i < 5; i++) await insert(db, A);
    const r = await rpc(db, A, { game: null });          // game は NOT NULL
    ok(!r.ok, '失敗するはず');
    eq(await visible(db, A), 5, '古い行は隠れていない'); eq(await total(db, A), 5);
    const bad = await rpc(db, A, { dpi: 'abc' });
    ok(!bad.ok); eq(await visible(db, A), 5);
});
await check('save_calc_log: 連続して何度呼んでも5件を超えない', async () => {
    const db = await fresh(); await db.exec(UP);
    for (let i = 0; i < 30; i++) { ok((await rpc(db, A, { memo: 'n' + i })).ok, i + ' 回目'); ok(await visible(db, A) <= 5); }
    eq(await visible(db, A), 5); eq(await total(db, A), 30);
});
await check('save_calc_log: 未ログインでは使えない。user_id を引数で偽れない', async () => {
    const db = await fresh(); await db.exec(UP);
    ok(!(await rpc(db, 'anon')).ok, '未ログイン');
    ok((await rpc(db, A, { user_id: B })).ok);
    eq(await total(db, B), 0, '他人の名義では入らない'); eq(await total(db, A), 1);
});
await check('RLS はそのまま: 他人の行は読めない・書き換えられない・他人の件数に影響しない', async () => {
    const db = await fresh(); await db.exec(UP);
    for (let i = 0; i < 5; i++) await insert(db, A);
    for (let i = 0; i < 5; i++) ok((await insert(db, B)).ok, 'B の ' + i);
    eq((await as(db, B, `select count(*)::int n from public.calc_logs`)).rows[0].n, 5, 'B に見えるのは自分の5件だけ');
    eq((await as(db, B, `update public.calc_logs set is_deleted_by_user = true where user_id = $1`, [A])).affected, 0, 'A の行は変えられない');
    ok(!(await insert(db, B, 'x', A)).ok, 'A の名義で追加できない');
    eq((await as(db, 'anon', `select count(*)::int n from public.calc_logs`)).rows[0].n, 0, '未ログインには何も見えない');
    eq(await visible(db, A), 5); eq(await visible(db, B), 5);
});
await check('管理者と学習ジョブ（service_role）は対象外', async () => {
    const db = await fresh(); await db.exec(UP);
    for (let i = 0; i < 8; i++) ok((await insert(db, ADMIN)).ok, '管理者 ' + i);
    for (let i = 0; i < 8; i++) ok((await rpc(db, ADMIN, { memo: 'a' + i })).ok);
    eq(await visible(db, ADMIN), 16);
    for (let i = 0; i < 7; i++) ok((await insert(db, 'service', 'memo', A)).ok, 'service ' + i);
});
await check('上限は関数1つの差し替えで変えられる（将来の50件枠）', async () => {
    const db = await fresh(); await db.exec(UP);
    await db.exec(`create or replace function public.calc_logs_limit(p_user uuid) returns integer language sql stable
        security definer set search_path = public, pg_temp as $$ select case when p_user = '${B}' then 50 else 5 end $$;`);
    for (let i = 0; i < 50; i++) ok((await insert(db, B)).ok, 'B の ' + i);
    ok(!(await insert(db, B)).ok, '51件目は拒否');
    for (let i = 0; i < 5; i++) await insert(db, A);
    ok(!(await insert(db, A)).ok, '無料は5件のまま');
});
await check('取り消し: 関数と trigger だけが消え、行はそのまま。制限は画面側だけに戻る', async () => {
    const db = await fresh(); await db.exec(UP);
    for (let i = 0; i < 5; i++) await insert(db, A);
    const before = (await db.query(`select md5(string_agg(c::text, '|' order by id)) h from public.calc_logs c`)).rows[0].h;
    await db.exec(DOWN);
    eq((await db.query(`select md5(string_agg(c::text, '|' order by id)) h from public.calc_logs c`)).rows[0].h, before);
    eq((await db.query(`select count(*)::int n from pg_trigger where tgrelid = 'public.calc_logs'::regclass and not tgisinternal`)).rows[0].n, 0);
    eq((await db.query(`select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace and proname like 'calc_logs_%' or proname = 'save_calc_log'`)).rows[0].n, 0);
    ok((await insert(db, A)).ok, '6件目が入る（適用前と同じ）');
    eq((await db.query(`select count(*)::int n from pg_policies where tablename = 'calc_logs'`)).rows[0].n, 3, 'policy は3つのまま');
    await db.exec(UP); await db.exec(DOWN); await db.exec(DOWN);   // 繰り返しても安全
});

const all = passed + failures.length;
if (failures.length === 0) { console.log(`✅ 0006 の検証成功: ${passed}/${all} 件（同時実行は対象外）`); process.exit(0); }
console.error(`❌ 0006 の検証失敗: ${failures.length}/${all} 件`);
for (const f of failures) console.error('   - ' + f);
process.exit(1);
