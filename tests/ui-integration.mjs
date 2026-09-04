// G-5 の UI 統合テスト。
//
//   node tests/ui-integration.mjs
//
// 「CSV を取り込む → DPI を確認する → 同意する → 保存する → 読み戻す →
//   再取り込みする → 削除する」までを、画面が呼ぶのと同じ順序で通す。
//
// 本番DB・ネットワークには触れない。DB は tests/lib/fake-supabase.mjs が
// 本番へ適用した migration と同じ規則で代替する。

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
const U = ctx.LC_UI, ST = ctx.LC_STORAGE, K = ctx.LC_IMPORTERS.kovaak,
    P = ctx.LC_PROFILE, R = ctx.LC_REESTIMATE, S = ctx.LC_SAMPLES, M = ctx.LC_METRICS;

const REGISTRY = {};
M.all.forEach((m) => { REGISTRY[m.metric_key] = { unit: m.unit, metric_version: m.metric_version }; });

let passed = 0;
const failures = [];
const pending = [];
const check = (name, fn) => pending.push({ name, fn });
function eq(a, b, l) {
    const x = JSON.stringify(a), y = JSON.stringify(b);
    if (x !== y) throw new Error(`${l || ''} 期待 ${y} / 実際 ${x}`);
}
function ok(c, l) { if (!c) throw new Error(l || '条件を満たしません'); }

/**
 * 画面の状態を模した操作オブジェクト。profile.html / import.html が呼ぶのと
 * 同じ関数を、同じ順序で呼ぶ。
 */
function makeApp(userId) {
    const client = createFakeSupabase({ registry: REGISTRY });
    const app = {
        client,
        user: null,
        consent: U.defaultConsent(),
        consentRows: {},
        sessions: [],        // 取り込んだもの（ローカル）
        stored: [],          // 保存済みを読み戻したもの
        dpiAnswer: {},

        async importFiles(kind) {
            const r = await K.run(S.files(kind), { importedAt: '2026-09-05T00:00:00.000Z' });
            app.sessions = r.sessions;
            app.run = r;
            return r;
        },
        dpi() { return U.resolveDpi(app.sessions, app.dpiAnswer); },
        confirmDpi(answer, value) { app.dpiAnswer = { answer, value }; return app.dpi(); },

        login(id) { app.user = { id }; client.signInAs(id); },
        logout() { app.user = null; client.signOut(); app.consentRows = {}; app.consent = U.defaultConsent(); },

        async grant(purpose) {
            const g = await ST.grantConsent(client, app.user.id, purpose, 'v1');
            app.consent[purpose] = true;
            await app.syncConsents();
            return g;
        },
        async revoke(purpose) {
            await ST.revokeConsent(client, app.user.id, purpose);
            app.consent[purpose] = false;
            await app.syncConsents();
        },
        async syncConsents() {
            if (!app.user) { app.consentRows = {}; return; }
            const r = await ST.loadConsents(client, app.user.id);
            app.consentRows = r.active || {};
            U.CONSENT_PURPOSES.forEach((p) => { app.consent[p.id] = !!app.consentRows[p.id]; });
        },

        async save(parserVersion) {
            const dpi = app.dpi();
            const consentRow = app.consentRows[ST.CONSENT.REQUIRED_FOR_STORAGE];
            const existing = await ST.loadSessions(client, app.user ? app.user.id : 'nobody');
            const plan = ST.buildSavePlan({
                auth: { loggedIn: !!app.user, userId: app.user && app.user.id },
                consent: app.consent,
                consentId: consentRow ? consentRow.id : null,
                sessions: app.sessions,
                existingSessions: (existing.sessions || []).map((s) => ({
                    id: s.storedId, source: s.provenance.source,
                    raw_content_hash: s.provenance.rawContentHash,
                    parser_version: s.provenance.parserVersion
                })),
                confirmedDpi: dpi.confirmedDpi,
                dpiSource: dpi.confirmedBy,
                registry: REGISTRY,
                parserVersion: parserVersion || ST.PARSER_VERSION,
                filesReceived: app.sessions.length,
                derivedAccuracyOf: U.derivedAccuracy,
                cm360Of: (s, d) => {
                    const c = U.cm360(s.context.sensScale, s.context.inGameSens, d);
                    return c.available ? c.value : null;
                }
            });
            return ST.executeSavePlan(client, plan);
        },

        async reload() {
            const r = await ST.loadSessions(client, app.user ? app.user.id : 'nobody');
            app.stored = r.sessions || [];
            return app.stored;
        },
        async deleteAll() { return ST.deleteAll(client, app.user.id); },

        profileView(which) {
            const s = which === 'stored' ? app.stored : app.sessions;
            let reest = null;
            try {
                reest = R.reestimate({
                    sessions: s, evidence: P.buildEvidence(s),
                    levelResolver: P.verifiedSensitivityLevel, now: '2026-09-05T00:00:00'
                });
            } catch (e) { reest = null; }
            return U.buildProfileView(P.buildAimProfile(s), s, reest);
        }
    };
    return app;
}

