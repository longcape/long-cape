// Phase F.5 — Robustness & Calibration
//
//   node tests/robustness.mjs
//
// 再推定エンジンを、現実に近い悪条件20ケースで検証する。
// 人工データのみ。実KovaaKファイルは使わない。本番にも触れない。

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
for (const f of ['profile/metric-registry.js', 'profile/algorithm-config.js',
    'profile/aim-profile.js', 'profile/re-estimation.js']) {
    vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'), ctx, { filename: f });
}
const P = ctx.LC_PROFILE, R = ctx.LC_REESTIMATE, CFG = ctx.LC_ALGO_CONFIG;

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

// ------------------------------------------------------- 人工データ生成

function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** 真の最適が peak にある逆U字。 */
const curve = (cm, peak = 34, k = 8, top = 1000) => top - k * Math.pow(cm - peak, 2);

/**
 * セッション群を作る。
 * spec: { cm360, sessions, values?, noise, bias, dayStart, metricKey, collectionMethod }
 */
function build(specs, opts = {}) {
    const rand = rng(opts.seed || 11);
    const out = [];
    let n = 0;

    for (const sp of specs) {
        const runs = sp.values ? sp.values.length : (sp.sessions ?? 3);
        for (let i = 0; i < runs; i++) {
            n++;
            const value = sp.values
                ? sp.values[i]
                : curve(sp.cm360, opts.peak ?? 34, opts.k ?? 8, opts.top ?? 1000)
                  + (sp.bias || 0) + (rand() - 0.5) * 2 * (sp.noise ?? 10);

            const dayNum = (sp.dayStart ?? 10) + i;
            const month = sp.month ?? '08';
            const metricKey = sp.metricKey || 'manual.benchmark_score';

            out.push({
                externalId: `${sp.tag || 'syn'}-${sp.cm360}-${i}`,
                scenario: sp.scenario || 'Synthetic',
                localTimestamp: `2026-${month}-${String(dayNum).padStart(2, '0')}T12:00:00`,
                tzKnown: true,
                metrics: [{ metricKey, value: Math.round(value * 100) / 100, unit: 'score' }],
                weapons: [],
                context: {
                    dpi: 800,
                    durationSec: sp.durationSec ?? 60,
                    // G-2: 比較スコープの鍵は表示名ではなく scenario_identity（KovaaK Hash 相当）
                    scenarioKey: sp.scenarioKey || null,
                    difficultyVaried: sp.difficultyVaried === true,
                    sensitivity: { cm360: sp.cm360, verified: true, origin: 'user_input' }
                },
                unresolved: [],
                provenance: {
                    source: sp.source || 'manual',
                    sourceType: sp.sourceType || 'manual',
                    collectionMethod: sp.collectionMethod || null,
                    parserVersion: '0.0.0-synthetic', normalizationVersion: '0.0.0-synthetic',
                    importedAt: '2026-09-04T00:00:00.000Z', consentId: null
                }
            });
        }
    }
    return out;
}

const run = (sessions, extra = {}) => R.reestimate({
    sessions,
    evidence: P.buildEvidence(sessions),
    levelResolver: P.verifiedSensitivityLevel,
    now: '2026-09-04T00:00:00',
    ...extra
}, null);

const std = (n = 4) => [{ cm360: 30, sessions: n }, { cm360: 32, sessions: n },
{ cm360: 34, sessions: n }, { cm360: 36, sessions: n }];

// ===================================================== 20ケースの検証

check('01 完全に綺麗な単峰型 → 真の最適を当てる', async () => {
    const r = run(build(std(), { seed: 1 }));
    eq(r.status, 'issued', 'issued');
    eq(r.recommended_cm360, 34, '真の最適');
    eq(r.edge_optimum.detected, false, '端ではない');
});

check('02 最適値が測定点の中間にある → 隣接2点が僅差になり、中間の追試を提案', async () => {
    // 真の最適 33cm。測定は 30/32/34/36
    const r = run(build(std(6), { seed: 2, peak: 33 }));
    eq(r.status, 'issued', 'issued');
    ok([32, 34].includes(r.recommended_cm360), '32か34が選ばれる');
    // 32 と 34 の差は小さいはず
    const top2 = r.ranked.slice(0, 2).map((x) => x.cm360).sort();
    eq(top2, [32, 34], '上位2水準');
    ok(r.next_best_test, '次の試行提案がある');
});

