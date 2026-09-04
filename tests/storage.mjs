// G-5 の保存・読込・削除のテスト。
//
//   node tests/storage.mjs
//
// 本番DB・ネットワークには一切触れない。tests/lib/fake-supabase.mjs が
// 本番へ適用した migration（0001〜0005）と同じ規則を実装しており、
// 「アプリ側が RLS に頼りきらず自分でも守っているか」も併せて検証する。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase } from './lib/fake-supabase.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function load() {
    const ctx = {
        console, Math, JSON, Date, Number, String, Boolean, Array, Object, isFinite, isNaN,
        Promise, Uint8Array, ArrayBuffer, TextEncoder, crypto, Error
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of ['importers/kovaak.js', 'profile/metric-registry.js', 'profile/algorithm-config.js',
        'profile/aim-profile.js', 'profile/re-estimation.js', 'ui/ui-logic.js', 'ui/samples.js',
        'ui/storage.js']) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    }
    return ctx;
}

const ctx = load();
const ST = ctx.LC_STORAGE, U = ctx.LC_UI, K = ctx.LC_IMPORTERS.kovaak,
    P = ctx.LC_PROFILE, S = ctx.LC_SAMPLES, M = ctx.LC_METRICS;

// Registry を fake クライアントへ渡す形に変換
const REGISTRY = {};
M.all.forEach((m) => { REGISTRY[m.metric_key] = { unit: m.unit, metric_version: m.metric_version }; });

const A = 'user-A', B = 'user-B';

let passed = 0;
const failures = [];
const pending = [];
const check = (name, fn) => pending.push({ name, fn });
function eq(a, b, l) {
    const x = JSON.stringify(a), y = JSON.stringify(b);
    if (x !== y) throw new Error(`${l || ''} 期待 ${y} / 実際 ${x}`);
}
function ok(c, l) { if (!c) throw new Error(l || '条件を満たしません'); }

const runImport = (kind) => K.run(S.files(kind), { importedAt: '2026-09-05T00:00:00.000Z' });

async function setup(kind = 'normal', opts = {}) {
    const client = createFakeSupabase({ registry: REGISTRY });
    const r = await runImport(kind);
    const dpi = U.resolveDpi(r.sessions, { answer: U.DPI_ANSWER.AS_IS });
    client.signInAs(opts.userId || A);

    let consentId = null;
    if (opts.consent !== false) {
        const g = await ST.grantConsent(client, opts.userId || A, 'profile_storage', 'v1');
        consentId = g.data.id;
    }
    return { client, sessions: r.sessions, dpi, consentId, run: r };
}

function planFor(env, extra = {}) {
    return ST.buildSavePlan({
        auth: { loggedIn: true, userId: extra.userId || A },
        consent: extra.consent || { profile_storage: true },
        consentId: extra.consentId !== undefined ? extra.consentId : env.consentId,
        sessions: extra.sessions || env.sessions,
        existingSessions: extra.existingSessions || [],
        confirmedDpi: extra.confirmedDpi !== undefined ? extra.confirmedDpi : env.dpi.confirmedDpi,
        dpiSource: 'user_confirmed_file_value',
        registry: REGISTRY,
        registryVersion: '1.5.0',
        parserVersion: extra.parserVersion || ST.PARSER_VERSION,
        filesReceived: 2,
        derivedAccuracyOf: U.derivedAccuracy,
        cm360Of: (s, dpiVal) => {
            const c = U.cm360(s.context.sensScale, s.context.inGameSens, dpiVal);
            return c.available ? c.value : null;
        }
    });
}

// ======================================================= 同意との実接続

check('未ログインでは保存しない', async () => {
    const g = ST.canPersist({ loggedIn: false }, { profile_storage: true });
    eq(g.allowed, false, '保存させない');
    eq(g.reason, 'not_logged_in', '理由');
    ok(/ログインなしでもできます/.test(g.message), 'preview は使えると伝える');
});

check('profile_storage が無ければ保存しない', async () => {
    const g = ST.canPersist({ loggedIn: true, userId: A }, { profile_storage: false });
    eq(g.allowed, false, '保存させない');
    eq(g.reason, 'consent_missing', '理由');
    eq(g.requiredConsent, 'profile_storage', '必要な同意を示す');
});

check('profile_storage だけで保存できる（他の同意を条件にしない）', async () => {
    const g = ST.canPersist({ loggedIn: true, userId: A },
        { profile_storage: true, anonymized_statistics: false, model_improvement: false });
    eq(g.allowed, true, '保存できる');
    eq(g.optionalConsentsIgnored, ['anonymized_statistics', 'model_improvement'], '任意の同意は条件にしない');
});

