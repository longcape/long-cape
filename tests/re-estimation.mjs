// Phase E.5（Metric Registry / reliability policy）と
// Phase F（Sensitivity Re-estimation）の自動テスト。
//
//   node tests/re-estimation.mjs
//
// 人工・検証用データ（30/32/34/36cm の既知感度水準）でアルゴリズムを検証する。
// 実KovaaKファイルは使わない。本番DB・ネットワーク・本番サイトにも触れない。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const ctx = {
    console, Math, JSON, Date, Number, String, Boolean, Array, Object, isFinite, isNaN,
    Promise, Uint8Array, ArrayBuffer, TextEncoder, crypto, Error
};
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['profile/metric-registry.js', 'profile/algorithm-config.js', 'profile/aim-profile.js', 'profile/re-estimation.js']) {
    vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'), ctx, { filename: f });
}
const M = ctx.LC_METRICS, P = ctx.LC_PROFILE, R = ctx.LC_REESTIMATE;

// --------------------------------------------------------------- テスト基盤

let passed = 0;
const failures = [];
const pending = [];
const check = (name, fn) => pending.push({ name, fn });
function eq(a, b, l) {
    const x = JSON.stringify(a), y = JSON.stringify(b);
    if (x !== y) throw new Error(`${l || ''} 期待 ${y} / 実際 ${x}`);
}
function ok(c, l) { if (!c) throw new Error(l || '条件を満たしません'); }
function close(a, b, tol, l) { if (Math.abs(a - b) > tol) throw new Error(`${l || ''} 期待 ${b}±${tol} / 実際 ${a}`); }

// ------------------------------------------------- 人工データ生成（決定論的）

/** 決定論的な擬似乱数。テストを再現可能にする。 */
function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * 真の最適が 34cm の逆U字カーブ。指定 cm/360 の期待スコアを返す。
 * 32cm と 36cm が対称になるように作る。
 */
const trueCurve = (cm) => 1000 - 8 * Math.pow(cm - 34, 2);

/**
 * 人工セッションを作る。感度は「ユーザー明示入力で検証済み」とする。
 * @param opts.noise      スコアのばらつき（大きいほど不安定）
 */
function makeSessions(levels, opts = {}) {
    const rand = rng(opts.seed || 42);
    const sessions = [];
    let n = 0;

    for (const lv of levels) {
        const cm = lv.cm360;
        const runs = lv.sessions !== undefined ? lv.sessions : 3;
        const noise = lv.noise !== undefined ? lv.noise : (opts.noise || 10);
        const bias = lv.bias || 0;

        for (let i = 0; i < runs; i++) {
            n++;
            const score = trueCurve(cm) + bias + (rand() - 0.5) * 2 * noise;
            const day = String(10 + (n % 20)).padStart(2, '0');
            sessions.push({
                externalId: `synthetic-${cm}-${i}`,
                scenario: 'Synthetic Benchmark',
                localTimestamp: `2026-08-${day}T12:00:00`,
                tzKnown: true,
                metrics: [
                    { metricKey: 'manual.benchmark_score', value: Math.round(score * 100) / 100, unit: 'score' },
                    { metricKey: 'manual.accuracy_transcribed', value: 60 + (rand() - 0.5) * 4, unit: 'percent' }
                ],
                weapons: [],
                context: {
                    dpi: 800,
                    dpiSource: 'user_input',
                    // 検証済み感度（水準判定に使ってよい唯一の系統）
                    sensitivity: { cm360: cm, verified: true, origin: 'user_input' }
                },
                unresolved: [],
                provenance: {
                    source: 'manual', sourceType: 'manual',
                    sourceIdentifier: `synthetic-${cm}-${i}`,
                    rawContentHash: null, logicalFingerprint: null,
                    parserVersion: '0.0.0-synthetic', normalizationVersion: '0.0.0-synthetic',
                    importedAt: '2026-09-04T00:00:00.000Z', consentId: null
                }
            });
        }
    }
    return sessions;
}

const STANDARD_LEVELS = [{ cm360: 30 }, { cm360: 32 }, { cm360: 34 }, { cm360: 36 }];

function runEngine(sessions, config, extra = {}) {
    const evidence = P.buildEvidence(sessions);
    return R.reestimate({
        sessions, evidence,
        levelResolver: P.verifiedSensitivityLevel,
        now: '2026-09-04T00:00:00',
        configVersion: 'test-config-1',
        ...extra
    }, config);
}

// ==================================================== Phase E.5: Registry

