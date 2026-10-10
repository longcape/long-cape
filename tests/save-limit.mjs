// マイ感度ログ（calc_logs）の保存・無料5件枠・ロック・削除のテスト。
//
//   node tests/save-limit.mjs
//
// index.html の本物の保存処理を、模擬の Supabase クライアントにつないで動かす。
// 一覧取得の失敗・保存の失敗・復元の失敗・別タブとの競合・連打を再現する。
// 本番DB・ネットワーク・実アカウントには一切触れない。
//
// 模擬クライアントは本番の RLS と同じ規則を持つ（自分の行しか読めない・書けない）。
// ただし **本番の RLS そのものを検査しているわけではない**。本番の policy は supabase/schema.sql の読解まで。

import fs from 'node:fs';
import path from 'node:path';
import { loadApp, REPO_ROOT } from './lib/sandbox.mjs';

let passed = 0;
const failures = [];
const pending = [];
const check = (name, fn) => pending.push({ name, fn });
function eq(a, b, l) {
    const x = JSON.stringify(a), y = JSON.stringify(b);
    if (x !== y) throw new Error(`${l || ''} 期待 ${y} / 実際 ${x}`);
}
function ok(c, l) { if (!c) throw new Error(l || '条件を満たしません'); }
const tick = () => new Promise((r) => setTimeout(r, 0));

const AUTO_MEMO = '自動学習収集データ';

