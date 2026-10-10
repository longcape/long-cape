// 0006_calc_logs_quota.sql を「Supabase と同じ API の層」を通して確かめる。
//
//   手元の Postgres 17 ＋ PostgREST の公式版（Supabase が API に使っているもの）を立ち上げ、
//   **本物の index.html の保存処理** を、本物の HTTP 経由でつないで動かす。
//
//   （このリポジトリの外の作業用フォルダで）
//   npm install embedded-postgres pg @supabase/postgrest-js
//   node verify_0006_http.mjs <このフォルダのパス> <postgrest の実行ファイル> <リポジトリのルート>
//
// 本番にも、どの Supabase プロジェクトにも接続しない。CI には入れていない。
//
// 本物の Supabase との違い:
//   - ログイン（GoTrue）は使わず、同じ形の JWT を手元の秘密鍵で作って渡している
//   - PostgREST の版が Supabase の運用中の版と同じとは限らない
//   - Supabase は DDL の後に API の関数一覧を自動で読み直す。ここでは NOTIFY で読み直させている

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { PostgrestClient } from '@supabase/postgrest-js';

const [dir, postgrestBin, repoRoot] = process.argv.slice(2);
const UP = fs.readFileSync(path.join(dir, '0006_calc_logs_quota.sql'), 'utf8');
const DOWN = fs.readFileSync(path.join(dir, 'down_0006_calc_logs_quota.sql'), 'utf8');
const { loadApp } = await import(pathToFileURL(path.join(repoRoot, 'tests/lib/sandbox.mjs')).href);

const PG_PORT = 54333, API_PORT = 54334;
const SECRET = crypto.randomBytes(32).toString('hex');           // この試験の中だけで使う鍵
const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const AUTO = '自動学習収集データ';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims) {
    const head = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 });
    return head + '.' + crypto.createHmac('sha256', SECRET).update(head).digest('base64url');
}
const tokenOf = (uid) => jwt({ role: 'authenticated', sub: uid, email: 'user@example.com' });
const api = (token) => new PostgrestClient(`http://127.0.0.1:${API_PORT}`, { headers: token ? { Authorization: 'Bearer ' + token } : {} });

// ---------------------------------------------------------------- 起動
const dataDir = path.resolve('pgdata-verify-http');
fs.rmSync(dataDir, { recursive: true, force: true });
const server = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'local-only', port: PG_PORT,
    persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-c', 'max_connections=200'] });
await server.initialise();
await server.start();
const su = new pg.Pool({ host: '127.0.0.1', port: PG_PORT, user: 'postgres', password: 'local-only', database: 'postgres', max: 5 });
await su.query(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create role authenticator login noinherit password 'local-only';
    grant anon, authenticated, service_role to authenticator;
    create schema auth;
    create function auth.jwt() returns jsonb language sql stable as
        $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select nullif(auth.jwt() ->> 'role', '') $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on all functions in schema auth to anon, authenticated, service_role;
    create table public.calc_logs (
        id uuid primary key default gen_random_uuid(), user_id uuid,
        game text not null, dpi numeric not null, final_sens text not null,
        is_custom boolean default false, memo text,
        created_at timestamptz not null default clock_timestamp(),
        rating varchar default 'good', height numeric, dexterity text, play_style text, mouse_weight text, aim_part text,
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

// Windows 版の PostgREST は libpq.dll を必要とする。手元の Postgres に同梱のものを使う
const libDir = path.resolve('node_modules/@embedded-postgres/windows-x64/native/bin');
const rest = spawn(postgrestBin, [], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    PATH: (fs.existsSync(libDir) ? libDir + path.delimiter : '') + process.env.PATH,
    PGRST_DB_URI: `postgres://authenticator:local-only@127.0.0.1:${PG_PORT}/postgres`,
    PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: SECRET,
    PGRST_SERVER_PORT: String(API_PORT), PGRST_SERVER_HOST: '127.0.0.1', PGRST_DB_CHANNEL_ENABLED: 'true' } });