check('Registry: 必須項目がすべての metric に揃っている', async () => {
    const required = ['metric_key', 'source', 'concept', 'category', 'unit', 'data_type',
        'higher_is_better', 'layer', 'metric_version', 'comparability_group',
        'recommendation_eligible', 'reliability_policy', 'normalization_method', 'description'];
    ok(M.all.length > 0, 'metric が登録されている');
    for (const m of M.all) for (const f of required) ok(f in m, `${m.metric_key}: ${f}`);
});

check('Registry: metric_key が <source>.<name> の名前空間', async () => {
    for (const m of M.all) ok(m.metric_key.startsWith(m.source + '.'), m.metric_key);
});

check('Registry: concept が同じでも comparability_group が違えば比較不可', async () => {
    // kovaak.score も manual.benchmark_score も concept=performance だが別グループ
    const a = M.get('kovaak.score'), b = M.get('manual.benchmark_score');
    eq(a.concept, b.concept, '同じ concept であることの確認');
    ok(a.comparability_group !== b.comparability_group, 'comparability_group は別');
    eq(M.isComparable('kovaak.score', 'manual.benchmark_score'), false, '自動的に同一視しない');
    eq(M.isComparable('kovaak.score', 'kovaak.score'), true, '同一グループなら比較可');
});

check('Registry: 汎用の default reliability を持たない', async () => {
    const r = M.resolveReliability('totally.unknown.metric');
    eq(r.status, 'unrated', '未登録は unrated');
    eq(r.value, null, '数値を与えない');
    eq(r.reason, 'metric_not_registered', '理由が付く');
});

check('Registry: unrated は推奨重み 0（情報の存在と信用を分離）', async () => {
    // avg_ttk は G-2 でも保留（C）。意味が未確定のまま。
    eq(M.resolveReliability('kovaak.avg_ttk').status, 'unrated', '意味未確定のため unrated');
    eq(M.recommendationWeight('kovaak.avg_ttk'), 0, '推奨重みは0');
    eq(M.isRecommendationEligible('kovaak.avg_ttk'), false, 'eligible ではない');

    eq(M.resolveReliability('manual.benchmark_score').status, 'rated', '手入力は rated');
    ok(M.recommendationWeight('manual.benchmark_score') > 0, '推奨重みが正');
});

check('Registry: rated と recommendation_eligible は別判定（G-2）', async () => {
    // G-2 で3件が rated 化されたが、推奨へ入れるのは score だけ。
    for (const key of ['kovaak.score', 'kovaak.kills', 'kovaak.accuracy']) {
        eq(M.resolveReliability(key).status, 'rated', `${key} は rated`);
    }
    eq(M.isRecommendationEligible('kovaak.score'), true, 'score だけが eligible');
    ok(M.recommendationWeight('kovaak.score') > 0, 'score は重みを持つ');

    for (const key of ['kovaak.kills', 'kovaak.accuracy']) {
        eq(M.isRecommendationEligible(key), false, `${key} は保留`);
        eq(M.recommendationWeight(key), 0, `${key} の重みは0`);
        const hold = M.get(key).reliability_policy.recommendation_hold;
        ok(hold && hold.held === true, `${key} に保留理由が記録されている`);
        ok(hold.verification_required.length === 4, '解除に必要な検証項目が4点');
    }
});

check('Registry: 実効 reliability は4軸から算出される派生値（G-2）', async () => {
    const AXES = ['measurement', 'semantic', 'comparability', 'provenance_integrity'];

    for (const key of ['kovaak.score', 'kovaak.kills', 'kovaak.accuracy']) {
        const p = M.get(key).reliability_policy;
        // 正本は4軸
        for (const a of AXES) {
            ok(typeof p.axes[a].value === 'number', `${key}.${a} に値がある`);
            ok(p.axes[a].basis && p.axes[a].basis.length > 0, `${key}.${a} に根拠がある`);
        }
        // 単一スカラーを正本として持たない
        ok(!('value' in p), `${key} は単一スカラーを正本にしていない`);
        // 派生であることが明示されている
        eq(p.effective_reliability.derived, true, `${key} の実効値は派生値`);
        eq(p.effective_reliability.policy, 'conservative_min_v1', `${key} の算出方式が名前で指定されている`);

        // runtime の算出結果が policy と一致する
        const r = M.resolveReliability(key, 'file_import_kovaak_stats_csv');
        const min = Math.min(...AXES.map((a) => p.axes[a].value));
        eq(r.value, min, `${key} の実効値は min(axes)`);
        eq(r.effectivePolicy, 'conservative_min_v1', 'policy が返る');
    }

    // provenance を共通のボトルネックにしていないので、metric ごとに実効値が違う
    const vals = ['kovaak.score', 'kovaak.kills', 'kovaak.accuracy']
        .map((k) => M.resolveReliability(k, 'file_import_kovaak_stats_csv').value);
    ok(new Set(vals).size > 1, '3件が同じ値へ潰れていない');
});

