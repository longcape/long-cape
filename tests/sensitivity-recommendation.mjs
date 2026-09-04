// 感度調整量（Sensitivity Delta）contract のテスト。
//
//   node tests/sensitivity-recommendation.mjs
//
// 守りたいこと:
//   * 推奨する感度は **最終最適値ではなく「次に検証する値」**
//   * 実測が無いあいだは数値の delta も改善率も出さない
//   * 母集団平均を個人の最適値にしない
//   * KovaaK の反応モデルと実戦の反応モデルを混ぜない（混ぜると transfer_gap を測れない）
//   * 将来メトリクス候補は planned のままで、推奨を駆動できない
//   * 探索候補（-10%/-5%/現在/+5%/+10%）が固定仕様になっていない
//
// **禁止事項ごとに、わざと違反した payload を作って検出されることを確かめる。**
// 文書に書いただけでは守られないので、破って落ちることを見る。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function load() {
    const ctx = {
        console, Math, JSON, Date, Number, String, Boolean, Array, Object, isFinite, isNaN,
        Promise, Uint8Array, ArrayBuffer, TextEncoder, crypto, Error
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of ['profile/recommendation-scope.js', 'profile/sensitivity-recommendation.js']) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    }
    return ctx;
}

const ctx = load();
const SR = ctx.LC_SENS_REC, SC = ctx.LC_REC_SCOPE;

let passed = 0;
const failures = [];
const pending = [];
const check = (name, fn) => pending.push({ name, fn });
function eq(a, b, l) {
    const x = JSON.stringify(a), y = JSON.stringify(b);
    if (x !== y) throw new Error(`${l || ''} 期待 ${y} / 実際 ${x}`);
}
function ok(c, l) { if (!c) throw new Error(l || '条件を満たしません'); }

/** audit が指定の違反を捕まえたか。 */
function caught(result, rule) {
    return result.violations.some((v) => v.rule === rule);
}

const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'metrics.json'), 'utf8'));
const mechEvidence = [{ sourceType: 'aim_trainer' }, { sourceType: 'aim_trainer' }];
const current = { cm360: 30, inGameSens: 0.4, game: 'valorant', dpi: 800, source: 'user_entered' };

// ============================================ 1. 感度調整量（delta）

check('delta は「次に検証する値」であって最終最適値ではない', async () => {
    const d = SR.buildSensitivityDelta({ current, evidence: mechEvidence });
    eq(d.kind, 'sensitivity_delta_recommendation');
    eq(d.isFinalOptimum, false, '**最終最適値を名乗らない**');
    eq(d.purpose, 'next_verification_value', '次に検証する値である');
});

check('実測が無いあいだは delta を数値で出さない', async () => {
    const d = SR.buildSensitivityDelta({ current, evidence: mechEvidence });
    eq(d.status, 'withheld', '出せない');
    eq(d.deltaPercent, null, '**0 で埋めず null**');
    eq(d.absolute, null, '絶対値も出さない');
    ok(d.reason.includes('no_in_game_evidence'), '実戦 evidence が無いことを理由に挙げる');
    ok(d.reason.includes('insufficient_personal_response_points'), '個人の実測点が足りない');
});

check('現在感度が分からなければその旨を理由に挙げる', async () => {
    const d = SR.buildSensitivityDelta({ evidence: mechEvidence });
    ok(d.reason.includes('current_sensitivity_unknown'), '現在感度が不明');
    eq(d.deltaPercent, null);
});

check('次に何が要るかを数えられる形で返す', async () => {
    const d = SR.buildSensitivityDelta({ current, evidence: mechEvidence });
    const need = d.requiredNextEvidence;
    ok(need.length > 0, '要るものが列挙されている');
    const levels = need.find((n) => n.what === 'distinct_sensitivity_levels_measured');
    ok(levels && levels.need === 3 && levels.have === 0, '感度水準が 0/3');
});

