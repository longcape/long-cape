// G-3 の UI ロジックのテスト。
//
//   node tests/ui.mjs
//
// 画面（HTML）ではなく ui/ui-logic.js の判断を検証する。
// ロジックを HTML から切り離しているのは、ここをテストできるようにするため。
//
// 本番DB・ネットワーク・本番サイトには一切触れない。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ------------------------------------------------------------ 読み込み

function load() {
    const ctx = {
        console, Math, JSON, Date, Number, String, Boolean, Array, Object, isFinite, isNaN,
        Promise, Uint8Array, ArrayBuffer, TextEncoder, crypto, Error, Blob: undefined
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of ['importers/kovaak.js', 'profile/metric-registry.js', 'profile/algorithm-config.js',
        'profile/aim-profile.js', 'profile/re-estimation.js', 'ui/ui-logic.js', 'ui/samples.js']) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    }
    return ctx;
}

const ctx = load();
const U = ctx.LC_UI, K = ctx.LC_IMPORTERS.kovaak, P = ctx.LC_PROFILE,
    R = ctx.LC_REESTIMATE, S = ctx.LC_SAMPLES, M = ctx.LC_METRICS;

// ------------------------------------------------------------ テスト基盤

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

const engine = (sessions) => R.reestimate({
    sessions, evidence: P.buildEvidence(sessions),
    levelResolver: P.verifiedSensitivityLevel, now: '2026-09-05T00:00:00'
});

// =================================================== 1. DPI ゲート（必須）

check('DPI未確認では cm/360 を確定表示しない', async () => {
    const r = await runImport('normal');
    const dpi = U.resolveDpi(r.sessions, {});          // 未回答
    eq(dpi.status, U.DATA_STATE.NEEDS_CHECK, '要確認である');
    eq(dpi.confirmedDpi, null, '確定値を持たない');
    eq(dpi.blocked, ['cm360', 'sensitivity_level', 'recommendation'], '3つを止める');

    const view = U.buildImportView(r, dpi);
    ok(view.rows.length > 0, '行が生成される');
    view.rows.forEach((row) => {
        eq(row.cm360, null, 'cm/360 の値を出さない');
        eq(row.cm360Blocked, true, '止めている理由が付く');
    });
});

check('「今は確認しない」でもスコアは見えるが cm/360 と推奨は止まる', async () => {
    const r = await runImport('normal');
    const dpi = U.resolveDpi(r.sessions, { answer: U.DPI_ANSWER.DEFER });
    eq(dpi.status, U.DATA_STATE.NEEDS_CHECK, '確定しない');
    ok(U.isBlockedByDpi(dpi, 'cm360'), 'cm/360 は止まる');
    ok(U.isBlockedByDpi(dpi, 'recommendation'), '推奨も止まる');

    const view = U.buildImportView(r, dpi);
    ok(view.rows.every((x) => x.score !== null), 'スコアは見られる');
    ok(view.rows.every((x) => x.state !== U.DATA_STATE.UNSUPPORTED), '解析自体はできている');
});

check('DPIを確認すればゲートが外れる', async () => {
    const r = await runImport('normal');
    const asIs = U.resolveDpi(r.sessions, { answer: U.DPI_ANSWER.AS_IS });
    eq(asIs.status, U.DATA_STATE.CONFIRMED, 'ファイル値で確定できる');
    eq(asIs.blocked, [], '止めるものが無くなる');

    const over = U.resolveDpi(r.sessions, { answer: U.DPI_ANSWER.OVERRIDE, value: 800 });
    eq(over.confirmedDpi, 800, '入力値で確定する');
    ok(over.mismatch && over.mismatch.fileValue === 400, 'ファイル値との食い違いを記録する');
});

check('DPI未確認なら推奨を出さず、何をすればよいかを返す', async () => {
    const sessions = S.enough();
    const dpi = U.resolveDpi([], {});                   // 未確認
    const rec = U.buildRecommendationView(engine(sessions), dpi, {});
    eq(rec.status, 'withheld', '推奨を出さない');
    eq(rec.reasonCode, 'dpi_unconfirmed', '理由がDPIである');
    eq(rec.recommended_cm360, null, '値を作らない');
    ok(rec.whatToDo.length > 0, '次にすべきことを返す');
    eq(rec.whatToDo[0].action, 'confirm_dpi', 'DPI確認を促す');
});