check('Registry: rated でない metric を recommendation_eligible にできない', async () => {
    for (const m of M.all) {
        if (m.recommendation_eligible === true) {
            eq(m.reliability_policy.status, 'rated', `${m.metric_key} は rated であるべき`);
        }
    }
});

// ============================================ Phase E.5: sensitivity level

check('感度水準: KovaaK の未確定感度を水準として数えない', async () => {
    const s = {
        externalId: 'k1', localTimestamp: '2026-08-01T00:00:00', tzKnown: false,
        metrics: [], weapons: [], context: { dpi: 800 },
        unresolved: [{ field: 'in_game_sens', reason: 'horiz_sens_multiple_sources', candidates: [{ origin: 'a', value: 0.3 }, { origin: 'b', value: 30 }] }],
        provenance: { source: 'kovaak', sourceType: 'aim_trainer' }
    };
    const lv = P.verifiedSensitivityLevel(s);
    eq(lv.status, 'unknown', '未確定は unknown');
    eq(lv.reason, 'in_game_sens_unresolved', '理由');
});

check('感度水準: 不明なものを「1水準」と誤認しない', async () => {
    const s = {
        externalId: 'k1', localTimestamp: '2026-08-01T00:00:00', tzKnown: false,
        metrics: [], weapons: [], context: { dpi: 800 },
        unresolved: [{ field: 'in_game_sens', reason: 'x' }],
        provenance: { source: 'kovaak', sourceType: 'aim_trainer' }
    };
    const prof = P.buildAimProfile([s, s]);
    eq(prof.inventory.sensitivityLevels.status, 'unknown', 'status');
    eq(prof.inventory.sensitivityLevels.count, null, '件数を出さない');
    ok(/1水準と数えてはいけない/.test(prof.inventory.sensitivityLevels.note), '注意書き');
});

check('感度水準: 検証済み cm/360 のみ数える', async () => {
    const sessions = makeSessions(STANDARD_LEVELS);
    const prof = P.buildAimProfile(sessions);
    eq(prof.inventory.sensitivityLevels.status, 'known', 'status');
    eq(prof.inventory.sensitivityLevels.count, 4, '4水準');
});

check('感度水準: 検証済みと未検証が混在すれば partial', async () => {
    const verified = makeSessions([{ cm360: 32 }, { cm360: 34 }]);
    const unverified = {
        externalId: 'k9', localTimestamp: '2026-08-01T00:00:00', tzKnown: false,
        metrics: [], weapons: [], context: {},
        unresolved: [{ field: 'in_game_sens', reason: 'x' }],
        provenance: { source: 'kovaak', sourceType: 'aim_trainer' }
    };
    const prof = P.buildAimProfile([...verified, unverified]);
    eq(prof.inventory.sensitivityLevels.status, 'partial', 'status');
    eq(prof.inventory.sensitivityLevels.count, 2, '既知分のみ');
    eq(prof.inventory.sensitivityLevels.unknownSessionCount, 1, '未検証件数');
});

// ============================== Phase E.5: completeness と confidence の分離

check('分離: Profile completeness と Recommendation confidence が別概念', async () => {
    const sessions = makeSessions(STANDARD_LEVELS);
    const c = P.buildAimProfile(sessions).confidence;

    ok(c.profileCompleteness, 'profileCompleteness がある');
    ok(c.evidenceQuality, 'evidenceQuality がある');
    eq(c.recommendationConfidence.status, 'not_computed', 'Recommendation confidence は算出しない');
    ok(/表示してはいけない/.test(c.displayGuidance), 'ユーザー表示への注意');
});

check('分離: unrated evidence は quality に反映されるが推奨には使えない', async () => {
    const kovaakSession = {
        externalId: 'k1', localTimestamp: '2026-08-01T00:00:00', tzKnown: false,
        // G-2 で score は rated 化されたので、unrated の例には avg_ttk を使う。
        // avg_ttk は Kills と共線で意味が未確定のため保留のまま。
        metrics: [{ metricKey: 'kovaak.avg_ttk', value: 1000, unit: 's' }],
        weapons: [], context: {}, unresolved: [],
        provenance: { source: 'kovaak', sourceType: 'aim_trainer' }
    };
    const prof = P.buildAimProfile([kovaakSession]);
    const q = prof.confidence.evidenceQuality;

    ok(q.evidenceCount > 0, 'evidence は存在する');
    eq(q.ratedCount, 0, 'rated は0件');
    eq(q.recommendationEligibleCount, 0, '推奨に使えるものは0件');
    eq(q.usableForRecommendation, false, '推奨に使えない');
    // ただし coverage / provenance には出ている
    ok(prof.inventory.metricCoverage.some((c) => c.metricKey === 'kovaak.avg_ttk'), 'coverage には出る');
});