check('delta には必ず scope が付く（Aim テスト上の推奨であること）', async () => {
    const d = SR.buildSensitivityDelta({ current, evidence: mechEvidence });
    ok(d.scope, 'scope がある');
    eq(d.scope.appliesTo, 'aim_test');
    eq(d.scope.provenInGame, false, 'ゲーム内で実証したとは言わない');
});

// ============================================ 2. 予測される改善

check('個人データが無ければ数値予測を生成しない', async () => {
    const p = SR.buildPredictedImprovement({});
    eq(p.kind, 'predicted_improvement');
    eq(p.status, 'not_generated', '**そもそも生成しない**');
    eq(p.predictions, [], '空');
    eq(p.quantificationAllowed, false);
    eq(p.reason, 'no_measured_response_data');
});

check('production-rated でない実測は数値予測に使えない', async () => {
    const p = SR.buildPredictedImprovement({
        observedResponses: [{
            metricKey: 'ingame.flick_overshoot', measured: true,
            maturity: 'planned', observedChange: -0.4
        }]
    });
    eq(p.status, 'not_generated', 'planned の metric では予測を作らない');
    eq(p.reason, 'responses_not_production_rated');
});

check('実測が揃ったときだけ、実測値を根拠として数値を出す', async () => {
    const p = SR.buildPredictedImprovement({
        observedResponses: [{
            metricKey: 'kovaak.accuracy', measured: true,
            maturity: 'production_rated', observedChange: -0.35, unit: 'degree', n: 12
        }]
    });
    eq(p.status, 'quantitative');
    eq(p.predictions[0].direction, 'decrease');
    eq(p.predictions[0].measuredBasis, true, '**実測にもとづくと明示される**');
    eq(p.predictions[0].magnitude.value, -0.35, '実測値そのもの。丸めたり盛ったりしない');
});

// ============================================ 3. 次に試す感度

check('next best test は最終最適感度と区別される', async () => {
    const n = SR.buildNextBestSensitivityTest({ current, evidence: mechEvidence });
    eq(n.kind, 'next_best_sensitivity_test');
    eq(n.isFinalOptimum, false);
    eq(n.distinctFrom, 'final_optimal_sensitivity', '**別物であると型で言う**');
    eq(n.purpose, 'next_verification_value');
});

check('実測が足りなければ qualitative_only を維持する', async () => {
    const n = SR.buildNextBestSensitivityTest({ current, evidence: mechEvidence });
    eq(n.status, 'qualitative_only');
});

check('必要な試行数は未確定であることを理由付きで示す', async () => {
    const n = SR.buildNextBestSensitivityTest({ current, evidence: mechEvidence });
    eq(n.requiredTrials, null, '数を捏造しない');
    eq(n.requiredTrialsReason, 'in_game_trial_unit_not_defined');
});

check('候補は現在感度の周辺に並び、現在値が基準として含まれる', async () => {
    const n = SR.buildNextBestSensitivityTest({ current, evidence: mechEvidence });
    const cur = n.candidates.find((c) => c.isCurrent);
    ok(cur, '現在感度が比較の基準として入っている');
    eq(cur.cm360, 30);
    const minus5 = n.candidates.find((c) => c.deltaPercent === -5);
    eq(minus5.cm360, 28.5, '-5% が正しく計算される');
});

// ==================== 探索戦略が固定仕様になっていないこと

check('候補点は戦略オブジェクトから来る（ロジックに直書きされていない）', async () => {
    // 独自の戦略を渡すと、そのとおりの候補になること。
    // ここが固定なら、この確認は通らない。
    const custom = { id: 'custom', kind: 'local_grid', available: true, offsetsPercent: [-3, 0, 7] };
    eq(SR.candidateOffsets(custom), [-3, 0, 7], '渡した戦略の候補がそのまま出る');
    eq(SR.candidateOffsets(SR.SEARCH_STRATEGIES.local_grid_v1), [-10, -5, 0, 5, 10], '既定は5点');
});