check('03 2つの感度がほぼ同点 → レンジが両方を含み、切り分けを提案', async () => {
    const r = run(build([
        { cm360: 30, values: [700, 705, 702, 698] },
        { cm360: 32, values: [900, 902, 899, 901] },
        { cm360: 34, values: [901, 899, 902, 900] },
        { cm360: 36, values: [700, 703, 701, 699] }
    ]));
    eq(r.status, 'issued', 'issued');
    ok(r.recommended_range[0] <= 32 && r.recommended_range[1] >= 32, 'レンジが32を含む');
    ok(r.recommended_range[0] <= 34 && r.recommended_range[1] >= 34, 'レンジが34を含む');
    ok(r.confidence.caveats.some((c) => /差が小さ/.test(c)), '同等である旨の留意');
});

check('04 明確な外れ値が1件 → 推奨が引きずられない', async () => {
    const clean = run(build(std(5), { seed: 4 }));
    const withOutlier = run(build([
        { cm360: 30, sessions: 5 },
        { cm360: 32, sessions: 5 },
        { cm360: 34, sessions: 5 },
        { cm360: 36, values: [500, 505, 502, 498, 100000] }   // 1件だけ極端
    ], { seed: 4 }));
    eq(clean.recommended_cm360, 34, '外れ値なしの推奨');
    eq(withOutlier.recommended_cm360, 34, '外れ値があっても推奨は変わらない');
});

check('05 外れ値が複数 → 安定性が落ちてその水準は選ばれない', async () => {
    const r = run(build([
        { cm360: 30, sessions: 5 },
        { cm360: 32, values: [9000, 20, 9500, 15, 8800, 25] },  // 乱高下
        { cm360: 34, sessions: 5 },
        { cm360: 36, sessions: 5 }
    ], { seed: 5 }));
    ok(r.recommended_cm360 !== 32, '乱高下する水準を選ばない');
    const lv32 = r.ranked.find((x) => x.cm360 === 32);
    ok(lv32.parts.stability < 0.3, '安定性スコアが低い');
});

check('06 1感度だけsession数が極端に多い → 件数の多さだけで勝たない', async () => {
    const r = run(build([
        { cm360: 30, sessions: 40 },   // 大量だが性能は低い
        { cm360: 32, sessions: 3 },
        { cm360: 34, sessions: 3 },
        { cm360: 36, sessions: 3 }
    ], { seed: 6 }));
    eq(r.recommended_cm360, 34, '件数の多い30cmに引きずられない');
});

check('07 古いデータと新しいデータで傾向が逆転 → recency が新しい側を重く見る', async () => {
    // 古い期間は30cmが良く、新しい期間は36cmが良い
    const sessions = [
        ...build([{ cm360: 30, values: [1000, 1005, 998, 1002], month: '05', dayStart: 1 }]),
        ...build([{ cm360: 32, values: [900, 902, 898, 901], month: '05', dayStart: 5 }]),
        ...build([{ cm360: 34, values: [900, 899, 901, 900], month: '08', dayStart: 25 }]),
        ...build([{ cm360: 36, values: [1000, 1002, 999, 1001], month: '08', dayStart: 28 }])
    ];
    const r = run(sessions);
    const l30 = r.ranked.find((x) => x.cm360 === 30);
    const l36 = r.ranked.find((x) => x.cm360 === 36);
    ok(l36.parts.recency > l30.parts.recency, '新しい側の recency が高い');
    eq(r.recommended_cm360, 36, '同性能なら新しい側が勝つ');
});

check('08 FlickとTrackingで最適感度が異なる → 別 comparability_group は混ぜない', async () => {
    // 同じ metric_key を使う限り混ざるが、別 metric なら別グループとして扱われる
    const flick = build([{ cm360: 30, sessions: 4 }, { cm360: 32, sessions: 4 }],
        { seed: 8, peak: 30 });
    const tracking = build([{ cm360: 34, sessions: 4 }, { cm360: 36, sessions: 4 }],
        { seed: 9, peak: 36, metricKey: 'manual.accuracy_transcribed' });
    const tracking2 = tracking.map((s) => ({
        ...s,
        metrics: [{ metricKey: 'manual.accuracy_transcribed', value: s.metrics[0].value / 10, unit: 'percent' }]
    }));
    const r = run([...flick, ...tracking2]);
    eq(r.status, 'issued', 'issued');
    // 各水準の主指標が comparability_group ごとに選ばれている
    const groups = new Set(r.levels.map((l) => l.factors.performance.metricGroup));
    ok(groups.size >= 2, '複数の指標グループが存在する');
});

