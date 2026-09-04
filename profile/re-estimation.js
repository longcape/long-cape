/**
 * Sensitivity Re-estimation Engine — Phase F prototype
 * ====================================================
 *
 * Multi-source Evidence から、検証済み感度水準ごとの成績を比較して
 * 推奨 cm/360 と推奨レンジを再推定する汎用エンジン。
 *
 * 【禁止事項（Phase F の指示）】
 *   - 単純な最高Score選択をしない
 *   - KovaaK の未解決感度値を使わない（検証済み感度水準のみを対象にする）
 *   - データが存在しない指標を捏造しない（unavailable として明示する）
 *   - 本番DB・本番Recommendationへ反映しない
 *
 * 【使ってよい Evidence】
 *   Metric Registry が recommendation_eligible かつ rated と定義したものだけ。
 *   unrated は「情報としては存在する」が推奨計算の重みは 0。
 *
 * 【証拠不足のとき】
 *   無理に感度を出さず status='withheld' とし、何が不足しているかを返す。
 */
(function (root) {
    'use strict';

    var ALGORITHM_VERSION = '0.1.0';

    var DEFAULT_CONFIG = {
        // 推奨を出す最低条件
        minSensitivityLevels: 3,       // 比較には最低3水準
        minSessionsPerLevel: 2,
        minTotalSessions: 6,

        // 合成スコアの重み（performance だけで決めない）
        factorWeights: {
            performance: 0.45,
            stability: 0.25,
            repeatability: 0.20,
            recency: 0.10
        },

        // 推奨レンジ: 最良水準のスコアからこの割合以内を「実用的に同等」とみなす
        rangeTolerance: 0.05,

        recencyHalfLifeDays: 30
    };

    function cfg(config, key) {
        return (config && config[key] !== undefined) ? config[key] : DEFAULT_CONFIG[key];
    }

    function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
    function stdev(a) {
        if (a.length < 2) return null;
        var m = mean(a);
        return Math.sqrt(a.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / (a.length - 1));
    }
    function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

    function parseTs(ts) {
        if (!ts) return null;
        var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(ts);
        return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
    }

    // ------------------------------------------------------- 使える Evidence

    /**
     * 推奨計算に使ってよい evidence だけを抜き出す。
     * Registry が recommendation_eligible かつ rated と定義したものに限る。
     */
    function selectUsableEvidence(evidence) {
        var usable = [], excluded = {};
        (evidence || []).forEach(function (e) {
            if (e.recommendationEligible === true && e.reliabilityStatus === 'rated'
                && typeof e.recommendationWeight === 'number' && e.recommendationWeight > 0) {
                usable.push(e);
            } else {
                var reason = e.registered === false ? 'metric_not_registered'
                    : (e.reliabilityStatus !== 'rated' ? 'unrated' : 'not_recommendation_eligible');
                excluded[reason] = (excluded[reason] || 0) + 1;
            }
        });
        return { usable: usable, excludedCounts: excluded };
    }

    // --------------------------------------------------- 水準ごとの集計

    /**
     * セッションを検証済み感度水準へ束ねる。
     * 未検証のセッションは対象外にする（推測しない）。
     */
    function groupByLevel(sessions, levelResolver) {
        var groups = {}, unknown = 0;
        (sessions || []).forEach(function (s) {
            var lv = levelResolver(s);
            if (!lv || lv.status !== 'known') { unknown++; return; }
            var key = String(lv.cm360);
            groups[key] = groups[key] || { cm360: lv.cm360, origin: lv.origin, sessions: [] };
            groups[key].sessions.push(s);
        });
        return { groups: groups, unknownSessionCount: unknown };
    }

    /**
     * 1水準ぶんの各因子を算出する。
     * **データが無い因子は 0 にせず available:false として返す。捏造しない。**
     */
    function computeFactors(group, usableEvidence, config, nowTs) {
        var ids = {};
        group.sessions.forEach(function (s) { ids[s.externalId] = true; });

        var ev = usableEvidence.filter(function (e) { return ids[e.sessionId]; });

        // 主指標: comparability_group ごとに分けて扱う（名前が似ていても混ぜない）
        var byGroup = {};
        ev.forEach(function (e) {
            var g = e.comparabilityGroup || e.metricKey;
            (byGroup[g] = byGroup[g] || []).push(e);
        });

        // 最も観測数の多い comparability_group を主指標にする
        var primaryKey = null, primaryList = [];
        for (var g in byGroup) {
            if (byGroup[g].length > primaryList.length) { primaryKey = g; primaryList = byGroup[g]; }
        }

        var values = primaryList.map(function (e) { return e.value; }).filter(function (v) {
            return typeof v === 'number' && isFinite(v);
        });

        var factors = {};

        // performance: 主指標の平均（水準間で相対化するのは呼び出し側）
        factors.performance = values.length
            ? { available: true, value: mean(values), n: values.length, metricGroup: primaryKey }
            : { available: false, reason: 'no_usable_metric_values' };

        // stability: 変動係数の逆。2件未満では算出しない
        var sd = stdev(values);
        var mn = mean(values);
        factors.stability = (sd !== null && mn) // mn が 0 でない
            ? { available: true, cv: sd / Math.abs(mn), n: values.length }
            : { available: false, reason: values.length < 2 ? 'need_at_least_2_observations' : 'mean_is_zero' };

        // repeatability: セッション間の再現性。セッションが2件未満では算出しない
        var perSession = {};
        primaryList.forEach(function (e) {
            if (typeof e.value !== 'number') return;
            (perSession[e.sessionId] = perSession[e.sessionId] || []).push(e.value);
        });
        var sessionMeans = Object.keys(perSession).map(function (k) { return mean(perSession[k]); });
        var sdSession = stdev(sessionMeans);
        var mnSession = mean(sessionMeans);
        factors.repeatability = (sdSession !== null && mnSession)
            ? { available: true, cv: sdSession / Math.abs(mnSession), sessionCount: sessionMeans.length }
            : { available: false, reason: 'need_at_least_2_sessions' };

        // recency
        var times = group.sessions.map(function (s) { return parseTs(s.localTimestamp); })
            .filter(function (t) { return t !== null; });
        if (times.length && nowTs !== null) {
            var latest = Math.max.apply(null, times);
            var ageDays = Math.max(0, (nowTs - latest) / 86400000);
            factors.recency = {
                available: true,
                value: clamp01(Math.pow(0.5, ageDays / cfg(config, 'recencyHalfLifeDays'))),
                ageDays: Math.round(ageDays * 10) / 10
            };
        } else {
            factors.recency = { available: false, reason: 'no_parsable_timestamp' };
        }

        // --- 現時点でデータが無い因子。捏造せず unavailable として明示する
        factors.fatigue = { available: false, reason: 'no_intra_session_timeseries' };
        factors.peakPerformance = { available: false, reason: 'no_intra_session_timeseries' };
        factors.longSessionPerformance = { available: false, reason: 'no_session_duration_series' };

        return {
            cm360: group.cm360,
            origin: group.origin,
            sessionCount: group.sessions.length,
            observationCount: values.length,
            sourceTypes: (function () {
                var st = {};
                ev.forEach(function (e) { if (e.sourceType) st[e.sourceType] = true; });
                return Object.keys(st);
            })(),
            factors: factors
        };
    }

    // ------------------------------------------------------------ 合成

    /**
     * 水準を横断して合成スコアを作る。
     * **単純な最高値選択をしない。** performance に加え stability / repeatability /
     * recency を重み付けし、利用できない因子は重みごと除外する（0扱いにしない）。
     */
    function scoreLevels(levels, config) {
        var perfVals = levels.map(function (l) {
            return l.factors.performance.available ? l.factors.performance.value : null;
        }).filter(function (v) { return v !== null; });

        if (perfVals.length === 0) return [];

        var pMin = Math.min.apply(null, perfVals), pMax = Math.max.apply(null, perfVals);
        var span = pMax - pMin;

        var w = cfg(config, 'factorWeights');

        return levels.map(function (l) {
            var parts = {}, used = 0, total = 0;

            if (l.factors.performance.available) {
                parts.performance = span > 0 ? (l.factors.performance.value - pMin) / span : 1;
                total += w.performance * parts.performance; used += w.performance;
            }
            if (l.factors.stability.available) {
                // 変動係数が小さいほど良い。0.30 を上限として正規化
                parts.stability = clamp01(1 - (l.factors.stability.cv / 0.30));
                total += w.stability * parts.stability; used += w.stability;
            }
            if (l.factors.repeatability.available) {
                parts.repeatability = clamp01(1 - (l.factors.repeatability.cv / 0.30));
                total += w.repeatability * parts.repeatability; used += w.repeatability;
            }
            if (l.factors.recency.available) {
                parts.recency = l.factors.recency.value;
                total += w.recency * parts.recency; used += w.recency;
            }

            return {
                cm360: l.cm360,
                composite: used > 0 ? total / used : null,
                parts: parts,
                usedWeight: Math.round(used * 1000) / 1000,
                detail: l
            };
        }).filter(function (x) { return x.composite !== null; })
            .sort(function (a, b) { return b.composite - a.composite; });
    }

    // ------------------------------------------------------- 推奨の生成

    /**
     * @param {object} input
     *   sessions[]            Normalized Session
     *   evidence[]            LC_PROFILE.buildEvidence の出力
     *   levelResolver(s)      検証済み感度水準を返す関数
     *   previous              前回の推奨（差分理由の算出用・任意）
     *   configVersion         参照した設定の版
     *   now                   基準時刻（ISO）
     */
    function reestimate(input, config) {
        input = input || {};
        var sessions = input.sessions || [];
        var nowTs = parseTs(input.now) || null;

        var sel = selectUsableEvidence(input.evidence);
        var grouped = groupByLevel(sessions, input.levelResolver);
        var levelKeys = Object.keys(grouped.groups);

        var levels = levelKeys.map(function (k) {
            return computeFactors(grouped.groups[k], sel.usable, config, nowTs);
        }).sort(function (a, b) { return a.cm360 - b.cm360; });

        var sourceMix = {};
        sel.usable.forEach(function (e) {
            if (e.sourceType) sourceMix[e.sourceType] = (sourceMix[e.sourceType] || 0) + 1;
        });

        // ---- 証拠不足の判定
        var insufficient = [];
        if (sel.usable.length === 0) {
            insufficient.push({
                code: 'no_usable_evidence',
                message: '推奨計算に使える evidence がありません（rated かつ recommendation_eligible のもののみ使用）',
                excluded: sel.excludedCounts
            });
        }
        if (levels.length < cfg(config, 'minSensitivityLevels')) {
            insufficient.push({
                code: 'insufficient_sensitivity_levels',
                message: '検証済みの感度水準が ' + levels.length + ' しかありません（最低 '
                    + cfg(config, 'minSensitivityLevels') + ' 水準が必要）',
                have: levels.length, need: cfg(config, 'minSensitivityLevels')
            });
        }
        if (grouped.unknownSessionCount > 0) {
            insufficient.push({
                code: 'unverified_sensitivity_sessions',
                message: grouped.unknownSessionCount + ' 件のセッションは感度が未検証のため対象外にしました',
                count: grouped.unknownSessionCount
            });
        }
        var totalSessions = levels.reduce(function (s, l) { return s + l.sessionCount; }, 0);
        if (totalSessions < cfg(config, 'minTotalSessions')) {
            insufficient.push({
                code: 'insufficient_sessions',
                message: '対象セッションが ' + totalSessions + ' 件しかありません（最低 '
                    + cfg(config, 'minTotalSessions') + ' 件）'
            });
        }
        var thinLevels = levels.filter(function (l) { return l.sessionCount < cfg(config, 'minSessionsPerLevel'); });
        if (thinLevels.length > 0) {
            insufficient.push({
                code: 'thin_levels',
                message: thinLevels.map(function (l) { return l.cm360 + 'cm'; }).join(', ')
                    + ' はセッション数が足りません（各水準に最低 ' + cfg(config, 'minSessionsPerLevel') + ' 件）'
            });
        }

        var base = {
            algorithm_version: ALGORITHM_VERSION,
            config_version: input.configVersion || null,
            generated_at: input.now || null,
            evidence_count: sel.usable.length,
            evidence_excluded: sel.excludedCounts,
            source_mix: sourceMix,
            levels: levels,
            production_ready: false,
            production_ready_reason: 'Phase F prototype。人工データでの検証のみ。'
        };

        // 不足があれば推奨を出さない
        var blocking = insufficient.filter(function (i) {
            return i.code !== 'unverified_sensitivity_sessions';
        });
        if (blocking.length > 0) {
            return Object.assign({}, base, {
                status: 'withheld',
                recommended_cm360: null,
                recommended_range: null,
                confidence: null,
                insufficient_evidence: insufficient,
                change_reason: null,
                message: '証拠が不足しているため推奨を出していません。'
            });
        }

        // ---- 合成して最良水準とレンジを決める
        var ranked = scoreLevels(levels, config);
        var best = ranked[0];
        var tol = cfg(config, 'rangeTolerance');
        var withinTol = ranked.filter(function (r) { return r.composite >= best.composite - tol; })
            .map(function (r) { return r.cm360; }).sort(function (a, b) { return a - b; });

        var range = [withinTol[0], withinTol[withinTol.length - 1]];

        // ---- confidence（推奨に対するもの。Profile completeness とは別概念）
        var conf = buildRecommendationConfidence(levels, ranked, sel, config);

        // ---- 前回との差分理由
        var change = null;
        if (input.previous) {
            change = buildChangeReason(input.previous, {
                recommended_cm360: best.cm360,
                algorithm_version: ALGORITHM_VERSION,
                config_version: input.configVersion || null,
                evidence_count: sel.usable.length
            });
        }

        return Object.assign({}, base, {
            status: 'issued',
            recommended_cm360: best.cm360,
            recommended_range: range,
            confidence: conf,
            ranked: ranked.map(function (r) {
                return { cm360: r.cm360, composite: Math.round(r.composite * 1000) / 1000, parts: r.parts, usedWeight: r.usedWeight };
            }),
            insufficient_evidence: insufficient.length ? insufficient : null,
            change_reason: change
        });
    }

    function buildRecommendationConfidence(levels, ranked, sel, config) {
        var sessionTotal = levels.reduce(function (s, l) { return s + l.sessionCount; }, 0);
        var sub = {
            levelCoverage: clamp01(levels.length / 5),
            volume: clamp01(sessionTotal / 20),
            separation: (function () {
                if (ranked.length < 2) return 0;
                return clamp01((ranked[0].composite - ranked[1].composite) / 0.20);
            })(),
            factorCoverage: (function () {
                var av = 0, tot = 0;
                levels.forEach(function (l) {
                    for (var f in l.factors) {
                        if (!l.factors.hasOwnProperty(f)) continue;
                        tot++; if (l.factors[f].available) av++;
                    }
                });
                return tot ? av / tot : 0;
            })()
        };
        var value = clamp01(0.35 * sub.levelCoverage + 0.30 * sub.volume
            + 0.20 * sub.separation + 0.15 * sub.factorCoverage);

        var caveats = [];
        if (sub.separation < 0.2) caveats.push('上位2水準の差が小さく、実質的に同等の可能性があります');
        if (sub.factorCoverage < 0.6) caveats.push('疲労・ピーク性能・長時間適性のデータがありません');
        if (Object.keys(sel.excludedCounts).length > 0) {
            caveats.push('未評価（unrated）の evidence は推奨計算に使っていません');
        }

        return {
            kind: 'recommendation_confidence',
            value: Math.round(value * 1000) / 1000,
            subscores: sub,
            caveats: caveats,
            note: 'Profile completeness とは別概念。推奨そのものに対する信頼度。'
        };
    }

    /** なぜ前回と推奨が変わったのかを構造化する。 */
    function buildChangeReason(previous, current) {
        var causes = [];
        var delta = (current.recommended_cm360 !== null && previous.recommended_cm360 !== null)
            ? current.recommended_cm360 - previous.recommended_cm360 : null;

        if (previous.algorithm_version !== current.algorithm_version) {
            causes.push({ type: 'algorithm_change', from: previous.algorithm_version, to: current.algorithm_version });
        }
        if (previous.config_version !== current.config_version) {
            causes.push({ type: 'config_change', from: previous.config_version, to: current.config_version });
        }
        if (previous.evidence_count !== current.evidence_count) {
            causes.push({
                type: 'new_evidence',
                from: previous.evidence_count, to: current.evidence_count,
                delta: current.evidence_count - previous.evidence_count
            });
        }
        if (causes.length === 0 && delta === 0) causes.push({ type: 'no_change' });

        return { delta_cm360: delta, causes: causes };
    }

    root.LC_REESTIMATE = {
        ALGORITHM_VERSION: ALGORITHM_VERSION,
        DEFAULT_CONFIG: DEFAULT_CONFIG,
        selectUsableEvidence: selectUsableEvidence,
        groupByLevel: groupByLevel,
        computeFactors: computeFactors,
        scoreLevels: scoreLevels,
        buildChangeReason: buildChangeReason,
        reestimate: reestimate
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