check('DPI確認後は cm/360 を出すが、換算が未確認のスケールでは出さない', async () => {
    const r = await runImport('normal');
    const dpi = U.resolveDpi(r.sessions, { answer: U.DPI_ANSWER.AS_IS });
    const view = U.buildImportView(r, dpi);

    view.rows.forEach((row) => {
        eq(row.cm360Blocked, false, 'DPI確認後は止めない');
        ok(typeof row.cm360 === 'number', 'Valorant スケールなら値が出る');
    });
    // 実測で裏取りした値と一致する（0.215 / DPI 400 → 152cm）
    eq(view.rows[0].cm360, 152, '検証済みの換算と一致する');

    // 換算定数が未確認のスケールは計算しない
    const unknown = U.cm360('Overwatch', 5, 800);
    eq(unknown.available, false, '未検証のスケールは計算しない');
    eq(unknown.reason, 'scale_not_verified', '理由が付く');
    ok(!('value' in unknown), '推測値を作らない');
});

check('DPIを確認すると「要確認」が解消して「確認済み」になる', async () => {
    const r = await runImport('normal');

    const before = U.buildImportView(r, U.resolveDpi(r.sessions, {}));
    before.rows.forEach((x) => eq(x.state, U.DATA_STATE.NEEDS_CHECK, '確認前は要確認'));

    const after = U.buildImportView(r, U.resolveDpi(r.sessions, { answer: U.DPI_ANSWER.AS_IS }));
    after.rows.forEach((x) => {
        eq(x.state, U.DATA_STATE.CONFIRMED, '確認後は確認済み');
        eq(x.unresolved.length, 0, 'DPI由来の未確定項目が消える');
    });
    eq(after.stateCounts.confirmed, after.rows.length, '件数にも反映される');
});

check('換算定義は必要な情報が揃っていないと使えない', async () => {
    const a = U.auditSensScales();
    ok(a.ok, '定義の不備: ' + a.problems.join(' / '));

    // 必須項目が全部そろっている
    Object.keys(U.SENS_SCALE).forEach((k) => {
        U.SCALE_REQUIRED.forEach((f) => {
            ok(U.SENS_SCALE[k][f] !== undefined, k + '.' + f + ' がある');
        });
        ok(U.SENS_SCALE[k].testVectors.length >= 2, k + ' に既知の検証値が2点以上');
    });
});

check('換算の往復が一致する', async () => {
    Object.keys(U.SENS_SCALE).forEach((k) => {
        U.SENS_SCALE[k].testVectors.forEach((v) => {
            const cm = U.cm360(k, v.sens, v.dpi);
            eq(cm.available, true, k + ' の換算ができる');
            ok(Math.abs(cm.value - v.cm360) < 0.15, k + ': ' + cm.value + ' ≒ ' + v.cm360);
            const back = U.sensFromCm360(k, cm.value, v.dpi);
            ok(Math.abs(back.value - v.sens) / v.sens < 0.005, k + ': 往復で戻る');
        });
    });
});

check('表記ゆれを吸収するが、未登録のスケールは推測しない', async () => {
    eq(U.cm360('Valorant', 0.4, 800).value, U.cm360('cs2', 0.4, 800).value, '別名でも同じ');
    ['Apex', 'Overwatch', 'Fortnite', 'PUBG', ''].forEach((name) => {
        const r = U.cm360(name, 3, 800);
        eq(r.available, false, name + ' は換算しない');
        ok(!('value' in r), name + ' の推測値を作らない');
    });
});

// ============================================ 2. adaptive を推奨へ混ぜない

check('adaptive セッションが推奨へ混ざらない', async () => {
    const clean = engine(S.enough());
    const mixed = engine(S.withAdaptive());

    eq(mixed.recommended_cm360, clean.recommended_cm360, '適応型の極端な値に動かされない');
    ok(mixed.evidence_excluded.difficulty_varied > 0, '除外件数が記録される');
});