check('既定の5点は「仕様」ではなく「差し替え可能な既定値」と記されている', async () => {
    const s = SR.SEARCH_STRATEGIES.local_grid_v1;
    ok(s.replaceableBy.includes('adaptive_bisection_v1'), 'adaptive へ差し替えられる');
    ok(/既定値/.test(s.note), '既定値であると書いてある');
    const n = SR.buildNextBestSensitivityTest({ current, evidence: mechEvidence });
    eq(n.searchStrategy.replaceable, true);
});

check('未実装の戦略を指定したら既定へ落ち、理由が残る', async () => {
    const r = SR.resolveSearchStrategy({ sensitivitySearch: { strategyId: 'adaptive_bisection_v1' } });
    eq(r.strategy.id, 'local_grid_v1', '既定へ落ちる');
    eq(r.fellBack, true);
    eq(r.requested, 'adaptive_bisection_v1', '**何を要求されたかを残す**');
    eq(r.fallbackReason, 'requires_personal_response_points');
});

check('未知の戦略名は黙って無視せず理由を残す', async () => {
    const r = SR.resolveSearchStrategy({ sensitivitySearch: { strategyId: 'nope' } });
    eq(r.fallbackReason, 'unknown_strategy');
});

// ============================================ 4. 個人の感度反応カーブ

check('カーブの正本は「測った点」であって連続関数ではない', async () => {
    const c = SR.buildResponseCurve({ metricKey: 'kovaak.accuracy', points: [{ cm360: 30, value: 0.8 }] });
    eq(c.representation, 'measured_points', '**最初から連続関数を仮定しない**');
    eq(c.points.length, 1);
    eq(c.points[0].measured, true);
});

check('点が足りなければ補間も回帰もしない', async () => {
    const c = SR.buildResponseCurve({
        points: [{ cm360: 28, value: 0.7 }, { cm360: 30, value: 0.8 }]
    });
    eq(c.interpolation.available, false);
    eq(c.interpolation.have, 2);
    eq(c.interpolation.need, 4);
    eq(c.regression.available, false, '回帰はさらに多くの点が要る');
});

check('点が十分あれば補間・回帰を「派生」として付ける', async () => {
    const pts = [26, 28, 30, 32, 34].map((cm, i) => ({ cm360: cm, value: 0.6 + i * 0.05 }));
    const c = SR.buildResponseCurve({ points: pts });
    eq(c.distinctSensitivityLevels, 5);
    eq(c.interpolation.available, true);
    eq(c.interpolation.derived, true, '派生値であると明示される');
    eq(c.regression.available, true);
});

check('個人内データを母集団平均より優先する', async () => {
    const c = SR.buildResponseCurve({ points: [{ cm360: 30, value: 0.8 }] });
    eq(c.priority, 'personal_over_population');
    eq(c.populationPrior.used, false);
    eq(c.populationPrior.allowedUse, 'display_context_only', '母集団は表示の文脈まで');
});

// ==================== KovaaK と実戦を別モデルで保持する

check('反応モデルは2つに分かれていて、統合されていない', async () => {
    const m = SR.responseModels(mechEvidence);
    eq(m.models.kovaak_mechanical_response.available, true, 'KovaaK 側はある');
    eq(m.models.game_specific_response.available, false, '実戦側はまだ無い');
    eq(m.models.game_specific_response.reason, 'no_in_game_evidence');
    eq(m.merged, false, '**混ぜない**');
    eq(m.mergeProhibited, true);
});

check('transfer_gap は両方が揃うまで出せず、仮定でも埋めない', async () => {
    const m = SR.responseModels(mechEvidence);
    eq(m.transferGap.available, false);
    eq(m.transferGap.have, 1);
    eq(m.transferGap.requires.length, 2);
    eq(m.transferGap.mustBeMeasured, true, '**実測する対象であって仮定しない**');
});