// ================================================= ログイン前のひととおり

check('ログイン前でも 取り込み→DPI確認→Profile まで通る', async () => {
    const app = makeApp();
    await app.importFiles('normal');
    eq(app.sessions.length, 2, '取り込める');

    const before = U.buildImportView(app.run, app.dpi());
    eq(before.rows[0].cm360Blocked, true, '未確認では cm/360 を出さない');

    app.confirmDpi(U.DPI_ANSWER.AS_IS);
    const after = U.buildImportView(app.run, app.dpi());
    eq(after.rows[0].cm360, 152, '確認すると出る');

    const view = app.profileView();
    eq(view.inventory.importedSessions, 2, 'Profile も作れる');

    // 保存だけができない
    const gate = ST.canPersist({ loggedIn: false }, app.consent);
    eq(gate.allowed, false, '保存はできない');
    eq(app.client._db.aim_sessions.length, 0, 'DB には何も書かれていない');
});

// ================================================= ログイン後のひととおり

check('ログイン→同意→保存→読み戻し が通る', async () => {
    const app = makeApp();
    await app.importFiles('normal');
    app.confirmDpi(U.DPI_ANSWER.AS_IS);
    app.login('u1');

    // 同意する前は保存できない
    let res = await app.save();
    eq(res.saved, false, '同意前は保存しない');
    eq(res.reason, 'consent_missing', '理由');

    await app.grant('profile_storage');
    res = await app.save();
    eq(res.saved, true, '同意後は保存できる');
    eq(res.sessionIds.length, 2, '2件');

    const stored = await app.reload();
    eq(stored.length, 2, '読み戻せる');
    eq(stored[0].context.sensitivity.cm360, 152, '振り向きも戻る');

    const view = app.profileView('stored');
    eq(view.inventory.importedSessions, 2, '保存済みから Profile を作れる');
});

check('profile_storage だけで保存でき、他の同意は要らない', async () => {
    const app = makeApp();
    await app.importFiles('normal');
    app.confirmDpi(U.DPI_ANSWER.AS_IS);
    app.login('u2');
    await app.grant('profile_storage');

    eq(app.consent.anonymized_statistics, false, '統計には同意していない');
    eq(app.consent.model_improvement, false, '学習にも同意していない');

    const res = await app.save();
    eq(res.saved, true, 'それでも保存できる');
    eq(app.client._db.user_consents.length, 1, '同意行は1つだけ');
});

check('同意を取り消すと以降の保存ができなくなる', async () => {
    const app = makeApp();
    await app.importFiles('normal');
    app.confirmDpi(U.DPI_ANSWER.AS_IS);
    app.login('u3');
    await app.grant('profile_storage');
    await app.save();

    await app.revoke('profile_storage');
    const gate = ST.canPersist({ loggedIn: true, userId: 'u3' }, app.consent);
    eq(gate.allowed, false, '保存できなくなる');

    // すでに保存したものは残る（取り消し＝過去の削除ではない）
    const stored = await app.reload();
    eq(stored.length, 2, '保存済みは残る');
});

check('同意の取り消しと再同意の履歴が残る', async () => {
    const app = makeApp();
    app.login('u4');
    await app.grant('profile_storage');
    await app.revoke('profile_storage');
    await app.grant('profile_storage');

    const rows = app.client._db.user_consents.filter((c) => c.user_id === 'u4');
    eq(rows.length, 2, '付与2回ぶんの行が残る');
    eq(rows.filter((c) => c.revoked_at === null).length, 1, '有効なのは1つだけ');
    ok(rows.some((c) => c.revoked_at !== null), '取り消した履歴も残る');
});

// ================================================= 再取り込み

check('同じファイルを入れ直しても増えない', async () => {
    const app = makeApp();
    await app.importFiles('normal');
    app.confirmDpi(U.DPI_ANSWER.AS_IS);
    app.login('u5');
    await app.grant('profile_storage');

    await app.save();
    const res2 = await app.save();
    eq(res2.saved, false, '2回目は保存しない');
    eq(res2.reason, 'nothing_new', '理由');
    eq((await app.reload()).length, 2, '件数が増えない');
});

check('parser を上げた再取り込みは別の世代として保存できる', async () => {
    const app = makeApp();
    await app.importFiles('normal');
    app.confirmDpi(U.DPI_ANSWER.AS_IS);
    app.login('u6');
    await app.grant('profile_storage');

    await app.save();
    const res2 = await app.save('9.9.9-newparser');
    eq(res2.saved, true, '再解析として保存できる');
    eq(res2.reanalysis.length, 2, '再解析であることを記録');
    eq((await app.reload()).length, 4, '世代が並存する');

    const versions = [...new Set(app.stored.map((s) => s.provenance.parserVersion))].sort();
    eq(versions.length, 2, '2つの parser 版が残る');
});