check('adaptive は消したように見せず、理由を添えて残す', async () => {
    const sessions = S.withAdaptive();
    const ex = U.buildExcludedView(sessions);
    ok(ex.length > 0, '除外されたセッションが見える');
    ex.forEach((x) => {
        eq(x.kept, true, 'データは残っている');
        ok(/難易度がセッション中に変化/.test(x.reason), '理由が書かれている');
        ok(x.excludedFrom.indexOf('recommendation') >= 0, '何から外したかが分かる');
    });

    const view = U.buildProfileView(P.buildAimProfile(sessions), sessions, engine(sessions));
    ok(view.excludedSessions.length > 0, 'Profile 画面にも出る');
});

check('取り込み画面で adaptive は「分析対象外」として表示される', async () => {
    const r = await runImport('adaptive');
    const view = U.buildImportView(r, U.resolveDpi(r.sessions, { answer: U.DPI_ANSWER.AS_IS }));
    const ad = view.rows.filter((x) => x.adaptive);
    ok(ad.length > 0, '適応型の行がある');
    ad.forEach((x) => {
        eq(x.state, U.DATA_STATE.EXCLUDED, '分析対象外として出る');
        ok(x.adaptiveBasis, '構造的な根拠が付く');
        ok(!/adapt/i.test(String(x.adaptiveBasis)), 'シナリオ名ではなく構造値が根拠');
    });
    eq(view.stateCounts.excluded, ad.length, '件数として集計される');
});

// ================================================ 3. hold metric を入れない

check('recommendation_hold の metric は推奨へ入らない', async () => {
    for (const key of ['kovaak.kills', 'kovaak.accuracy']) {
        eq(M.resolveReliability(key).status, 'rated', `${key} は rated`);
        eq(M.isRecommendationEligible(key), false, `${key} は推奨に使わない`);
        eq(M.recommendationWeight(key), 0, `${key} の重みは0`);
    }
    // 画面の内訳でも hold と分かる
    const r = await runImport('normal');
    const d = U.devInspect(r.sessions, P.buildEvidence(r.sessions));
    const kills = d.metrics.filter((m) => m.metricKey === 'kovaak.kills')[0];
    ok(kills, 'kills が内訳に出る');
    eq(kills.recommendationHold, true, 'hold と表示できる');
    eq(kills.recommendationEligible, false, 'eligible ではない');
});

check('内部の内訳は metric ごとの収集方法で評価する（決め打ちしない）', async () => {
    const sessions = S.enough();                    // manual 由来
    const d = U.devInspect(sessions, P.buildEvidence(sessions));
    const bench = d.metrics.filter((m) => m.metricKey === 'manual.benchmark_score')[0];
    ok(bench, 'manual の metric が内訳に出る');
    eq(bench.collectionMethod, 'screen_transcribed', '実際の収集方法で解決する');
    eq(bench.ratingStatus, 'rated', '別 source の metric を誤って未評価にしない');
    eq(bench.recommendationEligible, true, 'eligible が正しく出る');
});

// ============================== 4. unsupported を推測解析しない

check('未対応ファイルを推測で解析しない', async () => {
    const r = await runImport('broken');
    const view = U.buildImportView(r, U.resolveDpi(r.sessions, {}));

    const unsupported = view.rejected.filter((x) => x.state === U.DATA_STATE.UNSUPPORTED);
    ok(unsupported.length > 0, '未対応として扱われる');
    unsupported.forEach((x) => {
        eq(x.parsed, false, '解析していない');
        ok(/推測して読み込むことはしません/.test(x.note), '推測しない旨が出る');
    });
    // 未対応ファイルからセッションが作られていない
    ok(view.rows.length < 3, '未対応ぶんは行にならない');
    ok(view.rows.every((x) => x.scenario !== 'my-notes'), '関係ないファイルから行を作らない');
});

// ================================ 5. unrated metric を重み付けしない