check('実戦 evidence が入れば実戦モデル側が立ち上がる（将来の経路が塞がっていない）', async () => {
    const m = SR.responseModels([{ sourceType: 'aim_trainer' }, { sourceType: 'in_game_match' }]);
    eq(m.models.game_specific_response.available, true);
    eq(m.transferGap.have, 2, '2つ揃ったことは数えられる');
    eq(m.transferGap.available, false, 'ただし統合方法が未定なのでまだ出さない');
    eq(m.transferGap.reason, 'model_not_defined');
});

// ============================================ 将来メトリクス候補

check('将来メトリクス候補は13件あり、すべて planned', async () => {
    eq(SR.PLANNED_METRICS.metrics.length, 13);
    const bad = SR.PLANNED_METRICS.metrics.filter((m) => m.maturity === 'production_rated');
    eq(bad, [], '**production_rated が混ざっていない**');
});

check('将来メトリクス候補は production Registry に入っていない', async () => {
    const prod = new Set(registry.metrics.map((m) => m.metric_key));
    const leaked = SR.PLANNED_METRICS.metrics.filter((m) => prod.has(m.metric_key));
    eq(leaked, [], 'Registry へ漏れていない');
});

check('将来メトリクス候補は推奨を駆動できない', async () => {
    const eligible = SR.PLANNED_METRICS.metrics.filter((m) => m.recommendation_eligible !== false);
    eq(eligible, [], 'recommendation_eligible が true のものは無い');
    const rated = SR.PLANNED_METRICS.metrics.filter((m) => m.reliability_policy);
    eq(rated, [], '4軸 reliability を持たない');
});

check('条件の軸（フリック角・左右・区分）に優劣を付けない', async () => {
    const dims = SR.PLANNED_METRICS.metrics.filter((m) => m.role === 'context_dimension');
    ok(dims.length >= 4, '条件の軸が分けて定義されている');
    dims.forEach((d) => {
        eq(d.higher_is_better, null, `${d.metric_key} は優劣を持たない`);
    });
});

check('各候補に「何が揃えば測れるか」が書いてある', async () => {
    SR.PLANNED_METRICS.metrics.forEach((m) => {
        ok(Array.isArray(m.measurement_requirements) && m.measurement_requirements.length > 0,
            `${m.metric_key} に測定要件がある`);
        ok(typeof m.status_reason === 'string' && m.status_reason.length > 0,
            `${m.metric_key} に未実測の理由がある`);
    });
});

check('planned の metric が推奨を駆動していたら検出できる', async () => {
    const clean = SR.assertNotDriving(['kovaak.score', 'kovaak.accuracy']);
    eq(clean.clean, true, 'production の metric なら問題ない');
    const dirty = SR.assertNotDriving(['kovaak.score', 'ingame.tracking_lag']);
    eq(dirty.clean, false, '**planned が混ざれば落ちる**');
    eq(dirty.offenders[0].metricKey, 'ingame.tracking_lag');
    eq(dirty.offenders[0].maturity, 'planned');
});

// ============================================ 表示契約

check('将来の推奨表示に必要な項目が決まっている', async () => {
    const c = SR.RECOMMENDATION_VIEW_CONTRACT;
    ['currentSensitivity', 'recommendedDeltaPercent', 'nextTestSensitivity',
        'predictedMetricChanges', 'confidence', 'evidenceCount', 'reason', 'requiredNextEvidence']
        .forEach((f) => ok(c.requiredFields.includes(f), `${f} が必須項目にある`));
    eq(c.invariants.isFinalOptimum, false);
    eq(c.generatable, false, 'いまは生成できない');
    eq(c.generatableReason, 'in_game_analysis_not_implemented');
});

// ================================================================
// **わざと違反した payload を作って、検出されることを確かめる**
// ここが緑のままなら「禁止事項がテストで守られている」と言える。
// ================================================================

