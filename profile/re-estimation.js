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

    /**
     * 設定は algorithm-config.json（→ LC_ALGO_CONFIG）から取る。
     * コードへ固定しない。呼び出し側が config を渡せば上書きできる。
     */
    function baseConfig(config) {
        if (config) return config;
        if (root.LC_ALGO_CONFIG) return root.LC_ALGO_CONFIG;
        throw new Error('algorithm config が読み込まれていません');
    }
    function gate(config, key) { return baseConfig(config).gates[key]; }
    function weights(config) {
        var w = baseConfig(config).factorWeights, out = {};
        for (var k in w) if (w.hasOwnProperty(k) && k.charAt(0) !== '_') out[k] = w[k];
        return out;
    }

    function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
    function stdev(a) {
        if (a.length < 2) return null;
        var m = mean(a);
        return Math.sqrt(a.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / (a.length - 1));
    }
    function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

    /** 中央値。単一の外れ値に引きずられないようにするため平均の代わりに使う。 */
    function median(a) {
        if (!a.length) return null;
        var v = a.slice().sort(function (x, y) { return x - y; });
        var m = Math.floor(v.length / 2);
        return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
    }

    /** 中央絶対偏差を用いた外れ値の件数。除外はせず、件数を報告する。 */
    function outlierCount(a) {
        if (a.length < 4) return 0;
        var med = median(a);
        var devs = a.map(function (v) { return Math.abs(v - med); });
        var mad = median(devs);
        if (!mad) return 0;
        return a.filter(function (v) { return Math.abs(v - med) / (1.4826 * mad) > 3.5; }).length;
    }

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
        // 単一の外れ値で推奨が動かないよう、代表値は **中央値** を使う。
        // 平均も参考として残すが、合成スコアには中央値を用いる。
        factors.performance = values.length
            ? {
                available: true,
                value: median(values),          // 合成に使う代表値
                statistic: 'median',
                mean: mean(values),             // 参考
                outlierCount: outlierCount(values),
                n: values.length,
                metricGroup: primaryKey
            }
            : { available: false, reason: 'no_usable_metric_values' };

        // stability: 変動係数の逆。2件未満では算出しない
        var sd = stdev(values);
        var center = median(values);
        factors.stability = (sd !== null && center) // center が 0 でない
            ? { available: true, cv: sd / Math.abs(center), center: 'median', n: values.length }
            : { available: false, reason: values.length < 2 ? 'need_at_least_2_observations' : 'center_is_zero' };

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
                value: clamp01(Math.pow(0.5, ageDays / baseConfig(config).recency.halfLifeDays)),
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
            sessionIds: Object.keys(ids),
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

        var w = weights(config);
        var norm = baseConfig(config).normalization;

        return levels.map(function (l) {
            var parts = {}, used = 0, total = 0;

            // 性能を算出できない水準は比較対象にしない。
            // recency だけで順位が付いてしまうのを防ぐ。
            if (!l.factors.performance.available) {
                return { cm360: l.cm360, composite: null, excluded: 'no_performance_data', detail: l };
            }

            if (l.factors.performance.available) {
                parts.performance = span > 0 ? (l.factors.performance.value - pMin) / span : 1;
                total += w.performance * parts.performance; used += w.performance;
            }
            if (l.factors.stability.available) {
                // 変動係数が小さいほど良い。0.30 を上限として正規化
                parts.stability = clamp01(1 - (l.factors.stability.cv / norm.stabilityCvCeiling));
                total += w.stability * parts.stability; used += w.stability;
            }
            if (l.factors.repeatability.available) {
                parts.repeatability = clamp01(1 - (l.factors.repeatability.cv / norm.repeatabilityCvCeiling));
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
        if (levels.length < gate(config, 'minSensitivityLevels')) {
            insufficient.push({
                code: 'insufficient_sensitivity_levels',
                message: '検証済みの感度水準が ' + levels.length + ' しかありません（最低 '
                    + gate(config, 'minSensitivityLevels') + ' 水準が必要）',
                have: levels.length, need: gate(config, 'minSensitivityLevels')
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
        if (totalSessions < gate(config, 'minTotalSessions')) {
            insufficient.push({
                code: 'insufficient_sessions',
                message: '対象セッションが ' + totalSessions + ' 件しかありません（最低 '
                    + gate(config, 'minTotalSessions') + ' 件）'
            });
        }
        var thinLevels = levels.filter(function (l) { return l.sessionCount < gate(config, 'minSessionsPerLevel'); });
        if (thinLevels.length > 0) {
            insufficient.push({
                code: 'thin_levels',
                message: thinLevels.map(function (l) { return l.cm360 + 'cm'; }).join(', ')
                    + ' はセッション数が足りません（各水準に最低 ' + gate(config, 'minSessionsPerLevel') + ' 件）'
            });
        }

        var base = {
            algorithm_version: ALGORITHM_VERSION,
            config_version: baseConfig(config).config_version || null,
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
                sensitivity_coverage: buildSensitivityCoverage(levels, grouped, null, null),
                edge_optimum: null,
                next_best_test: suggestNextTest(levels, [], null, config),
                insufficient_evidence: insufficient,
                change_reason: null,
                message: '証拠が不足しているため推奨を出していません。'
            });
        }

        // ---- 合成して最良水準とレンジを決める
        var ranked = scoreLevels(levels, config);
        var best = ranked[0];

        // rangeCompositeScoreTolerance は「合成スコアの絶対差」。
        // 合成スコアは0〜1に正規化済みなので、これは感度(cm)の割合でも生スコアの割合でもない。
        var tol = baseConfig(config).range.rangeCompositeScoreTolerance;
        var withinTol = ranked.filter(function (r) { return r.composite >= best.composite - tol; })
            .map(function (r) { return r.cm360; }).sort(function (a, b) { return a - b; });

        var range = [withinTol[0], withinTol[withinTol.length - 1]];

        // ---- 曲線端の検出
        var edge = detectEdgeOptimum(levels, best, config);

        // ---- source 間の矛盾
        var conflict = detectSourceConflict(levels, sel.usable, config);

        // ---- 感度被覆（confidence とは別概念として独立させる）
        var coverage = buildSensitivityCoverage(levels, grouped, best, edge);

        // ---- confidence（推奨に対するもの。Profile completeness とは別概念）
        var conf = buildRecommendationConfidence(levels, ranked, sel, config, edge, conflict);

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
            range_definition: baseConfig(config).range._definition,
            confidence: conf,
            sensitivity_coverage: coverage,
            edge_optimum: edge,
            source_conflict: conflict,
            next_best_test: suggestNextTest(levels, ranked, edge, config),
            ranked: ranked.map(function (r) {
                return { cm360: r.cm360, composite: Math.round(r.composite * 1000) / 1000, parts: r.parts, usedWeight: r.usedWeight };
            }),
            insufficient_evidence: insufficient.length ? insufficient : null,
            change_reason: change
        });
    }

    function buildRecommendationConfidence(levels, ranked, sel, config, edge, conflict) {
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

        var penalties = [];
        if (edge && edge.detected) {
            var f = baseConfig(config).edgeOptimum.confidencePenalty;
            value = clamp01(value * f);
            penalties.push({ code: 'edge_optimum', factor: f, side: edge.side });
        }
        if (conflict && conflict.detected) {
            value = clamp01(value * 0.75);
            penalties.push({ code: 'source_conflict', factor: 0.75, sourceTypes: conflict.sourceTypes });
        }

        var caveats = [];
        if (edge && edge.detected) caveats.push(edge.message);
        if (conflict && conflict.detected) caveats.push(conflict.message);
        if (sub.separation < 0.2) caveats.push('上位2水準の差が小さく、実質的に同等の可能性があります');
        if (sub.factorCoverage < 0.6) caveats.push('疲労・ピーク性能・長時間適性のデータがありません');
        if (Object.keys(sel.excludedCounts).length > 0) {
            caveats.push('未評価（unrated）の evidence は推奨計算に使っていません');
        }

        return {
            kind: 'recommendation_confidence',
            value: Math.round(value * 1000) / 1000,
            subscores: sub,
            penalties: penalties,
            caveats: caveats,
            note: 'Profile completeness とは別概念。推奨そのものに対する信頼度。'
        };
    }

    /**
     * source_type ごとに最良水準を求め、食い違いを検出する。
     * 「source A と source B で結果が逆」を黙って平均せず、矛盾として報告する。
     */
    function detectSourceConflict(levels, usableEvidence, config) {
        var bySource = {};
        usableEvidence.forEach(function (e) {
            if (!e.sourceType) return;
            bySource[e.sourceType] = bySource[e.sourceType] || {};
        });
        var types = Object.keys(bySource);
        if (types.length < 2) {
            return { detected: false, reason: 'single_source_type', sourceTypes: types };
        }

        // source_type ごとに水準別の中央値を出し、最良水準を決める
        var bestBySource = {};
        types.forEach(function (t) {
            var best = null;
            levels.forEach(function (l) {
                var vals = usableEvidence.filter(function (e) {
                    return e.sourceType === t
                        && l.sessionIds && l.sessionIds.indexOf(e.sessionId) >= 0
                        && typeof e.value === 'number';
                }).map(function (e) { return e.value; });
                if (!vals.length) return;
                var m = median(vals);
                if (best === null || m > best.value) best = { cm360: l.cm360, value: m };
            });
            if (best) bestBySource[t] = best.cm360;
        });

        var picks = Object.keys(bestBySource).map(function (k) { return bestBySource[k]; });
        var uniq = picks.filter(function (v, i) { return picks.indexOf(v) === i; });

        return {
            detected: uniq.length > 1,
            sourceTypes: types,
            bestBySourceType: bestBySource,
            message: uniq.length > 1
                ? 'データ元によって最良の感度が食い違っています（' +
                  Object.keys(bestBySource).map(function (k) { return k + '→' + bestBySource[k] + 'cm'; }).join(', ') +
                  '）。測定条件の違いを確認してください。'
                : null
        };
    }

    /**
     * 曲線端の検出。
     * 「測定した中では30cmが最高だった」と「真の最適が30cmである」を同一視しない。
     * 最良点が測定範囲の端にあるなら、真の最適は範囲外かもしれない。
     */
    function detectEdgeOptimum(levels, best, config) {
        if (!best || levels.length < 2) {
            return { detected: false, reason: 'not_enough_levels' };
        }
        var cms = levels.map(function (l) { return l.cm360; }).sort(function (a, b) { return a - b; });
        var lo = cms[0], hi = cms[cms.length - 1];

        if (best.cm360 !== lo && best.cm360 !== hi) {
            return { detected: false, testedRange: [lo, hi], bestInside: true };
        }

        var side = best.cm360 === lo ? 'low' : 'high';
        // 測定間隔の中央値ぶんだけ外側を提案する
        var gaps = [];
        for (var i = 1; i < cms.length; i++) gaps.push(cms[i] - cms[i - 1]);
        gaps.sort(function (a, b) { return a - b; });
        var step = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
        var outward = step === null ? null
            : (side === 'low' ? Math.round((lo - step) * 100) / 100 : Math.round((hi + step) * 100) / 100);

        return {
            detected: true,
            side: side,
            testedRange: [lo, hi],
            bestAtEdge: best.cm360,
            suggestedOutward: baseConfig(config).edgeOptimum.suggestOutwardStep ? outward : null,
            message: '最良点が測定範囲の' + (side === 'low' ? '下端' : '上端')
                + '（' + best.cm360 + 'cm）にあります。真の最適が測定範囲の外にある可能性があるため、'
                + (outward !== null ? outward + 'cm 付近も試す必要があります。' : 'さらに外側も試す必要があります。')
        };
    }

    /**
     * 感度被覆。confidence とは別概念として独立して返す。
     */
    function buildSensitivityCoverage(levels, grouped, best, edge) {
        var cms = levels.map(function (l) { return l.cm360; }).sort(function (a, b) { return a - b; });
        var gaps = [];
        for (var i = 1; i < cms.length; i++) gaps.push(Math.round((cms[i] - cms[i - 1]) * 100) / 100);

        var balance = null;
        if (best && cms.length > 1) {
            var below = cms.filter(function (c) { return c < best.cm360; }).length;
            var above = cms.filter(function (c) { return c > best.cm360; }).length;
            balance = {
                below: below, above: above,
                skewed: (below === 0 || above === 0),
                note: (below === 0 || above === 0)
                    ? '最良点の片側にしか測定点がありません'
                    : null
            };
        }

        return {
            kind: 'sensitivity_coverage',
            levelCount: levels.length,
            testedRange: cms.length ? [cms[0], cms[cms.length - 1]] : null,
            levels: cms,
            gaps: gaps,
            unverifiedSessionCount: grouped ? grouped.unknownSessionCount : null,
            balanceAroundBest: balance,
            edgeOptimum: edge ? edge.detected : null
        };
    }

    /**
     * Next Best Test / Active Measurement（設計と最小実装）。
     * 「次にどの感度を何回試せば不確実性を最も減らせるか」を返す。
     * 現時点では定量的な不確実性減少量は算出せず、根拠を qualitative として返す。
     */
    function suggestNextTest(levels, ranked, edge, config) {
        var conf = baseConfig(config).nextBestTest;
        if (!conf.enabled) return null;

        var n = conf.defaultRecommendedSessions;

        // 水準が足りない → まず水準を増やす
        if (levels.length < gate(config, 'minSensitivityLevels')) {
            var cms0 = levels.map(function (l) { return l.cm360; }).sort(function (a, b) { return a - b; });
            var base0 = cms0.length ? cms0[cms0.length - 1] : null;
            return {
                next_test_cm360: base0 === null ? null : Math.round((base0 + 2) * 100) / 100,
                recommended_sessions: n,
                reason: 'increase_level_count',
                detail: '比較できる感度水準が ' + levels.length + ' しかありません。まず水準を増やす必要があります。',
                uncertainty_reduction: 'qualitative_only'
            };
        }

        // 端に最良点 → 外側を試す
        if (edge && edge.detected && edge.suggestedOutward !== null) {
            return {
                next_test_cm360: edge.suggestedOutward,
                recommended_sessions: n,
                reason: 'explore_beyond_edge',
                detail: edge.message,
                uncertainty_reduction: 'qualitative_only'
            };
        }

        // 上位2水準が僅差 → その中間を試して分離する
        if (ranked.length >= 2) {
            var gapTop = ranked[0].composite - ranked[1].composite;
            if (gapTop <= conf.closeContestCompositeGap) {
                var a = ranked[0].cm360, b = ranked[1].cm360;
                var mid = Math.round(((a + b) / 2) * 100) / 100;
                return {
                    next_test_cm360: mid,
                    recommended_sessions: n,
                    reason: 'distinguish_' + Math.min(a, b) + '_vs_' + Math.max(a, b),
                    detail: a + 'cm と ' + b + 'cm の合成スコア差が ' + Math.round(gapTop * 1000) / 1000
                        + ' しかありません。中間の ' + mid + 'cm を試すと切り分けられます。',
                    uncertainty_reduction: 'qualitative_only'
                };
            }
        }

        // それ以外 → 上位水準のうちセッション数が最も少ないものを補強
        var thin = levels.slice().sort(function (x, y) { return x.sessionCount - y.sessionCount; })[0];
        return {
            next_test_cm360: thin ? thin.cm360 : null,
            recommended_sessions: n,
            reason: 'reinforce_thin_level',
            detail: thin ? (thin.cm360 + 'cm のセッションが ' + thin.sessionCount + ' 件と少ないため補強します。') : null,
            uncertainty_reduction: 'qualitative_only'
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

        selectUsableEvidence: selectUsableEvidence,
        groupByLevel: groupByLevel,
        computeFactors: computeFactors,
        scoreLevels: scoreLevels,
        detectEdgeOptimum: detectEdgeOptimum,
        detectSourceConflict: detectSourceConflict,
        median: median,
        buildSensitivityCoverage: buildSensitivityCoverage,
        suggestNextTest: suggestNextTest,
        buildChangeReason: buildChangeReason,
        reestimate: reestimate
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