// ================================================== Phase F: 再推定エンジン

check('F: 人工データ（30/32/34/36cm）で真の最適 34cm を当てる', async () => {
    const sessions = makeSessions(STANDARD_LEVELS, { seed: 7 });
    const res = runEngine(sessions);

    eq(res.status, 'issued', '推奨が出る');
    eq(res.recommended_cm360, 34, '真の最適を当てる');
    ok(res.recommended_range[0] <= 34 && 34 <= res.recommended_range[1], 'レンジが最適を含む');
});

check('F: unrated な KovaaK metric を推奨計算に使わない', async () => {
    const synthetic = makeSessions(STANDARD_LEVELS, { seed: 7 });
    const kovaak = {
        externalId: 'k1', localTimestamp: '2026-08-20T12:00:00', tzKnown: false,
        // avg_ttk は G-2 でも保留（C）のまま。極端な値を入れても推奨に効いてはいけない。
        metrics: [{ metricKey: 'kovaak.avg_ttk', value: 99999, unit: 's' }],
        weapons: [], context: { sensitivity: { cm360: 30, verified: true, origin: 'user_input' } },
        unresolved: [], provenance: { source: 'kovaak', sourceType: 'aim_trainer' }
    };
    const res = runEngine([...synthetic, kovaak]);

    eq(res.recommended_cm360, 34, 'unrated な値に影響されない');
    ok(res.evidence_excluded.unrated > 0, '除外理由が記録される');
    eq(res.source_mix.aim_trainer, undefined, '推奨に使った source に aim_trainer が含まれない');
});

check('F: rated でも recommendation_hold の metric は推奨計算に使わない', async () => {
    const synthetic = makeSessions(STANDARD_LEVELS, { seed: 7 });
    // kills は G-2 で rated になったが、Score との相関が未検証のため保留。
    const held = {
        externalId: 'k2', localTimestamp: '2026-08-20T12:00:00', tzKnown: false,
        metrics: [{ metricKey: 'kovaak.kills', value: 99999, unit: 'count' }],
        weapons: [], context: { sensitivity: { cm360: 30, verified: true, origin: 'user_input' } },
        unresolved: [], provenance: { source: 'kovaak', sourceType: 'aim_trainer' }
    };
    const res = runEngine([...synthetic, held]);

    eq(res.recommended_cm360, 34, 'rated でも保留中の metric に影響されない');
    ok(res.evidence_excluded.not_recommendation_eligible > 0, '「eligible でない」として除外される');
});

check('F: 単純な最高Score選択をしない（不安定な最高値を選ばない）', async () => {
    // 32cm に「平均は最高だが極端に不安定」なデータを与える
    const levels = [
        { cm360: 30, noise: 5 },
        { cm360: 32, bias: 120, noise: 260, sessions: 8 },  // 平均は最大、しかしブレが非常に大きい
        { cm360: 34, noise: 5 },
        { cm360: 36, noise: 5 }
    ];
    const sessions = makeSessions(levels, { seed: 3 });
    const res = runEngine(sessions);

    // performance だけなら 32cm が勝つ
    const perfOnly = res.levels.slice().sort((a, b) =>
        b.factors.performance.value - a.factors.performance.value)[0].cm360;
    eq(perfOnly, 32, '平均スコアの最高は 32cm であることの確認');

    // 合成スコアでは安定性が効いて 32cm が選ばれない
    ok(res.recommended_cm360 !== 32, '不安定な最高平均を選ばない');
    ok(res.ranked[0].parts.stability !== undefined, '安定性が合成に使われている');
});

check('F: 存在しない指標を捏造しない', async () => {
    const sessions = makeSessions(STANDARD_LEVELS);
    const res = runEngine(sessions);
    const f = res.levels[0].factors;

    eq(f.fatigue.available, false, '疲労データは無い');
    eq(f.peakPerformance.available, false, 'ピーク性能データは無い');
    eq(f.longSessionPerformance.available, false, '長時間適性データは無い');
    ok(f.fatigue.reason, '理由が付く');
    ok(!('value' in f.fatigue), '値を捏造していない');
});