check('正しく組んだ推奨は監査を通る', async () => {
    const payload = {
        delta: SR.buildSensitivityDelta({ current, evidence: mechEvidence }),
        predicted: SR.buildPredictedImprovement({}),
        next: SR.buildNextBestSensitivityTest({ current, evidence: mechEvidence }),
        curve: SR.buildResponseCurve({ points: [{ cm360: 30, value: 0.8 }] }),
        models: SR.responseModels(mechEvidence)
    };
    const a = SR.auditSensitivityRecommendation(payload);
    eq(a.violations, [], '違反ゼロ');
    ok(a.clean);
});

check('【違反1】overshoot 8% だから感度を 8% 下げる、を検出する', async () => {
    const bad = {
        kind: 'sensitivity_delta_recommendation', deltaPercent: -8,
        isFinalOptimum: false, purpose: 'next_verification_value',
        derivation: { method: 'weighted', inputs: [{ metricKey: 'ingame.flick_overshoot', valuePercent: 8 }] }
    };
    ok(caught(SR.auditSensitivityRecommendation(bad), 'proportional_delta_from_single_metric'),
        '単一入力の割合と変更率の一致を検出する');
});

check('【違反1b】method に単純比例と書いてあれば検出する', async () => {
    const bad = {
        kind: 'sensitivity_delta_recommendation', deltaPercent: -3,
        derivation: { method: 'proportional_to_single_metric', inputs: [] }
    };
    ok(caught(SR.auditSensitivityRecommendation(bad), 'proportional_delta_from_single_metric'));
});

check('【違反1が誤検出でないこと】複数指標から導いた同じ数値は通る', async () => {
    const good = {
        kind: 'sensitivity_delta_recommendation', deltaPercent: -8,
        isFinalOptimum: false, purpose: 'next_verification_value',
        derivation: {
            method: 'weighted',
            inputs: [{ metricKey: 'a', valuePercent: 8 }, { metricKey: 'b', valuePercent: 2 }]
        }
    };
    eq(SR.auditSensitivityRecommendation(good).violations, [], '複数入力なら比例とは言えない');
});

check('【違反2】最終最適値を名乗ることを検出する', async () => {
    const bad = { kind: 'sensitivity_delta_recommendation', isFinalOptimum: true, deltaPercent: -5 };
    ok(caught(SR.auditSensitivityRecommendation(bad), 'declare_optimum_from_single_match'));
});

check('【違反2b】purpose を書き換えて最適値扱いにすることを検出する', async () => {
    const bad = {
        kind: 'sensitivity_delta_recommendation', isFinalOptimum: false,
        purpose: 'final_optimum', deltaPercent: -5
    };
    ok(caught(SR.auditSensitivityRecommendation(bad), 'declare_optimum_from_single_match'));
});

check('【違反3】母集団平均を個人の最適値にすることを検出する', async () => {
    const bad = {
        kind: 'sensitivity_delta_recommendation', deltaPercent: -5,
        derivation: { method: 'population_average', inputs: [] }
    };
    ok(caught(SR.auditSensitivityRecommendation(bad), 'population_average_as_personal_optimum'));

    const bad2 = { populationPrior: { used: true, allowedUse: 'personal_optimum' } };
    ok(caught(SR.auditSensitivityRecommendation(bad2), 'population_average_as_personal_optimum'),
        '母集団を個人最適として使うことを検出する');
});

check('【違反4】KovaaK の最適値をゲーム内の最適値にすることを検出する', async () => {
    const bad = { recommendation: { game_optimum_cm360: 28.5 } };
    ok(caught(SR.auditSensitivityRecommendation(bad), 'kovaak_optimum_as_game_optimum'));

    const merged = SR.responseModels(mechEvidence);
    merged.merged = true;
    ok(caught(SR.auditSensitivityRecommendation(merged), 'kovaak_optimum_as_game_optimum'),
        '2モデルの統合を検出する');
});

check('【違反4b】ゲーム内の強さへ変換する key を検出する', async () => {
    ['rank', 'mmr', 'match_performance', 'transfer_coefficient', 'predicted_rank'].forEach((k) => {
        const bad = { out: {} };
        bad.out[k] = 1;
        ok(!SR.auditSensitivityRecommendation(bad).clean, `${k} を検出する`);
    });
});