/** calc_logs だけを持つ模擬クライアント。失敗の注入と、操作の記録ができる。 */
function createFake() {
    const db = {
        rows: [], seq: 0, uid: null,
        fail: [],          // [{ op, when(ctx), mode: 'error' | 'throw' | 'noop', times }]
        calls: [],         // 実行された操作の記録
        afterSelect: null, // 一覧取得の直後に割り込む処理（別タブの再現）
        rpc: 'absent',     // 'absent' = DB に save_calc_log が無い（適用前） / 'present' = ある（適用後）
        trigger: false,    // true = DB 側の5件枠（0006 の trigger）がある
    };
    // DB 側（0006）と同じ定義
    const countable = (r) => !!r.user_id && !r.is_deleted_by_user && r.source !== 'diagnosis_auto';
    const quotaError = { data: null, error: { code: 'P0001', message: 'calc_logs_quota_exceeded' } };
    const isAdminUid = () => db.uid === 'admin-1';
    const overLimit = (uid, exceptId) => db.rows.filter((r) => r.user_id === uid && r.id !== exceptId && countable(r)).length >= 5;
    function takeFailure(op, ctx) {
        const i = db.fail.findIndex((f) => f.op === op && f.times > 0 && (!f.when || f.when(ctx)));
        if (i < 0) return null;
        db.fail[i].times--;
        return db.fail[i].mode || 'error';
    }
    function from(table) {
        if (table !== 'calc_logs') throw new Error('このテストは calc_logs だけを扱います: ' + table);
        const st = { op: 'select', payload: null, filters: [], order: null, returning: false };
        const api = {
            select() { if (st.op !== 'select') st.returning = true; return api; },
            insert(rows) { st.op = 'insert'; st.payload = rows; return api; },
            update(p) { st.op = 'update'; st.payload = p; return api; },
            eq(k, v) { st.filters.push([k, v]); return api; },
            order(k, o) { st.order = { k, asc: !!(o && o.ascending) }; return api; },
            then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
        };
        const match = (r) => st.filters.every(([k, v]) => r[k] === v);
        function run() {
            const mode = takeFailure(st.op, st);
            db.calls.push({ op: st.op, payload: st.payload, filters: st.filters, failed: mode });
            if (mode === 'throw') throw new Error('Failed to fetch');
            if (mode === 'error') return { data: null, error: { message: 'boom' } };
            if (st.op === 'select') {
                // RLS: 自分の行だけ
                let out = db.rows.filter((r) => db.uid && r.user_id === db.uid && match(r)).map((r) => ({ ...r }));
                if (st.order) out.sort((a, b) => (a[st.order.k] - b[st.order.k]) * (st.order.asc ? 1 : -1));
                if (db.afterSelect) { const f = db.afterSelect; db.afterSelect = null; f(); }
                return { data: out, error: null };
            }
            if (st.op === 'insert') {
                for (const row of st.payload) {
                    // RLS: ログイン中は自分の user_id、未ログインは null だけ
                    if ((db.uid && row.user_id !== db.uid) || (!db.uid && row.user_id !== null)) {
                        return { data: null, error: { message: 'new row violates row-level security policy' } };
                    }
                    const fresh = { is_locked: false, is_deleted_by_user: false, rating: 'good', is_custom: false, source: null,
                        ...row, id: 'r' + (++db.seq), created_at: db.seq };
                    if (db.trigger && db.uid && !isAdminUid() && countable(fresh) && overLimit(fresh.user_id, fresh.id)) return quotaError;
                    db.rows.push(fresh);
                }
                return { data: null, error: null };
            }
            // update。RLS: 自分の行だけ。mode 'noop' は「エラーは出ないが1行も変わらない」
            const hit = mode === 'noop' ? [] : db.rows.filter((r) => db.uid && r.user_id === db.uid && match(r));
            if (db.trigger && !isAdminUid()) {
                for (const r of hit) {
                    const next = { ...r, ...st.payload };
                    if (!countable(r) && countable(next) && overLimit(r.user_id, r.id)) return quotaError;
                }
            }
            hit.forEach((r) => Object.assign(r, st.payload));
            return { data: st.returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
        }
        return api;
    }
    /** save_calc_log の模擬。DB 側と同じく、全体が成功するか、何も変わらないかのどちらか。 */
    async function rpc(name, args) {
        const mode = takeFailure('rpc', { name, args });
        db.calls.push({ op: 'rpc', name, args, failed: mode });
        if (mode === 'throw') throw new Error('Failed to fetch');
        if (mode === 'error') return { data: null, error: { message: 'boom' } };
        if (db.rpc !== 'present' || name !== 'save_calc_log') {
            return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.' + name + '(p) in the schema cache' } };
        }
        if (!db.uid) return { data: null, error: { code: '42501', message: 'permission denied for function save_calc_log' } };
        const p = args.p;
        if (!p.game) return { data: null, error: { code: '23502', message: 'null value in column "game"' } };
        const mine = () => db.rows.filter((r) => r.user_id === db.uid && countable(r)).sort((a, b) => a.created_at - b.created_at);
        const toHide = [];
        if (!isAdminUid()) {
            const rows = mine();
            const over = rows.length - 4;
            if (over > 0) {
                const unlocked = rows.filter((r) => !r.is_locked);
                if (unlocked.length < over) return { data: null, error: { code: 'P0001', message: 'calc_logs_all_locked' } };
                toHide.push(...unlocked.slice(0, over));
            }
        }
        toHide.forEach((r) => { r.is_deleted_by_user = true; });
        const row = { is_locked: false, is_deleted_by_user: false, rating: 'good', ...p, user_id: db.uid,
            source: p.is_custom ? 'memo' : 'diagnosis_result', id: 'r' + (++db.seq), created_at: db.seq };
        db.rows.push(row);
        return { data: row.id, error: null };
    }
    const client = { from, rpc, auth: { onAuthStateChange() {}, getUser: async () => ({ data: {} }), signOut() {} } };
    return { db, supabase: { createClient: () => client } };
}

const USER = { id: 'user-1', email: 'player@example.com' };
const OTHER = { id: 'user-2', email: 'other@example.com' };
const ADMIN = { id: 'admin-1', email: 'rokikiroki@gmail.com' };

function setup(user = USER) {
    const fake = createFake();
    const alerts = [];
    const app = loadApp(undefined, { supabase: fake.supabase, alert: (m) => alerts.push(m), confirm: () => true });
    app.setUser(user);
    fake.db.uid = user ? user.id : null;
    const seed = (n, over = {}) => {
        for (let i = 0; i < n; i++) {
            fake.db.rows.push({ id: 'r' + (++fake.db.seq), created_at: fake.db.seq, user_id: (over.user_id ?? (user && user.id)),
                game: 'valo', dpi: 800, final_sens: '0.3', is_custom: true, memo: 'memo' + fake.db.seq, rating: 'good',
                is_locked: false, is_deleted_by_user: false, ...over });
        }
    };
    const mine = () => fake.db.rows.filter((r) => r.user_id === (user && user.id));
    const visible = () => mine().filter((r) => !r.is_deleted_by_user && r.source !== 'diagnosis_auto'
        && !(r.source == null && r.memo === AUTO_MEMO && !r.is_custom));
    const inserts = () => fake.db.calls.filter((c) => c.op === 'insert' && !c.failed).length;
    const save = async (memo = 'new') => {
        const r = await app.saveResultToSupabase({ game: 'valo', dpi: 800, finalSens: '0.353', height: 173,
            dexterity: '3', armThickness: 'normal', mouseWeight: 'standard', aimPart: 'wrist',
            isCustom: false, memo, rating: 'good' });
        await tick(); await tick();
        return r;
    };
    const T = (k) => app.translations.ja[k];
    return { fake, db: fake.db, app, alerts, seed, mine, visible, inserts, save, T };
}

// ============================================================ 通常の保存と5件枠

check('5件未満なら、そのまま1件増える', async () => {
    const s = setup(); s.seed(3);
    eq(await s.save(), true);
    eq(s.visible().length, 4); eq(s.mine().length, 4); eq(s.alerts, []);
});
check('5件あるときは、いちばん古い未ロックの1件を非表示にして入れ替える（行そのものは消さない）', async () => {
    const s = setup(); s.seed(5);
    const oldest = s.db.rows[0].id;
    eq(await s.save(), true);
    eq(s.visible().length, 5);
    eq(s.mine().length, 6, 'DB の行は消えていない');
    eq(s.db.rows.find((r) => r.id === oldest).is_deleted_by_user, true);
    ok(s.visible().some((r) => r.memo === 'new'));
    await s.app.loadLogs();
    eq(s.app.getElementById('logCountText').innerText, '5 / 5');
});
check('ロックした行は自動の入れ替えの対象にならない', async () => {
    const s = setup(); s.seed(5);
    s.db.rows[0].is_locked = true; s.db.rows[1].is_locked = true;
    eq(await s.save(), true);
    eq(s.db.rows[0].is_deleted_by_user, false); eq(s.db.rows[1].is_deleted_by_user, false);
    eq(s.db.rows[2].is_deleted_by_user, true, '未ロックの中で最も古い行');
    eq(s.visible().length, 5);
});
check('5件すべてロックなら保存しない（何も変えない）', async () => {
    const s = setup(); s.seed(5, { is_locked: true });
    eq(await s.save(), false);
    eq(s.inserts(), 0); eq(s.visible().length, 5); eq(s.alerts, [s.T('alertAllLocked')]);
});

// ============================================================ P0: 確認できないときは保存しない

for (const [label, mode] of [['エラーが返る', 'error'], ['通信が例外で落ちる', 'throw']]) {
    check(`一覧を取得できないとき（${label}）は保存を中止し、0件とみなして進めない`, async () => {
        const s = setup(); s.seed(5);
        s.db.fail.push({ op: 'select', mode, times: 1 });
        eq(await s.save(), false);
        eq(s.inserts(), 0, '挿入していない');
        eq(s.db.calls.filter((c) => c.op === 'update').length, 0, '既存の行にも触れていない');
        eq(s.visible().length, 5); eq(s.mine().length, 5);
        eq(s.alerts, [s.T('alertSaveCheckFail')]);
    });
}
check('一覧の中身が配列でないとき（data が null）も保存しない', async () => {
    const s = setup(); s.seed(5);
    const orig = s.fake.supabase.createClient;
    // 1回目の select だけ { data: null, error: null } を返す
    let first = true;
    const real = orig().from;
    s.app.setClient({ from(t) {
        const q = real(t);
        const then = q.then.bind(q);
        q.then = (res, rej) => then((v) => { if (first && Array.isArray(v.data)) { first = false; return res({ data: null, error: null }); } return res(v); }, rej);
        return q;
    }, rpc: orig().rpc, auth: orig().auth });
    eq(await s.save(), false);
    eq(s.inserts(), 0); eq(s.visible().length, 5);
});
check('枠を空ける非表示に失敗したら保存しない（エラー・1行も変わらない、の両方）', async () => {
    for (const mode of ['error', 'noop', 'throw']) {
        const s = setup(); s.seed(5);
        s.db.fail.push({ op: 'update', mode, times: 1 });
        eq(await s.save(), false, mode);
        eq(s.inserts(), 0, mode + ': 挿入していない');
        eq(s.visible().length, 5, mode + ': 既存の5件はそのまま');
    }
});

// ============================================================ P0: 保存の失敗と復元

check('保存に失敗したら、非表示にした古い行を元へ戻す', async () => {
    for (const mode of ['error', 'throw']) {
        const s = setup(); s.seed(5);
        s.db.fail.push({ op: 'insert', mode, times: 1 });
        eq(await s.save(), false, mode);
        eq(s.visible().length, 5, mode + ': 5件に戻っている');
        eq(s.mine().length, 5, mode);
        ok(s.alerts[0].startsWith(s.T('alertSaveErr')), mode + ': 失敗を伝える');
    }
});
check('復元にも失敗したら「戻せていない」と伝え、成功として扱わない。行は DB に残っている', async () => {
    const s = setup(); s.seed(5);
    const oldest = s.db.rows[0].id;
    s.db.fail.push({ op: 'insert', mode: 'error', times: 1 });
    s.db.fail.push({ op: 'update', mode: 'error', times: 99, when: (st) => st.payload.is_deleted_by_user === false });
    eq(await s.save(), false);
    eq(s.alerts[0], s.T('alertRestoreFail'));
    ok(s.db.rows.some((r) => r.id === oldest), '行は消えていない');
    eq(s.visible().length, 4, '非表示のまま');
    eq(JSON.parse(s.app.localStorage.getItem('lc_pending_restore_' + USER.id)), [oldest], '戻すべき行を控えている');
    await s.app.loadLogs();
    ok(s.app.getElementById('logsList').innerHTML.includes(s.T('alertRestorePending')), '一覧にも表示する');
});
check('戻せていない行があるあいだは、新しい保存をしない', async () => {
    const s = setup(); s.seed(5);
    s.db.fail.push({ op: 'insert', mode: 'error', times: 1 });
    s.db.fail.push({ op: 'update', mode: 'error', times: 99, when: (st) => st.payload.is_deleted_by_user === false });
    await s.save();
    s.alerts.length = 0;
    eq(await s.save('second'), false);
    eq(s.inserts(), 0);
    eq(s.alerts, [s.T('alertRestorePending')]);
    ok(!s.mine().some((r) => r.memo === 'second'));
});
check('通信が戻れば、次に一覧を開いたときに自動で元へ戻る（控えも消える）', async () => {
    const s = setup(); s.seed(5);
    const oldest = s.db.rows[0].id;
    s.db.fail.push({ op: 'insert', mode: 'error', times: 1 });
    s.db.fail.push({ op: 'update', mode: 'error', times: 99, when: (st) => st.payload.is_deleted_by_user === false });
    await s.save();
    s.db.fail.length = 0;                       // 通信が回復
    await s.app.loadLogs();
    eq(s.db.rows.find((r) => r.id === oldest).is_deleted_by_user, false);
    eq(s.visible().length, 5);
    eq(s.app.localStorage.getItem('lc_pending_restore_' + USER.id), null);
    eq(await s.save('after'), true, '復元後は保存できる');
    eq(s.visible().length, 5);
});

// ============================================================ P0: 競合・連打

check('別のタブが先に保存して6件になっていても、保存後は5件に収まる', async () => {
    const s = setup(); s.seed(6);
    eq(await s.save(), true);
    eq(s.visible().length, 5);
    ok(s.visible().some((r) => r.memo === 'new'));
});
check('件数を数えた直後に別のタブが1件保存しても、保存後に5件へ戻す', async () => {
    const s = setup(); s.seed(5);
    s.db.afterSelect = () => s.seed(1, { memo: 'other-tab' });   // 一覧取得と挿入のあいだに割り込む
    eq(await s.save(), true);
    eq(s.visible().length, 5, '5件を超えたままにしない');
    ok(s.visible().some((r) => r.memo === 'new'));
});
check('保存ボタンを連打しても1件しか入らない', async () => {
    const s = setup(); s.seed(2);
    const results = await Promise.all([s.save('a'), s.save('a'), s.save('a')]);
    eq(results.filter(Boolean).length, 1);
    eq(s.inserts(), 1); eq(s.visible().length, 3);
});
check('通常の操作を繰り返しても5件を超えない（保存20回・途中でロックと削除）', async () => {
    const s = setup();
    for (let i = 0; i < 20; i++) {
        await s.save('m' + i);
        if (i === 6) await s.app.toggleLock(s.visible()[0].id, false);
        if (i === 12) await s.app.deleteLog(s.visible().find((r) => !r.is_locked).id, false);
        await tick();
        ok(s.visible().length <= 5, `${i} 回目: ${s.visible().length} 件`);
    }
    eq(s.visible().length, 5);
});

// ============================================================ 学習用の自動収集は枠に数えない

check('診断時に自動で送られる学習用の行は、一覧にも5件枠にも数えない', async () => {
    const s = setup(); s.seed(5); s.seed(3, { memo: AUTO_MEMO, is_custom: false });
    await s.app.loadLogs();
    eq(s.app.getElementById('logCountText').innerText, '5 / 5');
    ok(!s.app.getElementById('logsList').innerHTML.includes(AUTO_MEMO), '一覧に出さない');
    eq(await s.save(), true);
    eq(s.visible().length, 5);
    eq(s.mine().filter((r) => r.memo === AUTO_MEMO && !r.is_deleted_by_user).length, 3, '学習用の行には触れない');
});
check('学習用の行が何件たまっても、メモが5件未満なら既存のメモを押し出さない', async () => {
    const s = setup(); s.seed(2); s.seed(10, { memo: AUTO_MEMO, is_custom: false });
    eq(await s.save(), true);
    eq(s.visible().length, 3);
    eq(s.db.calls.filter((c) => c.op === 'update').length, 0, 'どの行も非表示にしていない');
});

// ============================================================ 認証・権限

check('未ログインでは保存処理が DB に触れない', async () => {
    const s = setup(null);
    eq(await s.save(), false);
    eq(s.db.calls.length, 0);
});
check('他人の行は見えず、件数にも入らず、入れ替えの対象にもならない', async () => {
    const s = setup(); s.seed(5); s.seed(5, { user_id: OTHER.id });
    eq(await s.save(), true);
    eq(s.db.rows.filter((r) => r.user_id === OTHER.id && r.is_deleted_by_user).length, 0);
    eq(s.visible().length, 5);
});
check('別のユーザーへ切り替えると、控えも件数も混ざらない', async () => {
    const s = setup(); s.seed(5);
    s.app.localStorage.setItem('lc_pending_restore_' + OTHER.id, JSON.stringify(['zzz']));
    eq(await s.save(), true, '他人の控えに引きずられない');
});
check('管理者は件数の制限を受けない（既存の仕様）', async () => {
    const s = setup(ADMIN); s.seed(7);
    eq(await s.save(), true);
    eq(s.visible().length, 8);
});

// ============================================================ ロック・削除

check('ロックの切替: 成功すれば反映、失敗すれば理由を出して変えない', async () => {
    const s = setup(); s.seed(1);
    await s.app.toggleLock(s.db.rows[0].id, false);
    eq(s.db.rows[0].is_locked, true);
    s.db.fail.push({ op: 'update', mode: 'error', times: 1 });
    await s.app.toggleLock(s.db.rows[0].id, true);
    eq(s.db.rows[0].is_locked, true, '変わっていない');
    ok(s.alerts[0].startsWith(s.T('alertLockErr')));
});
check('削除: ロック中は消さない。未ロックは非表示にする（行は残る）。失敗したら成功にしない', async () => {
    const s = setup(); s.seed(2);
    await s.app.deleteLog(s.db.rows[0].id, true);
    eq(s.db.rows[0].is_deleted_by_user, false); eq(s.alerts, [s.T('alertLockedDelete')]);
    await s.app.deleteLog(s.db.rows[0].id, false);
    eq(s.db.rows[0].is_deleted_by_user, true); eq(s.mine().length, 2);
    s.alerts.length = 0;
    s.db.fail.push({ op: 'update', mode: 'error', times: 1 });
    await s.app.deleteLog(s.db.rows[1].id, false);
    eq(s.db.rows[1].is_deleted_by_user, false);
    ok(s.alerts[0].startsWith(s.T('alertDeleteErr')));
});
check('ロックは無料の記録保護であって、課金の制御ではない（課金の処理は存在しない）', async () => {
    const html = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
    ok(!/stripe|checkout|subscription|is_premium|plan_id|entitlement/i.test(html), '課金に関わるコードがある');
    ok(/is_locked/.test(html));
});


// ============================================================ 原子的な保存（save_calc_log）と、無い期間の互換

check('DB に save_calc_log が無いあいだ（適用前・取り消し後）は、従来の手順で保存できる', async () => {
    const s = setup(); s.seed(5);
    eq(s.db.rpc, 'absent');
    eq(await s.save(), true);
    eq(s.visible().length, 5);
    eq(s.db.calls.filter((c) => c.op === 'rpc').length, 1, '最初に一度だけたずねる');
    eq(await s.save('second'), true);
    eq(s.db.calls.filter((c) => c.op === 'rpc').length, 1, '無いと分かったら、このページでは毎回たずねない');
    eq(s.alerts, []);
});
check('save_calc_log があれば、それ1回で保存する（従来の「隠す → 追加」の通信をしない）', async () => {
    const s = setup(); s.seed(5); s.db.rpc = 'present';
    const oldest = s.db.rows[0].id;
    eq(await s.save(), true);
    const duringSave = s.db.calls.filter((c) => c.op === 'insert' || c.op === 'update');
    eq(duringSave.length, 0, '直接の追加・更新をしていない');
    eq(s.visible().length, 5); eq(s.mine().length, 6);
    eq(s.db.rows.find((r) => r.id === oldest).is_deleted_by_user, true);
    const call = s.db.calls.find((c) => c.op === 'rpc');
    eq(call.name, 'save_calc_log');
    ok(!('user_id' in call.args.p), 'user_id を送っていない');
    eq([call.args.p.game, call.args.p.final_sens, call.args.p.is_custom], ['valo', '0.353', false]);
});
check('save_calc_log: すべてロックなら断られ、その旨を表示する（従来の手順へは進まない）', async () => {
    const s = setup(); s.seed(5, { is_locked: true }); s.db.rpc = 'present';
    eq(await s.save(), false);
    eq(s.alerts, [s.T('alertAllLocked')]);
    eq(s.inserts(), 0); eq(s.mine().length, 5);
});
check('save_calc_log が結果の分からない失敗（通信断・サーバーのエラー）をしたら、従来の手順へ進まない（二重保存しない）', async () => {
    for (const mode of ['throw', 'error']) {
        const s = setup(); s.seed(5); s.db.rpc = 'present';
        s.db.fail.push({ op: 'rpc', mode, times: 1 });
        eq(await s.save(), false, mode);
        eq(s.db.calls.filter((c) => c.op === 'insert' || c.op === 'update').length, 0, mode + ': 従来の手順を実行していない');
        eq(s.visible().length, 5, mode); eq(s.mine().length, 5, mode);
        ok(s.alerts[0].startsWith(s.T('alertSaveErr')), mode);
        eq(await s.save('retry'), true, mode + ': 次は保存できる');
    }
});
check('save_calc_log: 連打・くり返しでも5件を超えない。管理者は無制限', async () => {
    const s = setup(); s.db.rpc = 'present';
    for (let i = 0; i < 12; i++) { await s.save('m' + i); ok(s.visible().length <= 5); }
    eq(s.visible().length, 5); eq(s.mine().length, 12);
    const r = await Promise.all([s.save('x'), s.save('x'), s.save('x')]);
    eq(r.filter(Boolean).length, 1, '連打');
    const a = setup(ADMIN); a.db.rpc = 'present'; a.seed(7);
    eq(await a.save(), true); eq(a.visible().length, 8);
});
check('途中で DB に適用されても動く: 古い手順で始めた保存が DB の5件枠に断られたら、戻せない行を「戻す必要なし」として片付ける', async () => {
    // このページは「関数が無い」と覚えている。その後で DB に 0006 が適用された、という場面
    const s = setup(); s.seed(5);
    eq(await s.save('before'), true);                 // 関数が無いことを覚える
    s.db.trigger = true;                              // DB 側の5件枠が入る
    // 別の端末が、こちらが古い行を隠した直後に1件保存する
    let stolen = false;
    const realFrom = s.fake.supabase.createClient().from;
    s.app.setClient({ from(t) {
        const q = realFrom(t);
        const insert = q.insert.bind(q);
        q.insert = (rows) => { if (!stolen) { stolen = true; s.db.trigger = false; s.seed(1, { memo: 'other-device' }); s.db.trigger = true; } return insert(rows); };
        return q;
    }, rpc: s.fake.supabase.createClient().rpc, auth: s.fake.supabase.createClient().auth });
    eq(await s.save('mine'), false, 'DB に断られる');
    ok(s.alerts.some((m) => m.startsWith(s.T('alertSaveErr'))), '保存できなかったことを伝える');
    ok(!s.alerts.includes(s.T('alertRestoreFail')), '「戻せていない」という警告は出さない');
    eq(s.app.localStorage.getItem('lc_pending_restore_' + USER.id), null, '控えを残さない');
    eq(s.visible().length, 5, '5件を超えていない');
    s.alerts.length = 0;
    await s.app.loadLogs();
    ok(!s.app.getElementById('logsList').innerHTML.includes(s.T('alertRestorePending')), '一覧にも警告を出さない');
});
check('以前の失敗で控えていた行が、DB の5件枠で戻せなくなっていても、控えを片付けて保存できる', async () => {
    const s = setup(); s.seed(5); s.db.rpc = 'present'; s.db.trigger = true;
    s.seed(1, { is_deleted_by_user: true, memo: 'hidden-old' });
    const hiddenId = s.db.rows[s.db.rows.length - 1].id;
    s.app.localStorage.setItem('lc_pending_restore_' + USER.id, JSON.stringify([hiddenId]));
    eq(await s.save(), true);
    eq(s.app.localStorage.getItem('lc_pending_restore_' + USER.id), null);
    eq(s.visible().length, 5);
    ok(s.db.rows.some((r) => r.id === hiddenId), '行は消えていない');
});

// ============================================================ 学習用の印

check('学習用の行の見分け方は DB 側と同じ（印つき・古い形・memo だけ偽装した感度メモ）', async () => {
    const s = setup(); s.seed(3);
    s.seed(2, { memo: AUTO_MEMO, is_custom: false, source: 'diagnosis_auto' });   // 新しいアプリの学習用の行
    s.seed(2, { memo: AUTO_MEMO, is_custom: false, source: null });               // 古いアプリの学習用の行
    s.seed(1, { memo: AUTO_MEMO, is_custom: true, source: null });                // memo だけ学習用の文言にした感度メモ
    await s.app.loadLogs();
    eq(s.app.getElementById('logCountText').innerText, '4 / 5', '偽装した感度メモは数える');
    eq((s.app.getElementById('logsList').innerHTML.match(/class="log-item"/g) || []).length, 4);
});
check('index.html は学習用の行に印（source）を付けて送り、通常の保存にも印を付ける', async () => {
    const html = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
    const collect = html.slice(html.indexOf('function collectLearningSample'), html.indexOf('function handleSaveClick'));
    ok(/source: LEARNING_SOURCE/.test(collect), '学習用の行');
    ok(/memo: '自動学習収集データ'/.test(collect) && /is_custom: false/.test(collect), 'DB 側が求める形（memo・is_custom）');
    const s = setup(); s.seed(1);
    await s.save();
    eq(s.mine().find((r) => r.memo === 'new').source, 'diagnosis_result', '従来の手順での保存');
});
check('DB 側の SQL と画面側で、上限と学習用の文言が食い違っていない', async () => {
    const html = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
    const sql = fs.readFileSync(path.join(REPO_ROOT, 'supabase/migrations/pending/0006_calc_logs_quota.sql'), 'utf8');
    ok(/const FREE_LOG_LIMIT = 5;/.test(html) && /select 5;/.test(sql), '上限');
    for (const memo of ['自動学習収集データ', '自動収集データ']) ok(html.includes("'" + memo + "'") && sql.includes("'" + memo + "'"), memo);
    ok(html.includes("const LEARNING_SOURCE = 'diagnosis_auto';") && sql.includes("'diagnosis_auto'"));
    ok(html.includes("rpc('save_calc_log'") && /create or replace function public\.save_calc_log\(p jsonb\)/.test(sql), '関数名と引数名');
    for (const key of ['game', 'dpi', 'final_sens', 'height', 'dexterity', 'play_style', 'mouse_weight', 'aim_part', 'is_custom', 'memo', 'rating']) {
        ok(new RegExp("p->>'" + key + "'").test(sql), 'SQL が ' + key + ' を読む');
        ok(new RegExp('\\b' + key + ': ').test(html.slice(html.indexOf('async function saveViaRpc'), html.indexOf('async function saveResultInner'))), '画面が ' + key + ' を送る');
    }
});

// ============================================================ サーバー側（既知の制約の記録）

check('【適用前の現状】本番と同じ定義（schema.sql）には件数の検査が無い。DB 側の5件枠は pending の 0006 を適用して初めて効く', async () => {
    const sql = fs.readFileSync(path.join(REPO_ROOT, 'supabase/schema.sql'), 'utf8');
    const calc = sql.slice(sql.indexOf('2. calc_logs'), sql.indexOf('Aim 系（G-4'));
    ok(!/create\s+(or\s+replace\s+)?trigger/i.test(calc), 'calc_logs に trigger が追加された。この検査を見直すこと');
    ok(!/count\s*\(/i.test(calc), 'calc_logs の policy に件数の条件が追加された。この検査を見直すこと');
    // 模擬クライアントでも、画面の処理を通さず直接入れれば6件目が入る（＝画面側だけの制御）
    const s = setup(); s.seed(5);
    const client = s.fake.supabase.createClient();
    await client.from('calc_logs').insert([{ user_id: USER.id, game: 'valo', memo: 'direct' }]);
    eq(s.visible().length, 6);
});

// ------------------------------------------------------------- 実行

for (const { name, fn } of pending) {
    try { await fn(); passed++; }
    catch (e) { failures.push({ name, message: e.message }); }
}

const total = passed + failures.length;
if (failures.length === 0) {
    console.log(`✅ 保存・5件枠・ロック・削除テスト成功: ${passed}/${total} 件`);
    process.exit(0);
}
console.error(`❌ 保存・5件枠・ロック・削除テスト失敗: ${failures.length}/${total} 件`);
for (const f of failures) console.error(`   - ${f.name}\n     ${f.message}`);
process.exit(1);