check('F: 証拠不足なら推奨を出さず、不足内容を返す', async () => {
    const res = runEngine(makeSessions([{ cm360: 34, sessions: 2 }]));

    eq(res.status, 'withheld', '推奨を出さない');
    eq(res.recommended_cm360, null, '感度を出さない');
    eq(res.recommended_range, null, 'レンジも出さない');
    ok(Array.isArray(res.insufficient_evidence), '不足内容が配列');
    ok(res.insufficient_evidence.some((i) => i.code === 'insufficient_sensitivity_levels'),
        '感度水準が足りないことを説明');
});

check('F: 感度が未検証だけのデータでは推奨を出さない', async () => {
    const kovaakOnly = [{
        externalId: 'k1', localTimestamp: '2026-08-01T00:00:00', tzKnown: false,
        metrics: [{ metricKey: 'kovaak.score', value: 1000, unit: 'score' }],
        weapons: [], context: {},
        unresolved: [{ field: 'in_game_sens', reason: 'x' }],
        provenance: { source: 'kovaak', sourceType: 'aim_trainer' }
    }];
    const res = runEngine(kovaakOnly);
    // score は rated / eligible だが、感度が未検証なので水準に束ねられない。
    // evidence があっても比較する水準が無ければ推奨は出さない。
    eq(res.status, 'withheld', '推奨を出さない');
    eq(res.recommended_cm360, null, '推奨値を作らない');
    ok(res.insufficient_evidence.length > 0, '不足理由が記録される');
    ok(res.insufficient_evidence.some((i) => /level/i.test(i.code)),
        '感度水準が足りないことが理由として出る');
});

check('F: Recommendation 出力モデルの必須項目が揃う', async () => {
    const res = runEngine(makeSessions(STANDARD_LEVELS, { seed: 7 }), null, {
        previous: { recommended_cm360: 32, algorithm_version: '0.1.0', config_version: 'test-config-0', evidence_count: 10 }
    });

    for (const k of ['recommended_cm360', 'recommended_range', 'confidence', 'algorithm_version',
        'config_version', 'evidence_count', 'source_mix', 'change_reason', 'insufficient_evidence']) {
        ok(k in res, `${k} が存在すること`);
    }
    eq(res.algorithm_version, R.ALGORITHM_VERSION);
    eq(res.config_version, ctx.LC_ALGO_CONFIG.config_version, 'config_version は設定ファイル由来');
    ok(res.evidence_count > 0);
    ok(res.source_mix.manual > 0, 'source_mix');
});

check('F: change_reason が「なぜ変わったか」を構造化する', async () => {
    const res = runEngine(makeSessions(STANDARD_LEVELS, { seed: 7 }), null, {
        previous: { recommended_cm360: 32, algorithm_version: '0.0.9', config_version: 'test-config-0', evidence_count: 4 }
    });
    const c = res.change_reason;
    eq(c.delta_cm360, 2, '差分');
    const types = c.causes.map((x) => x.type);
    ok(types.includes('algorithm_change'), 'アルゴリズム変更');
    ok(types.includes('config_change'), '設定変更');
    ok(types.includes('new_evidence'), '新規エビデンス');
});

check('F: recommendation confidence は profile completeness と別物', async () => {
    const sessions = makeSessions(STANDARD_LEVELS, { seed: 7 });
    const res = runEngine(sessions);
    eq(res.confidence.kind, 'recommendation_confidence', '種別');
    ok(/Profile completeness とは別概念/.test(res.confidence.note), '注記');
    ok(res.confidence.caveats.length > 0, '留意点が返る');
    ok(res.confidence.caveats.some((c) => /疲労|ピーク|長時間/.test(c)), '欠けている因子を説明');
});

check('F: production_ready を名乗らない', async () => {
    const res = runEngine(makeSessions(STANDARD_LEVELS, { seed: 7 }));
    eq(res.production_ready, false);
    ok(res.production_ready_reason.length > 0);
});

// -------------------------------------------------------------- 結果出力

for (const { name, fn } of pending) {
    try { await fn(); passed++; }
    catch (e) { failures.push({ name, message: e.message }); }
}

const total = passed + failures.length;
if (failures.length === 0) {
    console.log(`✅ Registry / Re-estimation テスト成功: ${passed}/${total} 件`);
    process.exit(0);
}
console.error(`❌ Registry / Re-estimation テスト失敗: ${failures.length}/${total} 件`);
for (const f of failures) console.error(`   - ${f.name}\n     ${f.message}`);
process.exit(1);