check('unrated metric は重み0で推奨に効かない', async () => {
    eq(M.resolveReliability('kovaak.avg_ttk').status, 'unrated', 'avg_ttk は未評価');
    eq(M.recommendationWeight('kovaak.avg_ttk'), 0, '重みは0');

    const base = S.enough();
    const poisoned = base.concat(base.slice(0, 3).map((s, i) => ({
        ...s, externalId: 'poison-' + i,
        metrics: [{ metricKey: 'kovaak.avg_ttk', value: 9999999, unit: 's' }]
    })));
    eq(engine(poisoned).recommended_cm360, engine(base).recommended_cm360, '推奨が動かない');
});

check('使用禁止の metric は画面の内訳でも禁止と分かる', async () => {
    const r = await runImport('normal');
    const d = U.devInspect(r.sessions, P.buildEvidence(r.sessions));
    const ttk = d.metrics.filter((m) => m.metricKey === 'kovaak.avg_ttk')[0];
    ok(ttk, 'avg_ttk が内訳に出る');
    eq(ttk.ratingStatus, 'unrated', '未評価と表示される');
    ok(ttk.usageProhibition, '使用禁止が付いている');
    eq(ttk.usageProhibition.recommendation, 'prohibited', '推奨で使用禁止');
    eq(ttk.usageProhibition.derived_calculation, 'prohibited', 'Derived 計算でも使用禁止');
});

// ============================ 6. ログインなしでも local preview

check('ログインしなくても取り込みとプロフィール確認ができる', async () => {
    const cap = U.loginCapabilities(false);
    eq(cap.loggedIn, false, '未ログイン');
    eq(cap.canImportCsv, true, 'CSVを取り込める');
    eq(cap.canPreviewLocally, true, 'ローカルで確認できる');
    eq(cap.canPreviewProfile, true, 'プロフィールも見られる');
    eq(cap.canSave, false, '保存だけができない');

    // 実際に未ログイン想定で一連が通る
    const r = await runImport('normal');
    const view = U.buildImportView(r, U.resolveDpi(r.sessions, { answer: U.DPI_ANSWER.AS_IS }));
    ok(view.rows.length > 0, '未ログインでも中身が見える');
    const prof = U.buildProfileView(P.buildAimProfile(r.sessions), r.sessions, null);
    ok(prof.inventory.importedSessions > 0, '未ログインでも Profile が作れる');
});

check('削除とExportは常に使える（有料機能にしない）', async () => {
    [true, false].forEach((loggedIn) => {
        const cap = U.loginCapabilities(loggedIn);
        eq(cap.canDeleteData, true, '削除は常に可能');
        eq(cap.canExportData, true, 'Export は常に可能');
        eq(cap.dataRightsArePaid, false, '有料機能にしない');
    });
});

// ============================ 7. consent なしで外部送信しない

check('同意が無ければ外部送信しない', async () => {
    const none = U.defaultConsent();
    U.CONSENT_PURPOSES.forEach((p) => {
        eq(none[p.id], false, `${p.id} の初期値はオフ`);
        eq(U.canSendExternally(none, p.id), false, `${p.id} は同意なしで送らない`);
    });
    eq(U.canSendExternally(none, 'unknown_purpose'), false, '未知の用途も送らない');
    eq(U.canSendExternally(null, 'profile_storage'), false, '同意オブジェクトが無ければ送らない');
});

check('同意は用途ごとに独立している', async () => {
    eq(U.CONSENT_PURPOSES.length, 3, '3つの用途に分かれている');
    const c = U.defaultConsent();
    c.anonymized_statistics = true;
    eq(U.canSendExternally(c, 'anonymized_statistics'), true, '同意した用途だけ通る');
    eq(U.canSendExternally(c, 'profile_storage'), false, '別の用途は通らない');
    eq(U.canSendExternally(c, 'model_improvement'), false, '別の用途は通らない');
    U.CONSENT_PURPOSES.forEach((p) => eq(p.required, false, `${p.id} は必須ではない`));
});