check('09 source A と source B で結果が逆 → source_mix に両方が出る', async () => {
    const a = build([{ cm360: 30, sessions: 3 }, { cm360: 32, sessions: 3 }, { cm360: 34, sessions: 3 }],
        { seed: 10, peak: 30 });
    const b = build([{ cm360: 30, sessions: 3 }, { cm360: 32, sessions: 3 }, { cm360: 34, sessions: 3 }],
        { seed: 11, peak: 34 }).map((s) => ({
            ...s, externalId: s.externalId + '-b',
            provenance: { ...s.provenance, source: 'manual', sourceType: 'in_game_range' }
        }));
    const r = run([...a, ...b]);
    eq(r.status, 'issued', 'issued');
    ok(Object.keys(r.source_mix).length >= 2, 'source_mix に複数の source_type');
    // 矛盾があるので分離度は低いはず
    ok(r.source_conflict.detected, 'source間の矛盾を検出する');
    ok(r.confidence.penalties.some((p) => p.code === 'source_conflict'), 'confidence を下げる');
    ok(r.confidence.caveats.some((c) => /食い違/.test(c)), '矛盾を説明する');
});

check('10 stability は高いが peak が低い → 安定だけで勝たない', async () => {
    const r = run(build([
        { cm360: 30, values: [600, 600, 600, 600, 600] },   // 完全に安定だが低い
        { cm360: 32, sessions: 4 },
        { cm360: 34, sessions: 4 },
        { cm360: 36, sessions: 4 }
    ], { seed: 12 }));
    ok(r.recommended_cm360 !== 30, '安定なだけの低性能を選ばない');
});

check('11 peak は高いが repeatability が低い → 再現性の低さが効く', async () => {
    const r = run(build([
        { cm360: 30, sessions: 4 },
        { cm360: 32, sessions: 4 },
        { cm360: 34, sessions: 4 },
        { cm360: 36, values: [1400, 200, 1500, 150, 1450, 180] }  // 高いが再現しない
    ], { seed: 13 }));
    const l36 = r.ranked.find((x) => x.cm360 === 36);
    ok(l36.parts.repeatability < 0.3, '再現性スコアが低い');
    ok(r.recommended_cm360 !== 36, '再現しない高値を選ばない');
});

check('12 fatigue により後半だけ崩れる → 現状は fatigue を算出できないと明示', async () => {
    const r = run(build(std(5), { seed: 14 }));
    const f = r.levels[0].factors;
    eq(f.fatigue.available, false, '疲労は算出できない');
    eq(f.fatigue.reason, 'no_intra_session_timeseries', '理由');
    ok(r.confidence.caveats.some((c) => /疲労/.test(c)), '留意点として提示される');
});

check('13 session duration が大きく異なる → 現状は長時間適性を算出できないと明示', async () => {
    const sessions = [
        ...build([{ cm360: 30, sessions: 3, durationSec: 60 }]),
        ...build([{ cm360: 32, sessions: 3, durationSec: 1800 }]),
        ...build([{ cm360: 34, sessions: 3, durationSec: 60 }]),
        ...build([{ cm360: 36, sessions: 3, durationSec: 3600 }])
    ];
    const r = run(sessions);
    eq(r.levels[0].factors.longSessionPerformance.available, false, '長時間適性は未算出');
    eq(r.status, 'issued', '算出できない因子があっても推奨自体は出る');
});

check('14 一部 metric 欠損 → 欠損水準でも落ちず、因子が available:false になる', async () => {
    const sessions = build(std(4), { seed: 15 });
    // 36cm の metrics を空にする
    sessions.filter((s) => s.externalId.includes('-36-')).forEach((s) => { s.metrics = []; });
    const r = run(sessions);
    eq(r.status, 'issued', '落ちない');
    const l36 = r.levels.find((l) => l.cm360 === 36);
    eq(l36.factors.performance.available, false, '性能を算出できない');
    ok(!r.ranked.some((x) => x.cm360 === 36), '合成できない水準は順位から外れる');
});