check('同意なしでは1行も書かれない', async () => {
    const env = await setup('normal', { consent: false });
    const plan = planFor(env, { consent: { profile_storage: false }, consentId: null });
    eq(plan.ok, false, '計画を作らない');
    const res = await ST.executeSavePlan(env.client, plan);
    eq(res.saved, false, '保存しない');
    eq(env.client._db.aim_sessions.length, 0, 'session が0件');
    eq(env.client._db.aim_import_batches.length, 0, 'batch が0件');
});

check('DBの policy 側でも同意なしを拒否する（アプリを迂回しても止まる）', async () => {
    const env = await setup('normal', { consent: false });
    const r = await env.client.from('aim_import_batches')
        .insert({ user_id: A, source: 'kovaak', parser_version: '1', normalization_version: '1',
                  registry_version: '1.5.0', consent_id: 'no-such-consent' }).select().single();
    ok(r.error, '拒否される');
    ok(/profile_storage/.test(r.error.message), '同意が理由と分かる');
});

// ======================================================= 保存

check('ログインユーザーの取り込みを保存できる', async () => {
    const env = await setup();
    const res = await ST.executeSavePlan(env.client, planFor(env));
    eq(res.saved, true, '保存できた');
    ok(res.batchId, 'batch が作られる');
    eq(res.sessionIds.length, 2, 'session が2件');
    ok(res.metricCount > 0, 'metric も保存される');
    eq(env.client._db.aim_sessions.length, 2, 'DB 上も2件');
});

check('NOT NULL の列に必ず値が入る（版を渡さなくても）', async () => {
    const env = await setup();
    // registryVersion を渡さない経路。実 E2E で NOT NULL 違反が出た形。
    const plan = ST.buildSavePlan({
        auth: { loggedIn: true, userId: A },
        consent: { profile_storage: true },
        consentId: env.consentId,
        sessions: env.sessions,
        existingSessions: [],
        confirmedDpi: env.dpi.confirmedDpi,
        registry: REGISTRY,
        derivedAccuracyOf: U.derivedAccuracy
    });
    ok(plan.batch.registry_version, 'registry_version が入る');
    ok(plan.batch.parser_version, 'parser_version が入る');
    ok(plan.batch.normalization_version, 'normalization_version が入る');
    ok(plan.batch.consent_id, 'consent_id が入る');

    const res = await ST.executeSavePlan(env.client, plan);
    eq(res.saved, true, '保存できる: ' + (res.message || ''));
    env.client._db.aim_sessions.forEach((r) => {
        ok(r.parser_version, 'session の parser_version が入る');
        ok(r.raw_content_hash, 'raw_content_hash が入る');
    });
});

check('元のCSVを保存しない', async () => {
    const env = await setup();
    const plan = planFor(env);
    eq(plan.rawRetention.storesOriginalFile, false, '原本を保存しない');
    await ST.executeSavePlan(env.client, plan);
    const row = env.client._db.aim_sessions[0];
    ok(row.raw_content_hash && row.raw_content_hash.length === 64, 'ハッシュは保存する');
    ok(!('raw_text' in row) && !('csv' in row) && !('content' in row), '本文の列が存在しない');
    ok(row.parser_version && row.source, '来歴は保存する');
});

check('DPI 未確定なら cm360 を保存しない', async () => {
    const env = await setup();
    const plan = planFor(env, { confirmedDpi: null });
    const res = await ST.executeSavePlan(env.client, plan);
    eq(res.saved, true, '保存自体はできる');
    env.client._db.aim_sessions.forEach((r) => {
        eq(r.cm360, null, 'cm360 を入れない');
        eq(r.dpi_confirmed, null, 'DPI も未確定のまま');
    });
});

check('DPI 確定後は cm360 を保存する', async () => {
    const env = await setup();
    await ST.executeSavePlan(env.client, planFor(env));
    const row = env.client._db.aim_sessions[0];
    eq(row.dpi_confirmed, 400, '確定した DPI');
    eq(row.cm360, 152, '実測で裏取りした換算値');
});

check('timezone を勝手に UTC にしない', async () => {
    const env = await setup();
    await ST.executeSavePlan(env.client, planFor(env));
    env.client._db.aim_sessions.forEach((r) => {
        eq(r.timezone_status, 'unknown', '不明のまま');
        eq(r.observed_at_utc, null, 'UTC を作らない');
        ok(r.observed_at_local, '壁時計の値は残す');
    });
});