check('同意の名前が DB の CHECK と一致している', async () => {
    // 名前がずれていると、同意を記録した瞬間に DB の CHECK で弾かれる。
    const DB_PURPOSES = ['profile_storage', 'anonymized_statistics', 'model_improvement'];
    eq(U.CONSENT_PURPOSES.map((p) => p.id).sort(), DB_PURPOSES.slice().sort(), 'UI と DB で一致');
    eq(Object.keys(U.defaultConsent()).sort(), DB_PURPOSES.slice().sort(), '既定値の鍵も一致');
});

check('ローカルプレビューに同意は要らない', async () => {
    const a = U.localPreviewAllowed();
    eq(a.allowed, true, '使える');
    eq(a.requiresConsent, false, '同意不要');
    eq(a.requiresLogin, false, 'ログイン不要');
});

check('取り込みはサーバーへ送っていないことを明示する', async () => {
    const r = await runImport('normal');
    const view = U.buildImportView(r, U.resolveDpi(r.sessions, {}));
    eq(view.transport.sentToServer, false, '送信していない');
    ok(/この端末の中だけ/.test(view.transport.note), '説明がある');
});

// ==================================== 表示まわりの取り違え防止

check('Profile completeness と Recommendation confidence を統合しない', async () => {
    const sessions = S.enough();
    const view = U.buildProfileView(P.buildAimProfile(sessions), sessions, engine(sessions));
    const ids = view.meters.map((m) => m.id);
    eq(ids, ['profile_completeness', 'evidence_quality', 'recommendation_confidence'],
        '3つが別々のメーターとして存在する');
    ok(view.separationNote, '別物である説明が付く');
    // 同じ値を使い回していない
    const vals = view.meters.map((m) => m.value);
    ok(new Set(vals.filter((v) => v !== null)).size > 1, '同じ数字を3箇所に出していない');
});

check('推奨が出せないときは confidence を計算しない', async () => {
    const sessions = S.notEnough();
    const view = U.buildProfileView(P.buildAimProfile(sessions), sessions, engine(sessions));
    const rc = view.meters.filter((m) => m.id === 'recommendation_confidence')[0];
    eq(rc.unavailable, true, '出せないことを明示する');
    eq(rc.value, null, '値を作らない');
});

check('「スコアが高い＝最適」と誤解させない説明を持つ', async () => {
    const rec = U.buildRecommendationView(engine(S.enough()),
        { status: 'confirmed', blocked: [] }, {});
    eq(rec.status, 'available', '推奨が出る');
    ok(/そのまま選んでいるわけではありません/.test(rec.composition.headline), '誤解を打ち消す見出し');
    ok(rec.composition.factors.length >= 2, '複数の要素で決めていることを示す');
    ok(/ブレ|安定/.test(rec.composition.summary), '安定性に触れている');
});

check('証拠不足でも「推奨できません」で終わらせない', async () => {
    const rec = U.buildRecommendationView(engine(S.notEnough()),
        { status: 'confirmed', blocked: [] }, {});
    eq(rec.status, 'withheld', '推奨は出さない');
    ok(rec.whatToDo.length > 0, '何をすればよいかを返す');
    ok(rec.whatToDo.every((t) => t.label && t.label.length > 0), '文章になっている');
});

// ==================================== Next Best Test

check('Next Best Test が次の1手を文章で返す', async () => {
    const r = engine(S.enough());
    const nbt = U.buildNextBestTestView(r.next_best_test);
    ok(nbt, '提案が出る');
    ok(typeof nbt.nextSensitivity === 'number', '次に試す感度');
    ok(typeof nbt.sessionCount === 'number', '必要な回数');
    ok(nbt.reason || nbt.detail, '理由が付く');
    ok(!/ためです/.test(nbt.sentence), '指示の文に理由を混ぜない（別の行に出す）');
    ok(/次は .*cm で .*回/.test(nbt.sentence), '文章になっている');
});

check('Next Best Test は不確実性の減少量を捏造しない', async () => {
    const nbt = U.buildNextBestTestView(engine(S.enough()).next_best_test);
    eq(nbt.uncertaintyReduction, 'qualitative_only', '内部仕様をそのまま保持する');
    ok(!('uncertaintyReductionValue' in nbt), '数値を作らない');
    ok(/数値では出しません/.test(nbt.uncertaintyNote), '出さない理由を説明する');
});

