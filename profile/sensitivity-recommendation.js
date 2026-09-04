/**
 * 感度調整量（Sensitivity Delta）の contract。
 *
 * 【このファイルの位置づけ】
 *   **将来の設計であって、いま動く実戦解析エンジンではない。**
 *   実戦（ゲーム内）のエイム解析はまだ実装していない。ここにあるのは
 *   「実装したときに、どういう形で値を返さなければならないか」という契約と、
 *   「まだ値が無い」ことを正しく表現するための型だけである。
 *
 *   このファイルは公開ページ（import.html / profile.html）から読み込まない。
 *   Stage B の本番挙動・DB・Analytics・公開UIには一切影響しない。
 *
 * 【4つの概念】
 *   1. sensitivity_delta_recommendation      … 現在感度から何%変えるか
 *   2. predicted_improvement                 … その変更で改善が見込まれる指標
 *   3. next_best_sensitivity_test            … 次に試すべき感度
 *   4. personal_sensitivity_response_curve   … 感度変更と実測変化の個人内の関係
 *
 * 【最も重要な決まり】
 *   * 推奨する感度は **最終最適値ではなく「次に検証する値」** である。
 *     `isFinalOptimum` は常に false。ここを true にできる経路を作らない。
 *   * 実測していない改善率を作らない。個人データが足りなければ
 *     **数値予測を生成しない**（方向性だけ、あるいは何も出さない）。
 *   * 母集団平均で個人の最適値を決めない。**個人内データを優先する。**
 *   * KovaaK の最適値をそのままゲーム内の最適値として扱わない。
 *     両者は別モデルとして保持し、その差（transfer_gap）は
 *     **仮定するのではなく実測する**対象である。
 */