check('【違反5】実測していない改善率を検出する', async () => {
    const bad = {
        kind: 'predicted_improvement',
        predictions: [{ metricKey: 'ingame.tracking_lag', direction: 'decrease',
            magnitude: { value: -12, unit: 'millisecond' } }]   // measuredBasis が無い
    };
    ok(caught(SR.auditSensitivityRecommendation(bad), 'fabricate_unmeasured_improvement_rate'));
});

check('【違反5が誤検出でないこと】実測根拠つきの数値は通る', async () => {
    const good = SR.buildPredictedImprovement({
        observedResponses: [{ metricKey: 'kovaak.accuracy', measured: true,
            maturity: 'production_rated', observedChange: -0.35 }]
    });
    eq(SR.auditSensitivityRecommendation(good).violations, []);
});

check('【違反6】実戦データが無いのに game_optimum を出すことを検出する', async () => {
    const bad = { gameOptimum: { available: true, cm360: 28 }, gameEvidenceCount: 0 };
    ok(caught(SR.auditSensitivityRecommendation(bad), 'generate_game_optimum_without_ingame_evidence'));

    const gap = SR.responseModels(mechEvidence);
    gap.transferGap.available = true;
    ok(caught(SR.auditSensitivityRecommendation(gap), 'generate_game_optimum_without_ingame_evidence'),
        '実戦モデルが無いのに transfer_gap を出すことを検出する');
});

check('【違反7】2層が揃っていないのに統合推奨を出すことを検出する', async () => {
    const bad = { integratedRecommendation: { available: true, cm360: 29 } };
    ok(caught(SR.auditSensitivityRecommendation(bad),
        'generate_integrated_recommendation_without_both_layers'));
});

check('禁止事項は7件あり、出力にも列挙される', async () => {
    eq(SR.PROHIBITED.length, 7);
    SR.PROHIBITED.forEach((p) => {
        ok(p.id && p.summary && p.why, `${p.id} に理由が書いてある`);
    });
    const d = SR.buildSensitivityDelta({ current, evidence: mechEvidence });
    eq(d.prohibited.length, 7, '推奨自身が禁止事項を持ち歩く');
});

// ============================================ Stage B を壊していないこと

check('この contract は公開ページから読み込まれていない', async () => {
    // 設計だけを足す約束なので、本番の画面に載っていないことを確かめる。
    for (const page of ['import.html', 'profile.html', 'index.html']) {
        const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
        ok(html.indexOf('sensitivity-recommendation.js') < 0,
            `${page} に読み込まれていない（Stage B の挙動を変えない）`);
    }
});

check('production Registry の metric 数と registry_version が変わっていない', async () => {
    eq(registry.metrics.length, 35, 'metric は 35 のまま');
    eq(registry.registry_version, '1.5.0', 'registry_version は 1.5.0 のまま（DB seed を動かさない）');
});

check('既存の scope contract をそのまま使っている（二重定義していない）', async () => {
    const d = SR.buildSensitivityDelta({ current, evidence: mechEvidence });
    eq(d.scope.kind, 'recommendation_scope', '既存の scope をそのまま載せる');
    eq(d.scope.layer, SC.LAYER.MECHANICAL);
    eq(d.scope.layers.layers[1].available, false, '実戦層はまだ作らない');
    eq(d.scope.layers.layers[2].available, false, '統合層はまだ作らない');
});

// ==================================================== 実行

for (const { name, fn } of pending) {
    try { await fn(); passed++; }
    catch (e) { failures.push({ name, message: e.message }); }
}

const total = passed + failures.length;
if (failures.length === 0) {
    console.log(`✅ 感度調整量 contract テスト成功: ${passed}/${total} 件`);
    process.exit(0);
}
console.error(`❌ 感度調整量 contract テスト失敗: ${failures.length}/${total} 件`);
for (const f of failures) console.error(`   - ${f.name}\n     ${f.message}`);
process.exit(1);