check('15 reliability が異なる Evidence 混在 → 重みが違うことを確認', async () => {
    const s = build([{ cm360: 34, sessions: 1 }]);
    s[0].metrics.push({ metricKey: 'manual.accuracy_transcribed', value: 65, unit: 'percent' });
    const ev = P.buildEvidence(s);
    const score = ev.find((e) => e.metricKey === 'manual.benchmark_score');
    const acc = ev.find((e) => e.metricKey === 'manual.accuracy_transcribed');
    eq(score.recommendationWeight, 0.55, 'benchmark_score の重み');
    eq(acc.recommendationWeight, 0.5, 'accuracy の重み');
    ok(score.recommendationWeight !== acc.recommendationWeight, '同じ manual でも重みが違う');
});

check('16 unrated Evidence へ巨大値を入れる → 推奨に影響しない', async () => {
    const base = build(std(4), { seed: 16 });
    const poisoned = base.map((s) => s.externalId.includes('-30-')
        ? { ...s, metrics: [...s.metrics, { metricKey: 'kovaak.avg_ttk', value: 9999999, unit: 's' }] }
        : s);
    const clean = run(base);
    const r = run(poisoned);
    eq(r.recommended_cm360, clean.recommended_cm360, '推奨が変わらない');
    ok(r.evidence_excluded.unrated > 0, '除外件数が記録される');
});

check('17 sensitivity coverage が片側に偏る → balanceAroundBest が skewed を報告', async () => {
    const r = run(build([
        { cm360: 34, sessions: 4 }, { cm360: 36, sessions: 4 }, { cm360: 38, sessions: 4 }
    ], { seed: 17, peak: 34 }));
    eq(r.recommended_cm360, 34, '最良は下端');
    eq(r.sensitivity_coverage.balanceAroundBest.below, 0, '下側に測定点が無い');
    eq(r.sensitivity_coverage.balanceAroundBest.skewed, true, '偏りを報告');
});

check('18 最適値が測定範囲の端にある → edge_optimum を検出し confidence を下げる', async () => {
    const inside = run(build(std(4), { seed: 18 }));                      // 最良は 34（中）
    const edge = run(build([{ cm360: 34, sessions: 4 }, { cm360: 36, sessions: 4 },
    { cm360: 38, sessions: 4 }], { seed: 18, peak: 34 }));                // 最良は 34（下端）

    eq(inside.edge_optimum.detected, false, '中なら検出しない');
    eq(edge.edge_optimum.detected, true, '端なら検出する');
    eq(edge.edge_optimum.side, 'low', '下端');
    eq(edge.edge_optimum.suggestedOutward, 32, '外側の候補を提案');
    ok(edge.confidence.penalties.some((p) => p.code === 'edge_optimum'), 'confidence を下げる');
    ok(/測定範囲の外/.test(edge.edge_optimum.message), '真の最適が範囲外かもと明示');
});

check('19 本当の最適値が測定範囲外 → 端検出＋外側の追試を提案', async () => {
    // 真の最適 26cm。測定は 30/32/34
    const r = run(build([{ cm360: 30, sessions: 4 }, { cm360: 32, sessions: 4 },
    { cm360: 34, sessions: 4 }], { seed: 19, peak: 26 }));

    eq(r.recommended_cm360, 30, '測定範囲内では30cmが最良');
    eq(r.edge_optimum.detected, true, '端であることを検出');
    eq(r.next_best_test.reason, 'explore_beyond_edge', '外側の追試を提案');
    ok(r.next_best_test.next_test_cm360 < 30, '30cmより外側を提案');
    // 「測定中の最高」と「真の最適」を同一視していないこと
    ok(r.confidence.value < 0.6, 'confidence が高くならない');
});

check('20 データ不足 → withheld とし、不足内容を返す', async () => {
    const r = run(build([{ cm360: 34, sessions: 2 }]));
    eq(r.status, 'withheld', '推奨を出さない');
    eq(r.recommended_cm360, null);
    ok(r.insufficient_evidence.some((i) => i.code === 'insufficient_sensitivity_levels'));
    ok(r.sensitivity_coverage, 'withheld でも coverage は返す');
    ok(r.next_best_test, 'withheld でも次の試行を提案する');
    eq(r.next_best_test.reason, 'increase_level_count', 'まず水準を増やす提案');
});