// ================================================= 他人のデータ

check('別のユーザーからは見えない', async () => {
    const app = makeApp();
    await app.importFiles('normal');
    app.confirmDpi(U.DPI_ANSWER.AS_IS);
    app.login('u7');
    await app.grant('profile_storage');
    await app.save();
    eq((await app.reload()).length, 2, '本人は見える');

    app.login('u8');
    await app.syncConsents();
    eq(Object.keys(app.consentRows).length, 0, '他人の同意も見えない');
    eq((await app.reload()).length, 0, '他人のデータは見えない');
});

check('ログアウトすると保存済みが見えなくなる', async () => {
    const app = makeApp();
    await app.importFiles('normal');
    app.confirmDpi(U.DPI_ANSWER.AS_IS);
    app.login('u9');
    await app.grant('profile_storage');
    await app.save();

    app.logout();
    eq((await app.reload()).length, 0, '見えない');
    // ただしローカルの取り込みは残っていて、Profile は作れる
    eq(app.profileView().inventory.importedSessions, 2, 'ローカル preview は使える');
});

// ================================================= 削除 / Export

check('削除してから読み戻すと0件になる', async () => {
    const app = makeApp();
    await app.importFiles('normal');
    app.confirmDpi(U.DPI_ANSWER.AS_IS);
    app.login('u10');
    await app.grant('profile_storage');
    await app.save();
    eq((await app.reload()).length, 2, '保存されている');

    const r = await app.deleteAll();
    eq(r.deleted, true, '削除できた');
    eq((await app.reload()).length, 0, '0件になる');
    eq(app.client._db.aim_metrics.length, 0, 'metric も消えている');
});

check('削除後も同意は残り、再び保存できる', async () => {
    const app = makeApp();
    await app.importFiles('normal');
    app.confirmDpi(U.DPI_ANSWER.AS_IS);
    app.login('u11');
    await app.grant('profile_storage');
    await app.save();
    await app.deleteAll();

    await app.syncConsents();
    ok(app.consentRows.profile_storage, '同意は残る');
    const res = await app.save();
    eq(res.saved, true, '再び保存できる');
});

check('Export はログイン前後どちらでも作れて、元CSVを含まない', async () => {
    const app = makeApp();
    await app.importFiles('normal');
    app.confirmDpi(U.DPI_ANSWER.AS_IS);

    const before = ST.buildExport(app.sessions, { source: 'local' });
    eq(before.session_count, 2, 'ログイン前でも作れる');

    app.login('u12');
    await app.grant('profile_storage');
    await app.save();
    await app.reload();
    const after = ST.buildExport(app.stored, { source: 'stored' });
    eq(after.session_count, 2, 'ログイン後も作れる');

    [before, after].forEach((ex) => {
        ok(!JSON.stringify(ex).includes('Kill #'), 'CSV 本文が入っていない');
        ok(/元のCSVは含まれません/.test(ex.contents.note), '含まれないことを明示');
    });
});

// ================================================= adaptive と推奨

check('保存して読み戻しても adaptive は比較から外れる', async () => {
    const app = makeApp();
    await app.importFiles('adaptive');
    app.confirmDpi(U.DPI_ANSWER.AS_IS);
    app.login('u13');
    await app.grant('profile_storage');
    await app.save();
    await app.reload();

    const varied = app.stored.filter((s) => s.context.difficultyVaried);
    eq(varied.length, 1, '適応型も保存されている');
    ok(varied[0].context.difficultyVariedBasis, '理由も残っている');

    const view = app.profileView('stored');
    eq(view.excludedSessions.length, 1, '比較からは外れている');
});

check('保存済みでも DPI 未確定なら推奨を出さない', async () => {
    const app = makeApp();
    await app.importFiles('normal');
    app.confirmDpi(U.DPI_ANSWER.DEFER);          // 確認しない
    app.login('u14');
    await app.grant('profile_storage');
    await app.save();
    await app.reload();

    app.stored.forEach((s) => {
        eq(s.context.confirmedDpi, null, 'DPI は未確定のまま保存されている');
        ok(!s.context.sensitivity, '振り向きも入っていない');
    });

    const rec = U.buildRecommendationView(null, app.dpi(), {});
    eq(rec.status, 'withheld', '推奨は出さない');
    eq(rec.reasonCode, 'dpi_unconfirmed', '理由は DPI');
});

// ================================================= 実行

for (const { name, fn } of pending) {
    try { await fn(); passed++; }
    catch (e) { failures.push({ name, message: e.message }); }
}

const total = passed + failures.length;
if (failures.length === 0) {
    console.log(`✅ UI 統合テスト成功: ${passed}/${total} 件`);
    process.exit(0);
}
console.error(`❌ UI 統合テスト失敗: ${failures.length}/${total} 件`);
for (const f of failures) console.error(`   - ${f.name}\n     ${f.message}`);
process.exit(1);