let restLog = '';
rest.stdout.on('data', (d) => { restLog += d; }); rest.stderr.on('data', (d) => { restLog += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what) {
    for (let i = 0; i < 100; i++) { try { if (await fn()) return; } catch (_) { /* まだ */ } await sleep(200); }
    throw new Error(what + ' を待ちきれませんでした\n' + restLog.slice(-600));
}
await waitFor(async () => (await fetch(`http://127.0.0.1:${API_PORT}/calc_logs?limit=1`)).status === 200, 'PostgREST の起動');
const reload = () => su.query(`notify pgrst, 'reload schema'`);
const rpcExists = async () => (await api(tokenOf(A)).rpc('save_calc_log', { p: {} })).error?.code !== 'PGRST202';

// ---------------------------------------------------------------- 道具
/** 本物の index.html を、指定の利用者としてログインした状態で読み込む（1回 = ページを1回開いたのと同じ）。 */
function openPage(uid) {
    const alerts = [];
    const client = api(tokenOf(uid));
    client.auth = { onAuthStateChange() {}, getUser: async () => ({ data: {} }), signOut() {} };
    const app = loadApp(undefined, { supabase: { createClient: () => client }, alert: (m) => alerts.push(m), confirm: () => true });
    app.setUser({ id: uid, email: 'user@example.com' });
    const save = async (memo, over = {}) => {
        const r = await app.saveResultToSupabase({ game: 'valo', dpi: 800, finalSens: '0.353', height: 173, dexterity: '3',
            armThickness: 'normal', mouseWeight: 'standard', aimPart: 'wrist', isCustom: true, memo, rating: 'good', ...over });
        await sleep(150);          // 保存後の一覧の読み直しが終わるのを待つ
        return r;
    };
    return { app, alerts, save, T: (k) => app.translations.ja[k] };
}
const visible = async (uid) => (await su.query(`select count(*)::int n from public.calc_logs
    where user_id = $1 and not coalesce(is_deleted_by_user,false) and source is distinct from 'diagnosis_auto'`, [uid])).rows[0].n;
const total = async (uid) => (await su.query(`select count(*)::int n from public.calc_logs where user_id = $1`, [uid])).rows[0].n;
const directInsert = (uid, over = {}) => api(tokenOf(uid)).from('calc_logs')
    .insert([{ user_id: uid, game: 'valo', dpi: 800, final_sens: '0.3', memo: 'direct', ...over }]);

let passed = 0; const failures = [];
async function check(name, fn) { try { await fn(); passed++; } catch (e) { failures.push(name + '\n     ' + e.message); } }
function eq(a, b, l) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${l || ''} 期待 ${JSON.stringify(b)} / 実際 ${JSON.stringify(a)}`); }
function ok(c, l) { if (!c) throw new Error(l || '条件を満たしません'); }

// ================================================================ 適用前（いまの本番と同じ状態）
const oldPage = openPage(A);      // 適用前に開いたままのページ。後で使う

await check('適用前: 関数が無いと PGRST202 が返り、画面は従来の手順で保存する（5件を保つ）', async () => {
    const r = await api(tokenOf(A)).rpc('save_calc_log', { p: {} });
    eq([r.error.code, r.status], ['PGRST202', 404], '本番で確認した応答と同じ形');
    for (let i = 0; i < 7; i++) eq(await oldPage.save('m' + i), true, i + ' 回目');
    eq(await visible(A), 5); eq(await total(A), 7); eq(oldPage.alerts, []);
    eq((await su.query(`select count(*)::int n from public.calc_logs where source = 'memo'`)).rows[0].n, 7, '従来の手順でも印を付ける');
});
await check('適用前: API を直接呼ぶと6件目が入ってしまう（いまの本番の状態）', async () => {
    const r = await directInsert(A);
    ok(!r.error, 'いまは入る');
    eq(await visible(A), 6);
    await su.query(`delete from public.calc_logs where memo = 'direct'`);
});

// ================================================================ 適用
await su.query(UP);
await reload();
await waitFor(rpcExists, '関数一覧の読み直し');

await check('適用後: 新しく開いたページは save_calc_log だけで保存する。5件のまま・古い行は残る', async () => {
    const page = openPage(A);
    const before = await total(A);
    eq(await page.save('after-1'), true); eq(await page.save('after-2', { isCustom: false }), true);
    eq(await visible(A), 5); eq(await total(A), before + 2); eq(page.alerts, []);
    const src = (await su.query(`select source from public.calc_logs order by created_at desc limit 2`)).rows.map((r) => r.source);
    eq(src, ['diagnosis_result', 'memo']);
});
await check('適用後: API を直接呼んでも6件目は入らない（エラーの形も確認）', async () => {
    const r = await directInsert(A);
    ok(r.error && /calc_logs_quota_exceeded/.test(r.error.message), JSON.stringify(r.error));
    eq(r.error.code, 'P0001');
    eq(await visible(A), 5);
});
await check('適用後: 非表示からの復元を直接呼んでも、5件を超えられない', async () => {
    const hidden = (await su.query(`select id from public.calc_logs where user_id = $1 and is_deleted_by_user limit 1`, [A])).rows[0].id;
    const r = await api(tokenOf(A)).from('calc_logs').update({ is_deleted_by_user: false }).eq('id', hidden).select('id');
    ok(r.error && /quota_exceeded/.test(r.error.message), JSON.stringify(r.error));
    eq(await visible(A), 5);
});
await check('適用後: 適用前から開いたままのページ（関数が無いと覚えている）でも保存でき、5件を超えない', async () => {
    const before = await total(A);
    eq(await oldPage.save('stale-page'), true);
    eq(await visible(A), 5); eq(await total(A), before + 1); eq(oldPage.alerts, []);
});
await check('適用後: すべてロックのとき、画面は「すべてロックされています」と表示する', async () => {
    await api(tokenOf(A)).from('calc_logs').update({ is_locked: true }).eq('user_id', A).eq('is_deleted_by_user', false);
    const page = openPage(A); const before = await total(A);
    eq(await page.save('blocked'), false);
    eq(page.alerts, [page.T('alertAllLocked')]);
    eq(await total(A), before);
    eq(await oldPage.save('blocked-old'), false, '古いページでも同じ');
    eq(await total(A), before);
    await api(tokenOf(A)).from('calc_logs').update({ is_locked: false }).eq('user_id', A);
});
await check('適用後: ロックの切替・削除（非表示）・一覧は従来どおり動く', async () => {
    const page = openPage(A);
    await page.app.loadLogs();
    eq(page.app.getElementById('logCountText').innerText, '5 / 5');
    const id = (await su.query(`select id from public.calc_logs where user_id = $1 and not coalesce(is_deleted_by_user,false) limit 1`, [A])).rows[0].id;
    await page.app.toggleLock(id, false); await sleep(100);
    eq((await su.query(`select is_locked from public.calc_logs where id = $1`, [id])).rows[0].is_locked, true);
    await page.app.toggleLock(id, true); await sleep(100);
    await page.app.deleteLog(id, false); await sleep(100);
    eq(await visible(A), 4); eq(page.alerts, []);
    eq(await page.save('refill'), true); eq(await visible(A), 5);
});
await check('適用後: 学習用の行は数えない。学習用の印を通常のメモに付けることはできない', async () => {
    for (let i = 0; i < 6; i++) ok(!(await directInsert(A, { memo: AUTO, source: 'diagnosis_auto', is_custom: false })).error, '学習用 ' + i);
    ok(!(await directInsert(A, { memo: AUTO, is_custom: false })).error, '古い版の形（印なし）');
    eq((await su.query(`select count(*)::int n from public.calc_logs where user_id = $1 and source = 'diagnosis_auto'`, [A])).rows[0].n, 7);
    eq(await visible(A), 5);
    const forged = await directInsert(A, { memo: '自分のメモ', source: 'diagnosis_auto' });
    ok(forged.error && /learning_row_invalid/.test(forged.error.message), JSON.stringify(forged.error));
    const forged2 = await directInsert(A, { memo: AUTO, is_custom: true });
    ok(forged2.error && /quota_exceeded/.test(forged2.error.message), 'memo だけの偽装は通常の行として数えられる');
    const page = openPage(A); await page.app.loadLogs();
    eq(page.app.getElementById('logCountText').innerText, '5 / 5', '画面の件数も学習用の行を含まない');
});
await check('適用後: RLS は変わらない（他人の行は読めない・変えられない。未ログインには何も見えず、保存関数も使えない）', async () => {
    const b = api(tokenOf(B));
    eq((await b.from('calc_logs').select('id')).data.length, 0, 'B から A の行は見えない');
    eq((await b.from('calc_logs').update({ is_deleted_by_user: true }).eq('user_id', A).select('id')).data.length, 0, 'B は A の行を変えられない');
    ok((await b.from('calc_logs').insert([{ user_id: A, game: 'valo', dpi: 800, final_sens: '0.3', memo: 'x' }])).error, 'B は A の名義で追加できない');
    const spoof = await b.rpc('save_calc_log', { p: { user_id: A, game: 'valo', dpi: 800, final_sens: '0.3', memo: 'spoof' } });
    ok(!spoof.error); eq((await su.query(`select user_id from public.calc_logs where memo = 'spoof'`)).rows[0].user_id, B, '引数の user_id は無視され、本人の行になる');
    const anon = api(null);
    eq((await anon.from('calc_logs').select('id')).data.length, 0, '未ログイン');
    const anonRpc = await anon.rpc('save_calc_log', { p: { game: 'valo', dpi: 800, final_sens: '0.3' } });
    ok(anonRpc.error, '未ログインは保存関数を使えない: ' + JSON.stringify(anonRpc.error).slice(0, 120));
    ok(!(await anon.from('calc_logs').insert([{ user_id: null, game: 'valo', dpi: 800, final_sens: '0.3', memo: AUTO }])).error, '未ログインの学習用の行（既存の仕様）は入る');
    const pageB = openPage(B); await pageB.app.loadLogs();
    eq(pageB.app.getElementById('logCountText').innerText, '1 / 5', 'B の画面には B の1件だけ');
});
await check('適用後: HTTP 経由で 40 の要求（保存関数 20・直接追加 20）を同時に送っても、5件を超えない・行は消えない', async () => {
    const before = await total(A);
    const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2
        ? api(tokenOf(A)).rpc('save_calc_log', { p: { game: 'valo', dpi: 800, final_sens: '0.3', memo: 'c' + i, is_custom: true } })
        : directInsert(A, { memo: 'c' + i }))));
    const okCount = rs.filter((r) => !r.error).length;
    const bad = rs.filter((r) => r.error && !/quota_exceeded/.test(r.error.message));
    eq(bad.map((r) => r.error.message), [], '上限以外のエラー');
    ok(okCount >= 20, '保存関数の 20 件は成功する: ' + okCount);
    eq(await visible(A), 5); eq(await total(A), before + okCount);
});
await check('適用後: 2つのページ（別の端末に相当）から同時に保存しても5件・どちらにも警告が出ない', async () => {
    const p1 = openPage(A), p2 = openPage(A), p3 = oldPage;
    const r = await Promise.all([p1.save('dev1'), p2.save('dev2'), p3.save('dev3-old-page')]);
    ok(r[0] && r[1], '新しいページの保存は両方成功');
    eq(await visible(A), 5);
    eq(p1.alerts.concat(p2.alerts).filter((m) => m !== undefined), [], '新しいページに警告なし');
    ok(!p3.alerts.includes(p3.T('alertRestoreFail')) && !p3.alerts.includes(p3.T('alertRestorePending')), '古いページにも「戻せていない」は出ない: ' + p3.alerts);
});

// ================================================================ 取り消し
await su.query(DOWN);
await reload();
await waitFor(async () => !(await rpcExists()), '関数一覧の読み直し（取り消し後）');

await check('取り消し後: 行はそのまま。新しく開いたページは従来の手順へ戻って保存できる', async () => {
    const before = await total(A);
    const page = openPage(A);
    eq(await page.save('after-rollback'), true);
    eq(await visible(A), 5); eq(await total(A), before + 1); eq(page.alerts, []);
    ok(!(await directInsert(A)).error, '直接の追加は再び通る（適用前と同じ）');
});

// ---------------------------------------------------------------- 片付け
rest.kill();
await su.end();
await server.stop();
fs.rmSync(dataDir, { recursive: true, force: true });

const all = passed + failures.length;
if (failures.length === 0) { console.log(`✅ 0006 の HTTP 経由の検証成功: ${passed}/${all} 件（Postgres 17 + PostgREST・本物の index.html の保存処理）`); process.exit(0); }
console.error(`❌ 0006 の HTTP 経由の検証失敗: ${failures.length}/${all} 件`);
for (const f of failures) console.error('   - ' + f);
process.exit(1);