// ============================ source conflict の限定（Phase G 前の修正）

check('C1 Flick と Tracking で最適が違っても矛盾扱いしない', async () => {
    // 別の comparability_group（benchmark_score と accuracy_transcribed）
    const flick = build([
        { cm360: 30, sessions: 3 }, { cm360: 32, sessions: 3 }, { cm360: 34, sessions: 3 }
    ], { seed: 30, peak: 32 });

    const trackingRaw = build([
        { cm360: 30, sessions: 3 }, { cm360: 32, sessions: 3 }, { cm360: 34, sessions: 3 }
    ], { seed: 31, peak: 34 });
    const tracking = trackingRaw.map((x) => ({
        ...x, externalId: x.externalId + '-trk',
        metrics: [{ metricKey: 'manual.accuracy_transcribed', value: x.metrics[0].value / 20, unit: 'percent' }]
    }));

    const r = run([...flick, ...tracking]);

    eq(r.source_conflict.detected, false, '矛盾として扱わない');
    ok(!r.confidence.penalties.some((p) => p.code === 'source_conflict'), '減点しない');
    ok(r.characteristic_differences.length > 0, '特性差として保持する');
    ok(/矛盾ではありません/.test(r.characteristic_differences[0].note), '説明が付く');
    eq(r.characteristic_differences[0].classification, 'characteristic_difference', '分類');
});

check('C2 Trainer と実戦で最適が違っても、スコープが違えば矛盾扱いしない', async () => {
    // 同じ metric だがシナリオが違う = 比較スコープが違う
    const trainer = build([
        { cm360: 30, sessions: 3, scenario: 'Trainer Scenario' },
        { cm360: 32, sessions: 3, scenario: 'Trainer Scenario' },
        { cm360: 34, sessions: 3, scenario: 'Trainer Scenario' }
    ], { seed: 32, peak: 32 });

    const match = build([
        { cm360: 30, sessions: 3, scenario: 'Live Match' },
        { cm360: 32, sessions: 3, scenario: 'Live Match' },
        { cm360: 34, sessions: 3, scenario: 'Live Match' }
    ], { seed: 33, peak: 34 }).map((x) => ({
        ...x, externalId: x.externalId + '-live',
        provenance: { ...x.provenance, sourceType: 'in_game_match' }
    }));

    const r = run([...trainer, ...match]);
    eq(r.source_conflict.detected, false, 'シナリオが違えば矛盾ではない');
    ok(r.characteristic_differences.length > 0, '環境差として保持する');
});

check('C3 同一スコープ内で食い違えば矛盾として検出する', async () => {
    // 同じ metric・同じシナリオ・source_type だけ違う
    const a = build([
        { cm360: 30, sessions: 3 }, { cm360: 32, sessions: 3 }, { cm360: 34, sessions: 3 }
    ], { seed: 34, peak: 30 });
    const b = build([
        { cm360: 30, sessions: 3 }, { cm360: 32, sessions: 3 }, { cm360: 34, sessions: 3 }
    ], { seed: 35, peak: 34 }).map((x) => ({
        ...x, externalId: x.externalId + '-b',
        provenance: { ...x.provenance, sourceType: 'in_game_range' }
    }));

    const r = run([...a, ...b]);
    eq(r.source_conflict.detected, true, '同一スコープなら矛盾');
    eq(r.source_conflict.conflicts.length >= 1, true, '内訳が返る');

    const c = r.source_conflict.conflicts[0];
    ok(c.scope, 'どのスコープでの矛盾か分かる');
    ok(c.disagreementCm > 0, '食い違いの大きさ');
    ok(typeof c.severity === 'number', 'severity を算出する');
    eq(c.severityAppliedToPenalty, false, '現時点では penalty へ反映していない');
    ok(r.confidence.penalties.some((p) => p.code === 'source_conflict'), '減点する');
});