check('提案が無いときは null を返す（作り話をしない）', async () => {
    eq(U.buildNextBestTestView(null), null, '無ければ null');
    eq(U.buildNextBestTestView({}), null, '中身が無ければ null');
});

// ==================================== 表示の状態そろい

check('14の表示状態がすべて構築できる', async () => {
    const states = {};

    states['1_未選択'] = U.buildImportView({ sessions: [], warnings: [] }, U.resolveDpi([], {}));
    const normal = await runImport('normal');
    states['2_正常'] = U.buildImportView(normal, U.resolveDpi(normal.sessions, { answer: 'as_is' }));
    states['3_複数'] = states['2_正常'];
    states['4_DPI未確認'] = U.buildImportView(normal, U.resolveDpi(normal.sessions, {}));
    states['5_DPI確認済'] = states['2_正常'];
    const ad = await runImport('adaptive');
    states['6_adaptive混在'] = U.buildImportView(ad, U.resolveDpi(ad.sessions, { answer: 'as_is' }));
    const br = await runImport('broken');
    states['7_未対応'] = U.buildImportView(br, U.resolveDpi(br.sessions, { answer: 'as_is' }));
    states['8_一部失敗'] = states['7_未対応'];
    states['9_推奨なし'] = U.buildRecommendationView(engine(S.notEnough()), { blocked: [] }, {});
    states['10_推奨あり'] = U.buildRecommendationView(engine(S.enough()), { blocked: [] }, {});
    states['11_次の測定'] = U.buildNextBestTestView(engine(S.enough()).next_best_test);
    states['12_consent未選択'] = U.defaultConsent();
    states['13_ログイン前'] = U.loginCapabilities(false);
    states['14_ログイン後'] = U.loginCapabilities(true);

    eq(Object.keys(states).length, 14, '14状態');
    Object.keys(states).forEach((k) => ok(states[k] !== undefined && states[k] !== null, k + ' が作れる'));

    // それぞれの状態が実際に区別できていること
    eq(states['1_未選択'].rows.length, 0, '未選択は行が無い');
    ok(states['2_正常'].rows.length > 0, '正常は行がある');
    eq(states['4_DPI未確認'].rows[0].cm360Blocked, true, 'DPI未確認は止まっている');
    eq(states['5_DPI確認済'].rows[0].cm360Blocked, false, '確認済みは止まっていない');
    ok(states['6_adaptive混在'].stateCounts.excluded > 0, '適応型が除外されている');
    ok(states['7_未対応'].rejected.length > 0, '未対応がある');
    eq(states['9_推奨なし'].status, 'withheld', '推奨なし');
    eq(states['10_推奨あり'].status, 'available', '推奨あり');
    eq(states['13_ログイン前'].canSave, false, 'ログイン前は保存できない');
    eq(states['14_ログイン後'].canSave, true, 'ログイン後は保存できる');
});

// ==================================== 派生 accuracy

check('session-level の命中率は Long Cape の導出値として扱う', async () => {
    const r = await runImport('normal');
    const acc = U.derivedAccuracy(r.sessions[0]);
    ok(acc.available, '算出できる');
    eq(acc.layer, 'derived', '導出値である');
    eq(acc.granularity, 'session', 'セッション単位である');
    ok(acc.value > 0 && acc.value <= 1, '0〜1の比である');
    ok(Math.abs(acc.value - acc.hits / acc.shots) < 1e-12, 'hits/shots と一致する');
});

// ------------------------------------------------------------- 実行

for (const { name, fn } of pending) {
    try { await fn(); passed++; }
    catch (e) { failures.push({ name, message: e.message }); }
}

const total = passed + failures.length;
if (failures.length === 0) {
    console.log(`✅ UI テスト成功: ${passed}/${total} 件`);
    process.exit(0);
}
console.error(`❌ UI テスト失敗: ${failures.length}/${total} 件`);
for (const f of failures) console.error(`   - ${f.name}\n     ${f.message}`);
process.exit(1);