check('Registry に無い metric と単位違いを保存しない', async () => {
    const env = await setup();
    const bad = JSON.parse(JSON.stringify(env.sessions.slice(0, 1)));
    bad[0].metrics.push({ metricKey: 'kovaak.not_registered', value: 1, unit: 'count' });
    bad[0].metrics.push({ metricKey: 'kovaak.accuracy', value: 46.2, unit: 'percent' });
    const plan = planFor(env, { sessions: bad });
    const res = await ST.executeSavePlan(env.client, plan);
    eq(res.saved, true, '他の metric は保存される');
    const reasons = res.skippedMetrics.map((x) => x.reason);
    ok(reasons.includes('not_registered'), '未登録は除外');
    ok(reasons.includes('unit_mismatch'), '単位違いは除外');
    ok(!env.client._db.aim_metrics.some((m) => m.metric_key === 'kovaak.not_registered'), 'DBにも入らない');
});

check('adaptive セッションも保存はする（除外は比較のときだけ）', async () => {
    const env = await setup('adaptive');
    const res = await ST.executeSavePlan(env.client, planFor(env));
    eq(res.saved, true, '保存できる');
    const varied = env.client._db.aim_sessions.filter((r) => r.difficulty_varied);
    eq(varied.length, 1, '適応型も行として残る');
    ok(varied[0].difficulty_varied_basis, '理由も残る');
});

// ======================================================= idempotency

check('同じファイルを同じ parser で入れ直しても増えない', async () => {
    const env = await setup();
    await ST.executeSavePlan(env.client, planFor(env));
    eq(env.client._db.aim_sessions.length, 2, '1回目');

    const existing = env.client._db.aim_sessions.slice();
    const plan2 = planFor(env, { existingSessions: existing });
    const res2 = await ST.executeSavePlan(env.client, plan2);
    eq(res2.saved, false, '新規なし');
    eq(res2.reason, 'nothing_new', '理由');
    eq(res2.skipped.length, 2, '2件とも取り込み済みとして扱う');
    eq(res2.skipped[0].reason, 'already_imported', '理由');
    eq(env.client._db.aim_sessions.length, 2, '増えていない');
});

check('parser を上げれば同じファイルを再解析できる', async () => {
    const env = await setup();
    await ST.executeSavePlan(env.client, planFor(env));
    const existing = env.client._db.aim_sessions.slice();

    const plan2 = planFor(env, { existingSessions: existing, parserVersion: '0.2.0-next' });
    eq(plan2.toInsert.length, 2, '再解析として取り込む');
    eq(plan2.reanalysis.length, 2, '再解析であることを記録する');
    ok(plan2.reanalysis[0].previousVersions.includes(ST.PARSER_VERSION), '前の版が分かる');

    const res2 = await ST.executeSavePlan(env.client, plan2);
    eq(res2.saved, true, '保存できる');
    eq(env.client._db.aim_sessions.length, 4, '世代が並存する');
});

check('DB 側の UNIQUE でも二重登録を止める', async () => {
    const env = await setup();
    await ST.executeSavePlan(env.client, planFor(env));
    const s = env.client._db.aim_sessions[0];
    const r = await env.client.from('aim_sessions').insert({
        user_id: A, batch_id: s.batch_id, source: s.source,
        raw_content_hash: s.raw_content_hash, parser_version: s.parser_version
    }).select().single();
    ok(r.error, '拒否される');
    ok(/すでに同じ parser 版で取り込み済み/.test(r.error.message), '理由が分かる');
});

check('logical_fingerprint は raw_content_hash と分離されている', async () => {
    const env = await setup();
    await ST.executeSavePlan(env.client, planFor(env));
    env.client._db.aim_sessions.forEach((r) => {
        ok('logical_fingerprint' in r, '列は存在する');
        ok(/^not_implemented/.test(r.logical_fingerprint_status), '未実装であることを明示');
    });
    // 同じ値を複数行へ付けられる（unique が無い）
    env.client._db.aim_sessions.forEach((r) => { r.logical_fingerprint = 'same-fp'; });
    eq(env.client._db.aim_sessions.filter((r) => r.logical_fingerprint === 'same-fp').length, 2,
        '同じ fingerprint を複数行に付けられる');
});

// ======================================================= 他人のデータ