check('C4 conflict penalty が config 値であり固定でない', async () => {
    ok(CFG.sourceConflict, 'config に sourceConflict がある');
    eq(CFG.sourceConflict.penalty, 0.75, 'prototype値');
    ok(/prototype/.test(CFG.sourceConflict._note), 'prototype である旨');

    const a = build([{ cm360: 30, sessions: 3 }, { cm360: 32, sessions: 3 }, { cm360: 34, sessions: 3 }],
        { seed: 34, peak: 30 });
    const b = build([{ cm360: 30, sessions: 3 }, { cm360: 32, sessions: 3 }, { cm360: 34, sessions: 3 }],
        { seed: 35, peak: 34 }).map((x) => ({
            ...x, externalId: x.externalId + '-b',
            provenance: { ...x.provenance, sourceType: 'in_game_range' }
        }));

    const strict = JSON.parse(JSON.stringify(CFG));
    strict.sourceConflict.penalty = 0.4;
    const r1 = run([...a, ...b]);
    const r2 = R.reestimate({
        sessions: [...a, ...b], evidence: P.buildEvidence([...a, ...b]),
        levelResolver: P.verifiedSensitivityLevel, now: '2026-09-04T00:00:00'
    }, strict);
    ok(r2.confidence.value < r1.confidence.value, 'config を変えると効き方が変わる');
});

check('C5 標本が少ない source は矛盾判定に使わない', async () => {
    const a = build([{ cm360: 30, sessions: 3 }, { cm360: 32, sessions: 3 }, { cm360: 34, sessions: 3 }],
        { seed: 36, peak: 34 });
    // 1件しか無い source は判定対象外
    const b = build([{ cm360: 30, sessions: 1 }], { seed: 37, peak: 30 }).map((x) => ({
        ...x, externalId: x.externalId + '-thin',
        provenance: { ...x.provenance, sourceType: 'in_game_match' }
    }));
    const r = run([...a, ...b]);
    eq(r.source_conflict.detected, false, '標本不足の source では矛盾と判定しない');
});

// ================================ 集約戦略（median の適用単位）

check('A1 集約は同質スコープの中でのみ行う', async () => {
    const sessions = build([{ cm360: 34, sessions: 4, scenario: 'S1' }], { seed: 38 });
    const other = build([{ cm360: 34, sessions: 4, scenario: 'S2' }], { seed: 39, top: 5000 })
        .map((x) => ({ ...x, externalId: x.externalId + '-s2' }));

    const r = run([...sessions, ...other,
    ...build([{ cm360: 32, sessions: 3, scenario: 'S1' }], { seed: 40 }),
    ...build([{ cm360: 36, sessions: 3, scenario: 'S1' }], { seed: 41 })]);

    const l34 = r.levels.find((l) => l.cm360 === 34);
    ok(l34.scopes.length >= 2, '複数のスコープが存在する');
    // 主指標は最も観測数の多いスコープ1つ。別シナリオの値と混ざっていない
    // G-2 でスコープ鍵は scenario_identity（Hash）で組むようになった。
    // identity が無いデータは名前へ退避し、退避したことが鍵に残る。
    ok(/scn_id:|scn_name_fallback:S1|scn_name_fallback:S2/.test(l34.factors.performance.metricGroup),
        'スコープ鍵にシナリオの識別子が含まれる');
});

check('A2 集約戦略を config で差し替えられる', async () => {
    const sessions = build([
        { cm360: 30, sessions: 4 },
        { cm360: 32, sessions: 4 },
        { cm360: 34, values: [900, 905, 902, 100000] },   // 外れ値1件
        { cm360: 36, sessions: 4 }
    ], { seed: 42 });

    const meanCfg = JSON.parse(JSON.stringify(CFG));
    meanCfg.aggregation.strategy = 'mean';
    const trimCfg = JSON.parse(JSON.stringify(CFG));
    trimCfg.aggregation.strategy = 'trimmed_mean';

    const med = run(sessions);
    const mn = R.reestimate({
        sessions, evidence: P.buildEvidence(sessions),
        levelResolver: P.verifiedSensitivityLevel, now: '2026-09-04T00:00:00'
    }, meanCfg);
    const tm = R.reestimate({
        sessions, evidence: P.buildEvidence(sessions),
        levelResolver: P.verifiedSensitivityLevel, now: '2026-09-04T00:00:00'
    }, trimCfg);

    eq(med.levels.find((l) => l.cm360 === 34).factors.statistic, undefined, '型の確認用');
    const v = (r) => r.levels.find((l) => l.cm360 === 34).factors.performance.value;
    ok(v(mn) > v(med), '平均は外れ値に引きずられる');
    ok(v(med) < 1000, '中央値は引きずられない');
    ok(typeof v(tm) === 'number', 'trimmed_mean も動作する');
});