(function (root) {
    'use strict';

    var SCOPE = root.LC_REC_SCOPE || null;

    // ================================================================ 語彙

    /** 出力の状態。値が無いことを「0」や「空」で表さないための語彙。 */
    var STATUS = {
        WITHHELD: 'withheld',                 // 前提を満たさないので出さない
        QUALITATIVE_ONLY: 'qualitative_only', // 方向や理由は言えるが数値は出せない
        QUANTITATIVE: 'quantitative',         // 実測にもとづく数値を出せる
        NOT_GENERATED: 'not_generated'        // そもそも生成しない
    };

    /** metric の成熟度。production_rated 以外は推奨を駆動できない。 */
    var MATURITY = {
        PLANNED: 'planned',
        EXPERIMENTAL: 'experimental',
        UNVALIDATED: 'unvalidated',
        PRODUCTION_RATED: 'production_rated'
    };

    var PURPOSE_NEXT_TEST = 'next_verification_value';

    // ============================================================ 禁止事項
    //
    // contract として明記する。auditSensitivityRecommendation() が機械的に検査する。

    var PROHIBITED = [
        {
            id: 'proportional_delta_from_single_metric',
            summary: '単一指標からの単純比例（例: overshoot が 8% だから感度を 8% 下げる）',
            why: 'overshoot の割合と感度の割合は単位も意味も違う。両者が比例する根拠は測っていない。'
        },
        {
            id: 'declare_optimum_from_single_match',
            summary: '1試合・1セッションだけで最適感度を断言する',
            why: '1回の結果は調子・相手・マップの影響を強く受ける。区別できるだけの反復が要る。'
        },
        {
            id: 'population_average_as_personal_optimum',
            summary: '母集団平均だけで個人の最適値を決める',
            why: '感度の反応は個人差が大きい。平均は出発点にはなるが、個人の最適値ではない。'
        },
        {
            id: 'kovaak_optimum_as_game_optimum',
            summary: 'KovaaK の最適値をそのままゲーム内の最適値として扱う',
            why: 'Aim テストと実戦は要求が違う。転移の度合いは実測していない。'
        },
        {
            id: 'fabricate_unmeasured_improvement_rate',
            summary: '実測していない改善率を生成する',
            why: '数字が付くと実証済みに見える。根拠の無い数値は推奨全体の信頼を壊す。'
        },
        {
            id: 'generate_game_optimum_without_ingame_evidence',
            summary: 'ゲーム内 evidence が無いのに game_optimum を生成する',
            why: 'ゲーム内の最適値はゲーム内の実測からしか出せない。'
        },
        {
            id: 'generate_integrated_recommendation_without_both_layers',
            summary: '2層が揃っていないのに integrated_recommendation を生成する',
            why: '統合とは2つの実測を突き合わせること。片方が無ければ統合ではない。'
        }
    ];

    var PROHIBITED_IDS = PROHIBITED.map(function (p) { return p.id; });

    // ==================================================== 探索戦略（差し替え可能）
    //
    // 「-10% / -5% / 現在 / +5% / +10%」は **既定値であって仕様ではない。**
    // 候補点をロジックに直接書かず、戦略オブジェクトから取り出す。
    // これにより将来 adaptive search へ差し替えても呼び出し側を変えずに済む。

    var SEARCH_STRATEGIES = {
        local_grid_v1: {
            id: 'local_grid_v1',
            kind: 'local_grid',
            available: true,
            maturity: MATURITY.PLANNED,
            offsetsPercent: [-10, -5, 0, 5, 10],
            description: '現在感度の周辺を等間隔で試す。実測が無い段階の出発点としてのみ使う。',
            note: 'この5点は既定値であり、固定仕様ではない。実測が増えたら戦略ごと差し替える。',
            replaceableBy: ['adaptive_bisection_v1', 'model_based_search_v1']
        },
        adaptive_bisection_v1: {
            id: 'adaptive_bisection_v1',
            kind: 'adaptive',
            available: false,
            maturity: MATURITY.PLANNED,
            offsetsPercent: null,
            reason: 'requires_personal_response_points',
            description: '実測点の並びから、次に情報量が大きい感度を選ぶ。'
        },
        model_based_search_v1: {
            id: 'model_based_search_v1',
            kind: 'model_based',
            available: false,
            maturity: MATURITY.PLANNED,
            offsetsPercent: null,
            reason: 'requires_validated_response_model',
            description: '個人の反応モデルから、複数指標のトレードオフを見て次点を選ぶ。'
        }
    };

    /** 設定から戦略を解決する。未知・未実装の指定は既定へ落とす（理由を残す）。 */
    function resolveSearchStrategy(config) {
        var wanted = (config && config.sensitivitySearch && config.sensitivitySearch.strategyId) || null;
        if (wanted && SEARCH_STRATEGIES[wanted]) {
            var s = SEARCH_STRATEGIES[wanted];
            if (s.available) return { strategy: s, fellBack: false, requested: wanted };
            return {
                strategy: SEARCH_STRATEGIES.local_grid_v1, fellBack: true,
                requested: wanted, fallbackReason: s.reason || 'not_available'
            };
        }
        return {
            strategy: SEARCH_STRATEGIES.local_grid_v1, fellBack: wanted !== null,
            requested: wanted, fallbackReason: wanted ? 'unknown_strategy' : null
        };
    }

    /**
     * 候補となる変更率を取り出す。**戦略オブジェクトから取るだけで、ここに数値を書かない。**
     * 呼び出し側が独自の戦略を渡せば、そのとおりの候補が返る。
     */
    function candidateOffsets(strategy) {
        if (!strategy || !Array.isArray(strategy.offsetsPercent)) return [];
        return strategy.offsetsPercent.slice();
    }

    // ==================================================== 1. 感度調整量

    /**
     * sensitivity_delta_recommendation を組み立てる。
     *
     * 実戦解析が未実装の現時点では、どんな入力でも数値の delta は返らない。
     * 「返せない」ことを status と reason で表す。
     */
    function buildSensitivityDelta(input) {
        var i = input || {};
        var current = i.current || null;
        var support = i.support || {};
        var personalPoints = support.personalPoints || 0;
        var gameEvidence = support.gameEvidenceCount || 0;

        var reasons = [];
        if (!current) reasons.push('current_sensitivity_unknown');
        if (personalPoints < 2) reasons.push('insufficient_personal_response_points');
        if (gameEvidence === 0) reasons.push('no_in_game_evidence');

        var status = reasons.length > 0 ? STATUS.WITHHELD : STATUS.QUALITATIVE_ONLY;

        return {
            kind: 'sensitivity_delta_recommendation',
            status: status,
            // 現在の感度。表示のためだけに持つ。
            currentSensitivity: current,
            // 変更率。**実測が無いあいだは null。0 で埋めない。**
            deltaPercent: null,
            // 絶対値の新感度。併記できるが、delta が無ければ当然無い。
            absolute: null,
            // **最終最適値ではなく、次に検証する値である。**
            purpose: PURPOSE_NEXT_TEST,
            isFinalOptimum: false,
            // 導出の内訳。数値を出すときは必ず埋める（audit がここを見る）。
            derivation: null,
            reason: reasons,
            requiredNextEvidence: requiredNextEvidence(support),
            scope: SCOPE ? SCOPE.scopeOf(i.evidence || []) : null,
            prohibited: PROHIBITED_IDS
        };
    }

    /** 次に何が揃えば前へ進めるかを、数えられる形で返す。 */
    function requiredNextEvidence(support) {
        var s = support || {};
        var need = [];
        if ((s.gameEvidenceCount || 0) === 0) {
            need.push({ what: 'in_game_measured_session', have: 0, need: 'unknown_until_engine_defined' });
        }
        if ((s.personalPoints || 0) < 3) {
            need.push({
                what: 'distinct_sensitivity_levels_measured',
                have: s.personalPoints || 0, need: 3
            });
        }
        if ((s.sessionsAtCurrent || 0) < 2) {
            need.push({
                what: 'sessions_at_current_sensitivity',
                have: s.sessionsAtCurrent || 0, need: 2
            });
        }
        return need;
    }

    // ==================================================== 2. 予測される改善

    /**
     * predicted_improvement を組み立てる。
     *
     * **個人データが足りなければ数値予測を作らない。** これは既定の挙動であり、
     * 呼び出し側が強制的に数値を出せる引数を用意しない。
     */
    function buildPredictedImprovement(input) {
        var i = input || {};
        var observed = i.observedResponses || [];   // 実測された「感度→指標」の対応
        var usable = observed.filter(function (o) {
            return o && o.measured === true
                && o.maturity === MATURITY.PRODUCTION_RATED
                && typeof o.observedChange === 'number';
        });

        if (usable.length === 0) {
            return {
                kind: 'predicted_improvement',
                status: STATUS.NOT_GENERATED,
                predictions: [],
                quantificationAllowed: false,
                reason: observed.length === 0
                    ? 'no_measured_response_data'
                    : 'responses_not_production_rated',
                note: '実測していない改善率は作らない。数値が無いことをそのまま示す。',
                prohibited: PROHIBITED_IDS
            };
        }

        // ここへ来るのは実測が揃ってからの将来経路。方向は実測から取り、
        // 数値は「実測された変化」をそのまま根拠として持つ。捏造しない。
        return {
            kind: 'predicted_improvement',
            status: STATUS.QUANTITATIVE,
            predictions: usable.map(function (o) {
                return {
                    metricKey: o.metricKey,
                    direction: o.observedChange < 0 ? 'decrease' : 'increase',
                    magnitude: { value: o.observedChange, unit: o.unit || null },
                    measuredBasis: true,
                    observationCount: o.n || null,
                    basis: o.basis || 'personal_measured_response'
                };
            }),
            quantificationAllowed: true,
            reason: null,
            prohibited: PROHIBITED_IDS
        };
    }

    // ==================================================== 3. 次に試す感度

    /**
     * next_best_sensitivity_test を組み立てる。
     * **最終最適感度とは別物。** 「次の1回で何を試すか」だけを言う。
     */
    function buildNextBestSensitivityTest(input) {
        var i = input || {};
        var current = i.current || null;
        var resolved = resolveSearchStrategy(i.config);
        var offsets = candidateOffsets(resolved.strategy);
        var gates = (i.config && i.config.gates) || {};

        var canQuantify = !!current && (i.support && i.support.personalPoints >= 3);

        var candidates = (!current ? [] : offsets.map(function (pct) {
            return {
                deltaPercent: pct,
                cm360: current.cm360 != null ? round3(current.cm360 * (1 + pct / 100)) : null,
                isCurrent: pct === 0,
                reason: pct === 0 ? 'baseline_for_comparison' : 'local_search_around_current',
                priority: Math.abs(pct)   // 現在に近いものから試す
            };
        }));

        return {
            kind: 'next_best_sensitivity_test',
            // 実戦解析が未実装のあいだは qualitative_only を維持する
            status: canQuantify ? STATUS.QUANTITATIVE : STATUS.QUALITATIVE_ONLY,
            candidates: candidates,
            searchStrategy: {
                id: resolved.strategy.id,
                kind: resolved.strategy.kind,
                fellBack: resolved.fellBack,
                requested: resolved.requested,
                fallbackReason: resolved.fallbackReason || null,
                replaceable: true,
                note: resolved.strategy.note || null
            },
            requiredSessions: gates.minSessionsPerLevel || 2,
            requiredTrials: null,       // 実戦側の試行定義が未確定
            requiredTrialsReason: 'in_game_trial_unit_not_defined',
            // **最終最適感度ではない**ことを型で明示する
            isFinalOptimum: false,
            distinctFrom: 'final_optimal_sensitivity',
            purpose: PURPOSE_NEXT_TEST,
            scope: SCOPE ? SCOPE.scopeOf(i.evidence || []) : null,
            prohibited: PROHIBITED_IDS
        };
    }

    // ============================================ 4. 個人の感度反応カーブ

    /**
     * personal_sensitivity_response_curve を組み立てる。
     *
     * **最初から連続関数を仮定しない。** 実測された点だけを保存し、
     * 補間・回帰は点が十分にあるときだけ「別の層」として付ける。
     */
    function buildResponseCurve(input) {
        var i = input || {};
        var points = (i.points || []).filter(function (p) {
            return p && typeof p.cm360 === 'number' && typeof p.value === 'number';
        });

        var minForInterp = (i.config && i.config.responseCurve
            && i.config.responseCurve.minPointsForInterpolation) || 4;
        var minForRegression = (i.config && i.config.responseCurve
            && i.config.responseCurve.minPointsForRegression) || 5;

        var distinct = {};
        points.forEach(function (p) { distinct[p.cm360] = true; });
        var distinctCount = Object.keys(distinct).length;

        return {
            kind: 'personal_sensitivity_response_curve',
            // 正本は「測った点」。関数ではない。
            representation: 'measured_points',
            metricKey: i.metricKey || null,
            points: points.map(function (p) {
                return {
                    cm360: p.cm360, value: p.value, n: p.n || 1,
                    measured: true, sessionIds: p.sessionIds || null
                };
            }),
            distinctSensitivityLevels: distinctCount,
            interpolation: distinctCount >= minForInterp
                ? { available: true, method: 'piecewise_linear', derived: true }
                : { available: false, reason: 'insufficient_points', have: distinctCount, need: minForInterp },
            regression: distinctCount >= minForRegression
                ? { available: true, method: 'to_be_selected_on_data', derived: true }
                : { available: false, reason: 'insufficient_points', have: distinctCount, need: minForRegression },
            // **個人内データを母集団平均より優先する**
            priority: 'personal_over_population',
            populationPrior: {
                used: false,
                reason: points.length > 0
                    ? 'personal_data_takes_precedence'
                    : 'not_used_as_personal_optimum',
                allowedUse: 'display_context_only'
            },
            prohibited: PROHIBITED_IDS
        };
    }

    // ==================================== KovaaK と実戦を別モデルで保持する

    /**
     * 反応モデルは2つに分けて持つ。**混ぜない。**
     * 混ぜないからこそ、将来その差（transfer_gap）を測ることができる。
     */
    function responseModels(evidence) {
        var counts = { mechanical: 0, game: 0 };
        (evidence || []).forEach(function (e) {
            var l = SCOPE ? SCOPE.layerOfSourceType(e.sourceType) : null;
            if (l === 'mechanical_aim') counts.mechanical++;
            else if (l === 'game_specific_performance') counts.game++;
        });

        var mechAvailable = counts.mechanical > 0;
        var gameAvailable = counts.game > 0;

        return {
            kind: 'sensitivity_response_models',
            models: {
                kovaak_mechanical_response: {
                    id: 'kovaak_mechanical_response',
                    layer: 'mechanical_aim',
                    available: mechAvailable,
                    evidenceCount: counts.mechanical,
                    measures: 'aim_test_response_to_sensitivity_change'
                },
                game_specific_response: {
                    id: 'game_specific_response',
                    layer: 'game_specific_performance',
                    available: gameAvailable,
                    evidenceCount: counts.game,
                    measures: 'in_game_response_to_sensitivity_change',
                    reason: gameAvailable ? null : 'no_in_game_evidence'
                }
            },
            merged: false,
            mergeProhibited: true,
            mergeProhibitedReason:
                '2つを1つのモデルにまとめると、その差である transfer_gap を測れなくなる。',
            transferGap: {
                available: false,
                requires: ['kovaak_mechanical_response', 'game_specific_response'],
                have: (mechAvailable ? 1 : 0) + (gameAvailable ? 1 : 0),
                reason: gameAvailable ? 'model_not_defined' : 'requires_game_specific_response',
                definition: 'Aim テスト上の最適値と、ゲーム内の最適値の差。'
                    + '**仮定して埋めるものではなく、両方を実測して初めて出る量。**',
                mustBeMeasured: true
            }
        };
    }

    // ==================================== 将来の Recommendation の表示契約

    /**
     * 実戦解析が実装されたときに、画面へ出す推奨が満たすべき項目。
     * いまはどれも値を持たないが、**形だけ先に決めておく**ことで
     * 後から場当たりに項目が増えるのを防ぐ。
     */
    var RECOMMENDATION_VIEW_CONTRACT = {
        kind: 'sensitivity_recommendation_view_contract',
        version: '1',
        requiredFields: [
            'currentSensitivity',      // いまの感度
            'recommendedDeltaPercent', // 変更率
            'nextTestSensitivity',     // 次に試す感度
            'predictedMetricChanges',  // 予測される指標の変化（無ければ空）
            'confidence',              // 確からしさ
            'evidenceCount',           // 根拠の件数
            'reason',                  // なぜそう言えるのか
            'requiredNextEvidence'     // 次に何が要るのか
        ],
        alwaysRequired: ['scope', 'isFinalOptimum', 'purpose'],
        invariants: {
            isFinalOptimum: false,
            purpose: PURPOSE_NEXT_TEST
        },
        generatable: false,
        generatableReason: 'in_game_analysis_not_implemented'
    };

    // ==================================================== 監査

    function round3(x) { return Math.round(x * 1000) / 1000; }

    function walkFind(payload, pred) {
        var hits = [];
        (function walk(v, at) {
            if (v === null || typeof v !== 'object') return;
            if (Array.isArray(v)) { v.forEach(function (x, n) { walk(x, at + '[' + n + ']'); }); return; }
            if (pred(v)) hits.push(at);
            Object.keys(v).forEach(function (k) { walk(v[k], at + '.' + k); });
        })(payload, '$');
        return hits;
    }

    /**
     * 禁止事項に触れていないかを機械的に検査する。
     * 「文書に書いた」だけでは守られない。テストがここを叩く。
     */
    function auditSensitivityRecommendation(payload) {
        var v = [];
        function bad(rule, at, detail) { v.push({ rule: rule, at: at, detail: detail }); }

        // 既存の禁止 key（ゲーム内の強さへの変換）も併せて見る
        if (SCOPE) {
            var base = SCOPE.auditRecommendation(payload);
            base.offendingKeys.forEach(function (k) {
                bad('kovaak_optimum_as_game_optimum', k, '推奨の出力に禁止された key がある');
            });
        }

        // --- 最終最適値を名乗らせない
        walkFind(payload, function (o) { return o.isFinalOptimum === true; })
            .forEach(function (at) {
                bad('declare_optimum_from_single_match', at,
                    'isFinalOptimum が true。推奨は常に「次に検証する値」である');
            });
        walkFind(payload, function (o) {
            return typeof o.purpose === 'string' && o.kind === 'sensitivity_delta_recommendation'
                && o.purpose !== PURPOSE_NEXT_TEST;
        }).forEach(function (at) {
            bad('declare_optimum_from_single_match', at, 'purpose が next_verification_value ではない');
        });

        // --- 単一指標からの単純比例
        walkFind(payload, function (o) {
            return o.kind === 'sensitivity_delta_recommendation' && o.derivation
                && o.derivation.method === 'proportional_to_single_metric';
        }).forEach(function (at) {
            bad('proportional_delta_from_single_metric', at, 'derivation.method が単純比例');
        });
        walkFind(payload, function (o) {
            if (o.kind !== 'sensitivity_delta_recommendation') return false;
            if (typeof o.deltaPercent !== 'number' || o.deltaPercent === 0) return false;
            var d = o.derivation;
            if (!d || !Array.isArray(d.inputs) || d.inputs.length !== 1) return false;
            var only = d.inputs[0];
            return typeof only.valuePercent === 'number'
                && Math.abs(only.valuePercent) === Math.abs(o.deltaPercent);
        }).forEach(function (at) {
            bad('proportional_delta_from_single_metric', at,
                '単一入力の割合と変更率が一致している。比例で決めた疑いがある');
        });

        // --- 実測の無い数値を出さない
        walkFind(payload, function (o) {
            return o.kind === 'predicted_improvement' && Array.isArray(o.predictions)
                && o.predictions.some(function (p) {
                    return p && p.magnitude && p.magnitude.value != null && p.measuredBasis !== true;
                });
        }).forEach(function (at) {
            bad('fabricate_unmeasured_improvement_rate', at,
                '実測にもとづかない改善率が入っている');
        });

        // --- 母集団平均を個人の最適値にしない
        walkFind(payload, function (o) {
            return o.populationPrior && o.populationPrior.used === true
                && o.populationPrior.allowedUse !== 'display_context_only';
        }).forEach(function (at) {
            bad('population_average_as_personal_optimum', at,
                '母集団平均を個人の最適値として使っている');
        });
        walkFind(payload, function (o) {
            return o.kind === 'sensitivity_delta_recommendation' && o.derivation
                && o.derivation.method === 'population_average';
        }).forEach(function (at) {
            bad('population_average_as_personal_optimum', at, 'derivation.method が母集団平均');
        });

        // --- ゲーム内 evidence が無いのに game_optimum / integrated を出さない
        walkFind(payload, function (o) {
            return o.kind === 'sensitivity_response_models'
                && o.transferGap && o.transferGap.available === true
                && o.models && o.models.game_specific_response
                && o.models.game_specific_response.available !== true;
        }).forEach(function (at) {
            bad('generate_game_optimum_without_ingame_evidence', at,
                '実戦モデルが無いのに transfer_gap を出している');
        });
        walkFind(payload, function (o) {
            return o.kind === 'sensitivity_response_models' && o.merged === true;
        }).forEach(function (at) {
            bad('kovaak_optimum_as_game_optimum', at,
                '2つの反応モデルを統合している。差を測れなくなる');
        });
        walkFind(payload, function (o) {
            return o.gameOptimum && o.gameOptimum.available === true
                && (o.gameEvidenceCount === 0 || o.gameEvidenceCount == null);
        }).forEach(function (at) {
            bad('generate_game_optimum_without_ingame_evidence', at,
                'ゲーム内 evidence が 0 なのに game_optimum が available');
        });
        walkFind(payload, function (o) {
            return o.integratedRecommendation && o.integratedRecommendation.available === true;
        }).forEach(function (at) {
            bad('generate_integrated_recommendation_without_both_layers', at,
                '2層が揃っていないのに統合推奨が available');
        });

        return { clean: v.length === 0, violations: v };
    }

    // ==================================== 将来 metric の状態（生成ブロック）
    //
    // 正本は metrics.json の planned_metrics。手で編集しない。
    // `node tools/sync-metrics.mjs` が書き戻し、CI が --check で差分を検出する。
    // **これらは production-rated ではないので、推奨を駆動してはいけない。**

    /* PLANNED_METRICS:BEGIN */
var PLANNED_METRICS = {
        plannedVersion: "0.1.0",
        metrics: [
            {"metric_key":"ingame.flick_overshoot","source":"ingame","category":"engagement","maturity":"planned","target_layer":"game_specific_performance","recommendation_eligible":false,"unit_status":"candidate","measurement_requirements":["yaw/pitch の時系列（視点角のログ）","発砲イベントのタイムスタンプ","ターゲット位置の真値（または同等の参照）","サンプリング周波数の記録","取得手段（ゲーム側API・リプレイ解析・録画解析）の確立"],"blocks":"production_rating_until_measured","role":"performance","higher_is_better":false,"concept":"flick_accuracy","unit":"degree","data_type":"number","description":"フリックで目標を通り越した量。感度が高すぎる兆候として使える可能性がある。","status_reason":"未実測。角度で測るか、フリック角に対する割合で測るかも未確定。","open_questions":["絶対角度と相対割合のどちらを正本にするか","通り越しと補正の切り分け基準"]},
            {"metric_key":"ingame.flick_undershoot","source":"ingame","category":"engagement","maturity":"planned","target_layer":"game_specific_performance","recommendation_eligible":false,"unit_status":"candidate","measurement_requirements":["yaw/pitch の時系列（視点角のログ）","発砲イベントのタイムスタンプ","ターゲット位置の真値（または同等の参照）","サンプリング周波数の記録","取得手段（ゲーム側API・リプレイ解析・録画解析）の確立"],"blocks":"production_rating_until_measured","role":"performance","higher_is_better":false,"concept":"flick_accuracy","unit":"degree","data_type":"number","description":"フリックで目標に届かなかった量。感度が低すぎる兆候として使える可能性がある。","status_reason":"未実測。overshoot と対称に扱えるかは未検証。","open_questions":["overshoot と同じ単位で扱えるか"]},
            {"metric_key":"ingame.acquisition_time","source":"ingame","category":"engagement","maturity":"planned","target_layer":"game_specific_performance","recommendation_eligible":false,"unit_status":"candidate","measurement_requirements":["yaw/pitch の時系列（視点角のログ）","発砲イベントのタイムスタンプ","ターゲット位置の真値（または同等の参照）","サンプリング周波数の記録","取得手段（ゲーム側API・リプレイ解析・録画解析）の確立"],"blocks":"production_rating_until_measured","role":"performance","higher_is_better":false,"concept":"speed","unit":"millisecond","data_type":"number","description":"目標に狙いを合わせるまでの時間。","status_reason":"未実測。「合った」と判定する閾値が未定義。","open_questions":["合致judgeの角度閾値","静止目標と移動目標で定義を分けるか"]},
            {"metric_key":"ingame.correction_count","source":"ingame","category":"engagement","maturity":"planned","target_layer":"game_specific_performance","recommendation_eligible":false,"unit_status":"candidate","measurement_requirements":["yaw/pitch の時系列（視点角のログ）","発砲イベントのタイムスタンプ","ターゲット位置の真値（または同等の参照）","サンプリング周波数の記録","取得手段（ゲーム側API・リプレイ解析・録画解析）の確立"],"blocks":"production_rating_until_measured","role":"performance","higher_is_better":false,"concept":"flick_accuracy","unit":"count","data_type":"integer","description":"狙いを合わせるまでに要した修正動作の回数。","status_reason":"未実測。何を1回の修正と数えるかが未定義。","open_questions":["方向反転を修正と数えるか","微小な揺れを除くノイズ処理"]},
            {"metric_key":"ingame.crosshair_error_first_shot","source":"ingame","category":"engagement","maturity":"planned","target_layer":"game_specific_performance","recommendation_eligible":false,"unit_status":"candidate","measurement_requirements":["yaw/pitch の時系列（視点角のログ）","発砲イベントのタイムスタンプ","ターゲット位置の真値（または同等の参照）","サンプリング周波数の記録","取得手段（ゲーム側API・リプレイ解析・録画解析）の確立"],"blocks":"production_rating_until_measured","role":"performance","higher_is_better":false,"concept":"accuracy","unit":"degree","data_type":"number","description":"最初の1発を撃った瞬間の、目標中心からの角度誤差。","status_reason":"未実測。発砲イベントと視点角の時刻同期が必要。","open_questions":["ヒットボックス基準か中心基準か"]},
            {"metric_key":"ingame.tracking_lag","source":"ingame","category":"engagement","maturity":"planned","target_layer":"game_specific_performance","recommendation_eligible":false,"unit_status":"candidate","measurement_requirements":["yaw/pitch の時系列（視点角のログ）","発砲イベントのタイムスタンプ","ターゲット位置の真値（または同等の参照）","サンプリング周波数の記録","取得手段（ゲーム側API・リプレイ解析・録画解析）の確立"],"blocks":"production_rating_until_measured","role":"performance","higher_is_better":false,"concept":"tracking","unit":"millisecond","data_type":"number","description":"移動する目標に対して、視点が遅れている時間。","status_reason":"未実測。相互相関で求める想定だが窓幅が未定。","open_questions":["遅れの推定方法","目標の急な方向転換をどう扱うか"]},
            {"metric_key":"ingame.tracking_error","source":"ingame","category":"engagement","maturity":"planned","target_layer":"game_specific_performance","recommendation_eligible":false,"unit_status":"candidate","measurement_requirements":["yaw/pitch の時系列（視点角のログ）","発砲イベントのタイムスタンプ","ターゲット位置の真値（または同等の参照）","サンプリング周波数の記録","取得手段（ゲーム側API・リプレイ解析・録画解析）の確立"],"blocks":"production_rating_until_measured","role":"performance","higher_is_better":false,"concept":"tracking","unit":"degree","data_type":"number","description":"追跡中の目標中心からの角度誤差。","status_reason":"未実測。平均で見るか RMS で見るかが未確定。","open_questions":["平均 / RMS / 分位のどれを正本にするか"]},
            {"metric_key":"ingame.target_relative_velocity","source":"ingame","category":"engagement","maturity":"planned","target_layer":"game_specific_performance","recommendation_eligible":false,"unit_status":"candidate","measurement_requirements":["yaw/pitch の時系列（視点角のログ）","発砲イベントのタイムスタンプ","ターゲット位置の真値（または同等の参照）","サンプリング周波数の記録","取得手段（ゲーム側API・リプレイ解析・録画解析）の確立"],"blocks":"production_rating_until_measured","role":"context_dimension","higher_is_better":null,"concept":"condition","unit":"degree_per_second","data_type":"number","description":"自分から見た目標の角速度。難易度の条件であって、成績ではない。","status_reason":"未実測。**性能指標ではなく条件の軸**として使う。","open_questions":["どの区間の平均を取るか"]},
            {"metric_key":"ingame.flick_angle","source":"ingame","category":"engagement","maturity":"planned","target_layer":"game_specific_performance","recommendation_eligible":false,"unit_status":"candidate","measurement_requirements":["yaw/pitch の時系列（視点角のログ）","発砲イベントのタイムスタンプ","ターゲット位置の真値（または同等の参照）","サンプリング周波数の記録","取得手段（ゲーム側API・リプレイ解析・録画解析）の確立"],"blocks":"production_rating_until_measured","role":"context_dimension","higher_is_better":null,"concept":"condition","unit":"degree","data_type":"number","description":"フリックの移動角。難易度の条件であって、成績ではない。","status_reason":"未実測。比較を同条件に揃えるための軸として使う。","open_questions":["開始点の定義"]},
            {"metric_key":"ingame.flick_direction_lr","source":"ingame","category":"engagement","maturity":"planned","target_layer":"game_specific_performance","recommendation_eligible":false,"unit_status":"candidate","measurement_requirements":["yaw/pitch の時系列（視点角のログ）","発砲イベントのタイムスタンプ","ターゲット位置の真値（または同等の参照）","サンプリング周波数の記録","取得手段（ゲーム側API・リプレイ解析・録画解析）の確立"],"blocks":"production_rating_until_measured","role":"context_dimension","higher_is_better":null,"concept":"condition","unit":"enum","data_type":"string","enum_values":["left","right"],"description":"フリックの左右方向。左右差を見るための軸。","status_reason":"未実測。左右差が感度で変わるかは未検証。","open_questions":["上下方向も同様に持つべきか"]},
            {"metric_key":"ingame.flick_angle_bucket","source":"ingame","category":"engagement","maturity":"planned","target_layer":"game_specific_performance","recommendation_eligible":false,"unit_status":"candidate","measurement_requirements":["yaw/pitch の時系列（視点角のログ）","発砲イベントのタイムスタンプ","ターゲット位置の真値（または同等の参照）","サンプリング周波数の記録","取得手段（ゲーム側API・リプレイ解析・録画解析）の確立"],"blocks":"production_rating_until_measured","role":"context_dimension","higher_is_better":null,"concept":"condition","unit":"enum","data_type":"string","enum_values":["micro","medium","large"],"description":"フリック角の区分。区分ごとに最適感度が違う可能性があるため軸として持つ。","status_reason":"未実測。**区切りの角度は未定。実データを見てから決める。**","open_questions":["境界値をどこに置くか","ゲームごとに変えるべきか"]},
            {"metric_key":"ingame.stability_after_acquisition","source":"ingame","category":"engagement","maturity":"planned","target_layer":"game_specific_performance","recommendation_eligible":false,"unit_status":"candidate","measurement_requirements":["yaw/pitch の時系列（視点角のログ）","発砲イベントのタイムスタンプ","ターゲット位置の真値（または同等の参照）","サンプリング周波数の記録","取得手段（ゲーム側API・リプレイ解析・録画解析）の確立"],"blocks":"production_rating_until_measured","role":"performance","higher_is_better":false,"concept":"stability","unit":"degree","data_type":"number","description":"狙いが合った後の、視点の揺れの大きさ。","status_reason":"未実測。評価する時間窓が未定義。","open_questions":["合致後どれだけの時間を見るか"]},
            {"metric_key":"ingame.first_shot_timing","source":"ingame","category":"engagement","maturity":"planned","target_layer":"game_specific_performance","recommendation_eligible":false,"unit_status":"candidate","measurement_requirements":["yaw/pitch の時系列（視点角のログ）","発砲イベントのタイムスタンプ","ターゲット位置の真値（または同等の参照）","サンプリング周波数の記録","取得手段（ゲーム側API・リプレイ解析・録画解析）の確立"],"blocks":"production_rating_until_measured","role":"performance","higher_is_better":false,"concept":"speed","unit":"millisecond","data_type":"number","description":"目標が見えてから最初の1発を撃つまでの時間。","status_reason":"未実測。速さだけを最適化すると命中率と衝突するため、単独で推奨を駆動させてはいけない。","open_questions":["命中率とのトレードオフをどう扱うか"]}
        ]
    };
/* PLANNED_METRICS:END */

    function plannedMetric(key) {
        var found = null;
        PLANNED_METRICS.metrics.forEach(function (m) {
            if (m.metric_key === key) found = m;
        });
        return found;
    }

    /** production-rated でない metric が推奨を駆動していないかを見る。 */
    function assertNotDriving(metricKeys) {
        var offenders = [];
        (metricKeys || []).forEach(function (k) {
            var p = plannedMetric(k);
            if (p) offenders.push({ metricKey: k, maturity: p.maturity });
        });
        return { clean: offenders.length === 0, offenders: offenders };
    }

    root.LC_SENS_REC = {
        STATUS: STATUS,
        MATURITY: MATURITY,
        PURPOSE_NEXT_TEST: PURPOSE_NEXT_TEST,
        PROHIBITED: PROHIBITED,
        PROHIBITED_IDS: PROHIBITED_IDS,
        SEARCH_STRATEGIES: SEARCH_STRATEGIES,
        RECOMMENDATION_VIEW_CONTRACT: RECOMMENDATION_VIEW_CONTRACT,
        PLANNED_METRICS: PLANNED_METRICS,
        resolveSearchStrategy: resolveSearchStrategy,
        candidateOffsets: candidateOffsets,
        buildSensitivityDelta: buildSensitivityDelta,
        buildPredictedImprovement: buildPredictedImprovement,
        buildNextBestSensitivityTest: buildNextBestSensitivityTest,
        buildResponseCurve: buildResponseCurve,
        responseModels: responseModels,
        requiredNextEvidence: requiredNextEvidence,
        plannedMetric: plannedMetric,
        assertNotDriving: assertNotDriving,
        auditSensitivityRecommendation: auditSensitivityRecommendation
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