check('他人のデータを読めない', async () => {
    const env = await setup();
    await ST.executeSavePlan(env.client, planFor(env));

    env.client.signInAs(B);
    const loaded = await ST.loadSessions(env.client, A);
    eq(loaded.sessions.length, 0, 'B からは A のデータが見えない');
    const own = await ST.loadSessions(env.client, B);
    eq(own.sessions.length, 0, 'B 自身のデータも無い');
});

check('他人の user_id で書き込めない', async () => {
    const env = await setup();
    env.client.signInAs(B);
    const r = await env.client.from('aim_sessions').insert({
        user_id: A, batch_id: 'x', source: 'kovaak',
        raw_content_hash: 'a'.repeat(64), parser_version: '1'
    }).select().single();
    ok(r.error, '拒否される');
    ok(/自分以外の user_id/.test(r.error.message), '理由が分かる');
});

check('未ログイン（anon）では読めも書けもしない', async () => {
    const env = await setup();
    await ST.executeSavePlan(env.client, planFor(env));

    env.client.signOut();
    const loaded = await ST.loadSessions(env.client, A);
    eq(loaded.sessions.length, 0, '読めない');
    const r = await env.client.from('user_consents')
        .insert({ user_id: A, purpose: 'profile_storage', consent_version: 'v1' }).select().single();
    ok(r.error, '書けない');
    ok(/認証が必要/.test(r.error.message), '理由が分かる');
});

check('Registry は誰でも読めるが誰も書けない', async () => {
    const env = await setup();
    env.client.signOut();
    const rows = await env.client.from('aim_metric_registry').select();
    ok(rows.data.length > 0, 'anon でも読める');

    env.client.signInAs(A);
    const w = await env.client.from('aim_metric_registry')
        .insert({ metric_key: 'evil', metric_version: '1', unit: 'count' }).select().single();
    ok(w.error, 'ログインしていても書けない');
});

// ======================================================= 読み戻し

check('保存したものを読み戻して Profile を作れる', async () => {
    const env = await setup();
    await ST.executeSavePlan(env.client, planFor(env));

    const loaded = await ST.loadSessions(env.client, A);
    eq(loaded.error, null, 'エラーなし');
    eq(loaded.sessions.length, 2, '2件戻る');

    const s = loaded.sessions[0];
    ok(s.metrics.length > 0, 'metric が戻る');
    eq(s.context.confirmedDpi, 400, '確定 DPI が戻る');
    eq(s.context.sensitivity.cm360, 152, '振り向きが戻る');
    eq(s.provenance.rawContentHash.length, 64, '来歴が戻る');

    const prof = P.buildAimProfile(loaded.sessions);
    eq(prof.inventory.sessionCount, 2, 'Profile を作れる');
    ok(prof.confidence.evidenceQuality.evidenceCount > 0, 'evidence も作れる');
});

check('読み戻したデータで UI のビューを作れる', async () => {
    const env = await setup();
    await ST.executeSavePlan(env.client, planFor(env));
    const loaded = await ST.loadSessions(env.client, A);

    const view = U.buildProfileView(P.buildAimProfile(loaded.sessions), loaded.sessions, null);
    eq(view.inventory.importedSessions, 2, '取り込み件数');
    ok(view.scoreTrend.points.length > 0, 'スコア推移も作れる');
});

check('武器別の metric も往復する', async () => {
    const env = await setup();
    await ST.executeSavePlan(env.client, planFor(env));
    const loaded = await ST.loadSessions(env.client, A);
    const withWeapon = loaded.sessions.filter((s) => s.weapons.length > 0);
    ok(withWeapon.length > 0, '武器別が戻る');
    ok(withWeapon[0].weapons[0].metrics.length > 0, '武器の metric が戻る');
});

// ======================================================= 削除 / Export

check('削除で測定データが消える', async () => {
    const env = await setup();
    await ST.executeSavePlan(env.client, planFor(env));
    ok(env.client._db.aim_metrics.length > 0, '削除前は metric がある');

    const res = await ST.deleteAll(env.client, A);
    eq(res.deleted, true, '削除できた');
    eq(env.client._db.aim_sessions.length, 0, 'session が消えた');
    eq(env.client._db.aim_metrics.length, 0, 'metric も消えた（cascade）');
    eq(env.client._db.aim_import_batches.length, 0, 'batch も消えた');
});

check('削除の範囲を偽って説明しない', async () => {
    const env = await setup();
    await ST.executeSavePlan(env.client, planFor(env));
    const res = await ST.deleteAll(env.client, A);
    ok(/インフラ側の運用ログやセキュリティログまで同時に消えるわけではありません/.test(res.note),
        'インフラ側のログまで消えるとは言わない');
    ok(res.scope.includes('aim_sessions'), '消える範囲を明示');
    ok(res.kept.includes('user_consents'), '残るものも明示');
});