// ============================================ config / 概念分離の検証

check('config: 重みがコードに固定されず config から来る', async () => {
    ok(CFG.config_version, 'config_version がある');
    eq(CFG.factorWeights.performance, 0.45, '設定ファイルの値');

    const r = run(build(std(4), { seed: 20 }));
    eq(r.config_version, CFG.config_version, 'Recommendation が config_version を持つ');
    eq(r.algorithm_version, R.ALGORITHM_VERSION, 'algorithm_version は別');
    ok(r.config_version !== r.algorithm_version, '2つは別の版として分離されている');
});

check('config: 重みを変えると結果が変わる（config だけで挙動が動く）', async () => {
    const sessions = build([
        { cm360: 30, values: [600, 600, 600, 600, 600] },   // 安定だが低性能
        { cm360: 32, sessions: 4 },
        { cm360: 34, sessions: 4 },
        { cm360: 36, sessions: 4 }
    ], { seed: 21 });

    const stabilityHeavy = JSON.parse(JSON.stringify(CFG));
    stabilityHeavy.factorWeights = { performance: 0.05, stability: 0.90, repeatability: 0.03, recency: 0.02 };

    const a = R.reestimate({
        sessions, evidence: P.buildEvidence(sessions),
        levelResolver: P.verifiedSensitivityLevel, now: '2026-09-04T00:00:00'
    }, null);
    const b = R.reestimate({
        sessions, evidence: P.buildEvidence(sessions),
        levelResolver: P.verifiedSensitivityLevel, now: '2026-09-04T00:00:00'
    }, stabilityHeavy);

    ok(a.recommended_cm360 !== b.recommended_cm360 || a.ranked[0].composite !== b.ranked[0].composite,
        '重みを変えると結果が変わる');
});

check('config: 利用できない factor を0点にせず重みごと除外する', async () => {
    const r = run(build(std(4), { seed: 22 }));
    const top = r.ranked[0];
    // fatigue 等は available:false なので usedWeight は 1 未満にならない
    // （使えた factor の重みだけで再正規化しているため）
    ok(top.usedWeight > 0, '使った重みが記録される');
    ok(top.composite <= 1 && top.composite >= 0, '合成スコアが0〜1');
    // 単一観測の水準では stability が使えないことを確認
    const single = run(build([
        { cm360: 30, sessions: 2 }, { cm360: 32, sessions: 2 },
        { cm360: 34, values: [1000] }, { cm360: 36, sessions: 2 }
    ], { seed: 23 }));
    const l34 = single.levels.find((l) => l.cm360 === 34);
    eq(l34.factors.stability.available, false, '1観測では安定性を出さない');
    eq(l34.factors.stability.reason, 'need_at_least_2_observations', '理由');
});

check('概念分離: 4つが別物として維持されている', async () => {
    const sessions = build(std(4), { seed: 24 });
    const prof = P.buildAimProfile(sessions);
    const rec = run(sessions);

    eq(prof.confidence.profileCompleteness !== undefined, true, 'profile_completeness');
    eq(prof.confidence.evidenceQuality !== undefined, true, 'evidence_quality');
    eq(rec.confidence.kind, 'recommendation_confidence', 'recommendation_confidence');
    eq(rec.sensitivity_coverage.kind, 'sensitivity_coverage', 'sensitivity_coverage');

    // 1つの値ですべてを表現していないこと
    ok(prof.confidence.profileCompleteness.value !== rec.confidence.value,
        'profile completeness と recommendation confidence が別の値');
});

check('range: tolerance の意味が出力に明文化されている', async () => {
    const r = run(build(std(4), { seed: 25 }));
    ok(r.range_definition, 'range_definition がある');
    ok(/合成スコアの絶対差/.test(r.range_definition), '何に対する値かが書かれている');
    ok(/パーセンテージではない|でもない/.test(r.range_definition), '誤解を防ぐ記述');
});

// -------------------------------------------------------------- 結果出力

// ------------------ G-2: comparison scope と adaptive 除外

check('G2-1 別シナリオの Score を同じスコープへ混ぜない', async () => {
    // 表示名は同じだが scenario_identity が違う2群。名前が同じでも混ぜてはいけない。
    const same = build([{ cm360: 34, sessions: 4, scenario: 'Same Name', scenarioKey: 'hash-A' }], { seed: 60 });
    const other = build([{ cm360: 34, sessions: 4, scenario: 'Same Name', scenarioKey: 'hash-B' }],
        { seed: 61, top: 9000 }).map((x) => ({ ...x, externalId: x.externalId + '-b' }));

    const r = run([...same, ...other,
        ...build([{ cm360: 32, sessions: 3, scenario: 'Same Name', scenarioKey: 'hash-A' }], { seed: 62 }),
        ...build([{ cm360: 36, sessions: 3, scenario: 'Same Name', scenarioKey: 'hash-A' }], { seed: 63 })]);

    const l34 = r.levels.find((l) => l.cm360 === 34);
    ok(l34.scopes.length >= 2, '表示名が同じでも identity が違えば別スコープになる');
    const keys = l34.scopes.map((sc) => sc.scope).join(' ');
    ok(/hash-A/.test(keys) && /hash-B/.test(keys), 'スコープ鍵に scenario_identity が入る');
    // 主指標が両者の平均になっていない（9000 の群と混ざっていない）
    ok(l34.factors.performance.value < 5000, '別シナリオの高スコアと混ざっていない');
});

check('G2-2 scenario_identity があれば表示名の改名に影響されない', async () => {
    const a = build([{ cm360: 34, sessions: 3, scenario: 'Old Name', scenarioKey: 'hash-X' }], { seed: 64 });
    const b = build([{ cm360: 34, sessions: 3, scenario: 'New Name', scenarioKey: 'hash-X' }], { seed: 64 })
        .map((x) => ({ ...x, externalId: x.externalId + '-renamed' }));

    const r = run([...a, ...b,
        ...build([{ cm360: 32, sessions: 3, scenarioKey: 'hash-X' }], { seed: 65 }),
        ...build([{ cm360: 36, sessions: 3, scenarioKey: 'hash-X' }], { seed: 66 })]);

    const l34 = r.levels.find((l) => l.cm360 === 34);
    const keys = l34.scopes.map((sc) => sc.scope).join(' ');
    ok(!/Old Name|New Name/.test(keys), '表示名はスコープ鍵に使われない');
    ok(/hash-X/.test(keys), 'identity が鍵になる');
});

check('G2-3 adaptive セッションを通常の水準比較へ混ぜない', async () => {
    const normal = build([
        { cm360: 32, sessions: 3, scenarioKey: 'hash-A' },
        { cm360: 34, sessions: 3, scenarioKey: 'hash-A' },
        { cm360: 36, sessions: 3, scenarioKey: 'hash-A' }
    ], { seed: 67 });
    // 難易度が動いた（適応型）セッションに極端な高スコアを入れる
    const adaptive = build([{ cm360: 30, sessions: 4, scenarioKey: 'hash-A', difficultyVaried: true }],
        { seed: 68, top: 999999 });

    const clean = run(normal);
    const mixed = run([...normal, ...adaptive]);

    eq(mixed.recommended_cm360, clean.recommended_cm360, '適応型の高スコアに引っ張られない');
    ok(mixed.evidence_excluded.difficulty_varied > 0, '難易度変動として除外件数が記録される');
});

check('G2-4 難易度が一定なら除外しない', async () => {
    const r = run(build([
        { cm360: 32, sessions: 3, scenarioKey: 'hash-A' },
        { cm360: 34, sessions: 3, scenarioKey: 'hash-A' },
        { cm360: 36, sessions: 3, scenarioKey: 'hash-A' }
    ], { seed: 69 }));
    ok(!r.evidence_excluded.difficulty_varied, '通常セッションは除外されない');
});

for (const { name, fn } of pending) {
    try { await fn(); passed++; }
    catch (e) { failures.push({ name, message: e.message }); }
}


const total = passed + failures.length;
if (failures.length === 0) {
    console.log(`✅ Robustness テスト成功: ${passed}/${total} 件`);
    process.exit(0);
}
console.error(`❌ Robustness テスト失敗: ${failures.length}/${total} 件`);
for (const f of failures) console.error(`   - ${f.name}\n     ${f.message}`);
process.exit(1);