check('他人のデータは削除できない', async () => {
    const env = await setup();
    await ST.executeSavePlan(env.client, planFor(env));
    env.client.signInAs(B);
    await ST.deleteAll(env.client, A);
    eq(env.client._db.aim_sessions.length, 2, 'A のデータは残る');
});

check('アカウント削除で個人データが完全に消える', async () => {
    const env = await setup();
    await ST.executeSavePlan(env.client, planFor(env));
    env.client.deleteAccount(A);
    const left = env.client._db.user_consents.length + env.client._db.aim_import_batches.length
        + env.client._db.aim_sessions.length + env.client._db.aim_metrics.length;
    eq(left, 0, '個人データが0件');
    ok(env.client._db.aim_metric_registry.length > 0, 'Registry は残る（個人データではない）');
});

check('Export は版付きの可搬形式である', async () => {
    const env = await setup();
    await ST.executeSavePlan(env.client, planFor(env));
    const loaded = await ST.loadSessions(env.client, A);
    const ex = ST.buildExport(loaded.sessions, { source: 'stored', registry: REGISTRY, registryVersion: '1.5.0' });

    eq(ex.format, 'long-cape-aim-export', '形式名');
    ok(ex.export_version, '版がある');
    ok(ex.exported_at, '出力時刻がある');
    ok(ex.generator.parser_version && ex.generator.normalization_version, '解釈の版がある');
    eq(ex.contents.includes_raw_files, false, '原本を含まない');
    eq(ex.contents.includes_account_identifiers, false, 'アカウント識別子を含まない');

    const s0 = ex.sessions[0];
    ok(s0.scenario && 'identity' in s0.scenario, 'シナリオ識別子');
    ok(s0.observed_at.timezone_status, 'timezone の状態を明示');
    ok(s0.provenance.raw_content_hash && s0.provenance.parser_version, '来歴');
    ok(s0.metrics.length > 0, 'metric がある');
    s0.metrics.forEach((m) => {
        ok(m.metric_key, 'metric key');
        ok(m.metric_version, 'metric version');
        ok(m.unit !== undefined, 'unit');
        ok(typeof m.value === 'number', 'value');
    });
});

check('Export に内部IDや認証情報を含めない', async () => {
    const env = await setup();
    await ST.executeSavePlan(env.client, planFor(env));
    const loaded = await ST.loadSessions(env.client, A);
    const ex = ST.buildExport(loaded.sessions, { source: 'stored', registry: REGISTRY });

    const audit = ST.auditExport(ex);
    eq(audit.clean, true, '禁止キーが無い: ' + audit.offendingKeys.join(', '));
    const text = JSON.stringify(ex);
    ok(!text.includes(A), 'user_id が入っていない');
    ST.EXPORT_FORBIDDEN_KEYS.forEach((k) => {
        ok(!new RegExp('\"' + k + '\"s*:').test(text), k + ' が入っていない');
    });
});

check('Export に元CSVを含めない', async () => {
    const env = await setup();
    await ST.executeSavePlan(env.client, planFor(env));
    const loaded = await ST.loadSessions(env.client, A);
    const ex = ST.buildExport(loaded.sessions, { source: 'stored', registry: REGISTRY, registryVersion: '1.5.0' });

    eq(ex.session_count, 2, '件数');
    ok(/元のCSVは含まれません/.test(ex.contents.note), '含まれないことを明示');
    ok(!JSON.stringify(ex).includes('Kill #'), 'CSV 本文が入っていない');
    ok(ex.generator.parser_version && ex.generator.registry_version, '来歴が入っている');
});

check('Export はログインしていなくても作れる', async () => {
    const r = await runImport('normal');
    const ex = ST.buildExport(r.sessions, {});
    eq(ex.session_count, 2, '手元のデータでも Export できる');
});

// ======================================================= 実行

for (const { name, fn } of pending) {
    try { await fn(); passed++; }
    catch (e) { failures.push({ name, message: e.message }); }
}

const total = passed + failures.length;
if (failures.length === 0) {
    console.log(`✅ Storage テスト成功: ${passed}/${total} 件`);
    process.exit(0);
}
console.error(`❌ Storage テスト失敗: ${failures.length}/${total} 件`);
for (const f of failures) console.error(`   - ${f.name}\n     ${f.message}`);
process.exit(1);
