/**
 * Multi-source Aim Profile — Phase E prototype
 * ============================================
 *
 * Normalized Aim Session → Session Profile → Evidence → Aim Profile Preview
 *
 * 【source 非依存】
 * このモジュールは KovaaK を知らない。下記の「Normalized Session 契約」だけを知る。
 * Adapter が kovaak / aimlab / aimhero / in_game_range / in_game_match / manual の
 * どれであっても、契約を満たせば Profile 側を作り直さずに追加できる。
 *
 * 【Phase E の禁止事項】
 *   - 本番DB migration / 本番保存 / main merge / production公開
 *   - `Horiz Sens` の正式正規化、cm/360 の自動確定
 *   - 実測からの本番Recommendation変更
 *   - 課金機能化
 *   - **単純平均で Profile を作らない**（重み付けと再推定は後続Phase）
 *
 * ---------------------------------------------------------------------------
 * Normalized Session 契約（Adapter が満たすべき形）
 * ---------------------------------------------------------------------------
 * {
 *   externalId, scenario, localTimestamp, tzKnown, killRowCount,
 *   metrics:  [{ metricKey, value, unit, rawText }],        // session レベル
 *   weapons:  [{ index, weapon, metrics: [...] }],          // weapon レベル（全件）
 *   context:  { dpi, dpiSource, fov, ... },                 // 測定条件
 *   unresolved: [{ field, reason, candidates?, note }],     // 未確定のまま保持
 *   provenance: {
 *     source, sourceType, sourceIdentifier, rawContentHash, rawContentHashAlgo,
 *     logicalFingerprint, parserVersion, normalizationVersion, importedAt, consentId
 *   }
 * }
 */
(function (root) {
    'use strict';

    var PROFILE_ALGORITHM_VERSION = '0.1.0';

    /** 値の由来。開発用プレビューで区別して表示するために付ける。 */
    var VALUE_KIND = {
        RAW: 'raw',                 // 原本にそのまま書かれていた値
        NORMALIZED: 'normalized',   // 型・単位を揃えただけ
        DERIVED: 'derived',         // Long Cape が計算した値
        UNRESOLVED: 'unresolved'    // 確定できていない
    };

    /**
     * source_type ごとの信頼度の重み。
     * コードに埋めず設定として渡せるようにする（Phase B の方針）。
     * 実戦は交絡が多いため既定を最も低くする。
     */
    var DEFAULT_CONFIG = {
        sourceTypeReliability: {
            aim_trainer: 1.00,
            in_game_range: 0.80,
            diagnosis: 0.60,
            manual: 0.50,
            in_game_match: 0.35
        },
        // confidence の飽和点・下限
        volumeSaturationSessions: 20,
        spanSaturationDays: 14,
        conditionCoverageSaturation: 3,   // 感度水準がいくつあれば十分か
        sourceDiversitySaturation: 3,
        recencyHalfLifeDays: 30,
        minSessionsForAnyConfidence: 3,
        // 減点
        penaltySingleSourceType: 0.85,
        penaltySingleSensitivityLevel: 0.60,
        penaltyUnresolvedSensitivity: 0.80,
        penaltyTzUnknownMajority: 0.95,
        // 重み（合計1）
        weights: {
            volume: 0.25,
            span: 0.15,
            conditionCoverage: 0.25,
            sourceDiversity: 0.15,
            recency: 0.10,
            metricCompleteness: 0.10
        }
    };

    function cfg(config, key) {
        return (config && config[key] !== undefined) ? config[key] : DEFAULT_CONFIG[key];
    }

    function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

    function parseLocalTs(ts) {
        if (!ts) return null;
        var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(ts);
        if (!m) return null;
        return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    }

    // ------------------------------------------------------- A. Session Profile

    /**
     * Normalized Session を Profile が扱う形へ写す。
     * **値を作らない。** 未確定は未確定のまま持ち越す。
     */
    function buildSessionProfile(session) {
        var p = session.provenance || {};
        var ctx = session.context || {};

        var fields = {};

        function put(name, value, kind, note) {
            fields[name] = { value: value === undefined ? null : value, kind: kind, note: note || null };
        }

        put('source', p.source, VALUE_KIND.RAW);
        put('sourceType', p.sourceType, VALUE_KIND.RAW);
        put('scenario', session.scenario, VALUE_KIND.RAW);
        put('runTimestamp', session.localTimestamp, VALUE_KIND.RAW,
            session.tzKnown ? null : 'タイムゾーン不明');
        put('durationSec', metricValue(session, ['fight_time']), VALUE_KIND.NORMALIZED);
        put('dpi', ctx.dpi === undefined ? null : ctx.dpi, VALUE_KIND.NORMALIZED,
            'dpiSource=' + (ctx.dpiSource || 'unknown'));
        put('fov', ctx.fov === undefined ? null : ctx.fov, VALUE_KIND.NORMALIZED);

        // 武器は全件。代表を選ばない
        put('weapons', (session.weapons || []).map(function (w) {
            return { weapon: w.weapon, metrics: w.metrics };
        }), VALUE_KIND.NORMALIZED, '集約はDerived層の責務');

        put('score', metricValue(session, ['score']), VALUE_KIND.NORMALIZED);
        put('kills', metricValue(session, ['kills']), VALUE_KIND.NORMALIZED);
        put('hitCount', metricValue(session, ['hit_count']), VALUE_KIND.NORMALIZED);
        put('avgTtk', metricValue(session, ['avg_ttk']), VALUE_KIND.NORMALIZED);

        // accuracy: source が直接持っていれば normalized、無ければ **derived にせず未提供**
        var acc = metricValue(session, ['accuracy']);
        put('accuracy', acc, acc === null ? VALUE_KIND.UNRESOLVED : VALUE_KIND.NORMALIZED,
            acc === null ? 'sourceが直接持っていない。Hits/Shotsからの算出はDerived層（Phase E対象外）' : null);

        // 未確定はそのまま
        (session.unresolved || []).forEach(function (u) {
            fields[u.field] = {
                value: null, kind: VALUE_KIND.UNRESOLVED, note: u.reason,
                candidates: u.candidates || null
            };
        });

        return {
            externalId: session.externalId,
            source: p.source || null,
            sourceType: p.sourceType || null,
            scenario: session.scenario || null,
            runTimestamp: session.localTimestamp || null,
            tzKnown: !!session.tzKnown,
            fields: fields,
            otherMetrics: (session.metrics || []).map(function (m) {
                return { metricKey: m.metricKey, value: m.value, unit: m.unit };
            }),
            provenance: p
        };
    }

    /** metricKey の末尾一致で値を探す（source 非依存にするため接頭辞を問わない）。 */
    function metricValue(session, suffixes) {
        var list = session.metrics || [];
        for (var i = 0; i < list.length; i++) {
            for (var j = 0; j < suffixes.length; j++) {
                var key = list[i].metricKey || '';
                if (key === suffixes[j] || key.slice(-(suffixes[j].length + 1)) === '.' + suffixes[j]) {
                    return list[i].value;
                }
            }
        }
        return null;
    }

    // ---------------------------------------------------------- B. Evidence

    /**
     * Profile に出る数字が「どの実測値から来たか」を逆引きできるようにする。
     * session レベルと weapon レベルの両方を1件ずつ evidence 化する。
     */
    function buildEvidence(sessions, config) {
        var out = [];

        (sessions || []).forEach(function (s) {
            var p = s.provenance || {};
            var relBase = (cfg(config, 'sourceTypeReliability')[p.sourceType] !== undefined)
                ? cfg(config, 'sourceTypeReliability')[p.sourceType] : 0.3;

            function emit(metricKey, value, unit, scope, weapon) {
                out.push({
                    source: p.source || null,
                    sourceType: p.sourceType || null,
                    sessionId: s.externalId,
                    scope: scope,                 // 'session' | 'weapon'
                    weapon: weapon || null,
                    metricKey: metricKey,
                    value: value,
                    unit: unit || null,
                    metricVersion: '1',           // metric_registry 導入後はそこから引く
                    parserVersion: p.parserVersion || null,
                    normalizationVersion: p.normalizationVersion || null,
                    observedAt: s.localTimestamp || null,
                    observedAtTzKnown: !!s.tzKnown,
                    importedAt: p.importedAt || null,
                    rawContentHash: p.rawContentHash || null,
                    valueKind: VALUE_KIND.NORMALIZED,
                    reliability: relBase
                });
            }

            (s.metrics || []).forEach(function (m) { emit(m.metricKey, m.value, m.unit, 'session', null); });
            (s.weapons || []).forEach(function (w) {
                (w.metrics || []).forEach(function (m) { emit(m.metricKey, m.value, m.unit, 'weapon', w.weapon); });
            });
        });

        return out;
    }

    /** 逆引き: Profile に出た metricKey が、どの evidence から来たかを返す。 */
    function traceMetric(evidence, metricKey) {
        return (evidence || []).filter(function (e) { return e.metricKey === metricKey; });
    }

    // ------------------------------------- E. Profile 集約（単純平均をしない）

    /**
     * 感度条件のキー。**in_game_sens が未確定なので確定値では作れない。**
     * 確定できている条件（DPI / FOV）と、未確定の候補セットの文字列表現から
     * 「条件が同じか違うか」だけを判定する。値そのものは確定しない。
     */
    function sensitivityConditionKey(session) {
        var ctx = session.context || {};
        var u = (session.unresolved || []).find(function (x) { return x.field === 'in_game_sens'; });
        var cand = u && u.candidates
            ? u.candidates.map(function (c) { return c.origin + '=' + c.value; }).sort().join(';')
            : 'none';
        return [ctx.dpi === undefined ? 'null' : ctx.dpi, ctx.fov === undefined ? 'null' : ctx.fov, cand].join('|');
    }

    function buildAimProfile(sessions, config) {
        sessions = sessions || [];
        var evidence = buildEvidence(sessions, config);

        var sourceSet = {}, sourceTypeSet = {}, scenarioSet = {}, condSet = {};
        var metricCoverage = {};
        var tzUnknown = 0;
        var timestamps = [];

        sessions.forEach(function (s) {
            var p = s.provenance || {};
            if (p.source) sourceSet[p.source] = true;
            if (p.sourceType) sourceTypeSet[p.sourceType] = true;
            if (s.scenario) scenarioSet[s.scenario] = true;
            condSet[sensitivityConditionKey(s)] = true;
            if (!s.tzKnown) tzUnknown++;
            var t = parseLocalTs(s.localTimestamp);
            if (t !== null) timestamps.push(t);
        });

        // metric coverage は **件数と時間範囲のみ**。平均も推定もしない。
        evidence.forEach(function (e) {
            var c = metricCoverage[e.metricKey] || {
                metricKey: e.metricKey, observationCount: 0, sessions: {},
                sourceTypes: {}, firstObservedAt: null, lastObservedAt: null
            };
            c.observationCount++;
            c.sessions[e.sessionId] = true;
            if (e.sourceType) c.sourceTypes[e.sourceType] = true;
            if (e.observedAt) {
                if (!c.firstObservedAt || e.observedAt < c.firstObservedAt) c.firstObservedAt = e.observedAt;
                if (!c.lastObservedAt || e.observedAt > c.lastObservedAt) c.lastObservedAt = e.observedAt;
            }
            metricCoverage[e.metricKey] = c;
        });

        var coverageList = Object.keys(metricCoverage).map(function (k) {
            var c = metricCoverage[k];
            return {
                metricKey: c.metricKey,
                observationCount: c.observationCount,
                sessionCount: Object.keys(c.sessions).length,
                sourceTypes: Object.keys(c.sourceTypes),
                firstObservedAt: c.firstObservedAt,
                lastObservedAt: c.lastObservedAt,
                note: '件数と期間のみ。平均・推定値は算出していない（後続Phaseの責務）'
            };
        }).sort(function (a, b) { return b.observationCount - a.observationCount; });

        timestamps.sort();
        var spanDays = timestamps.length > 1
            ? (timestamps[timestamps.length - 1] - timestamps[0]) / 86400000 : 0;

        var inventory = {
            sessionCount: sessions.length,
            sourceCount: Object.keys(sourceSet).length,
            sourceTypeCount: Object.keys(sourceTypeSet).length,
            sources: Object.keys(sourceSet),
            sourceTypes: Object.keys(sourceTypeSet),
            scenarioCount: Object.keys(scenarioSet).length,
            scenarios: Object.keys(scenarioSet),
            sensitivityLevelCount: Object.keys(condSet).length,
            metricCoverage: coverageList,
            dataFreshness: {
                earliest: timestamps.length ? new Date(timestamps[0]).toISOString().slice(0, 19) : null,
                latest: timestamps.length ? new Date(timestamps[timestamps.length - 1]).toISOString().slice(0, 19) : null,
                spanDays: Math.round(spanDays * 10) / 10,
                tzKnownForAll: tzUnknown === 0
            }
        };

        return {
            algorithmVersion: PROFILE_ALGORITHM_VERSION,
            inventory: inventory,
            evidence: evidence,
            confidence: buildConfidencePreview(sessions, inventory, config),
            aggregation: {
                performed: false,
                reason: '単純平均を行わない方針。重み付けと再推定は後続Phase'
            }
        };
    }

    // -------------------------------------------------- F. Confidence preview

    /**
     * **本番Recommendationのconfidenceではない。**
     * 「根拠がどれだけ揃っているか」を示す evidence completeness / profile confidence preview。
     */
    function buildConfidencePreview(sessions, inventory, config) {
        var w = cfg(config, 'weights');
        var n = inventory.sessionCount;

        var sub = {
            volume: clamp01(n / cfg(config, 'volumeSaturationSessions')),
            span: clamp01(inventory.dataFreshness.spanDays / cfg(config, 'spanSaturationDays')),
            conditionCoverage: clamp01(inventory.sensitivityLevelCount / cfg(config, 'conditionCoverageSaturation')),
            sourceDiversity: clamp01(inventory.sourceTypeCount / cfg(config, 'sourceDiversitySaturation')),
            recency: 0,
            metricCompleteness: clamp01(inventory.metricCoverage.length / 8)
        };

        // 直近性: 最新データからの経過を半減期で減衰
        if (inventory.dataFreshness.latest) {
            var latest = parseLocalTs(inventory.dataFreshness.latest);
            var ref = (config && config.now) ? parseLocalTs(config.now) : latest;
            var ageDays = latest !== null && ref !== null ? Math.max(0, (ref - latest) / 86400000) : 0;
            sub.recency = clamp01(Math.pow(0.5, ageDays / cfg(config, 'recencyHalfLifeDays')));
        }

        var base = 0;
        for (var k in w) if (w.hasOwnProperty(k)) base += w[k] * (sub[k] || 0);

        var penalties = [];
        var mult = 1;
        if (inventory.sourceTypeCount <= 1) {
            mult *= cfg(config, 'penaltySingleSourceType');
            penalties.push({ code: 'single_source_type', factor: cfg(config, 'penaltySingleSourceType') });
        }
        if (inventory.sensitivityLevelCount <= 1) {
            mult *= cfg(config, 'penaltySingleSensitivityLevel');
            penalties.push({
                code: 'single_sensitivity_level', factor: cfg(config, 'penaltySingleSensitivityLevel'),
                note: '感度を比較していないため「最適」とは言えない'
            });
        }
        var anyUnresolvedSens = sessions.some(function (s) {
            return (s.unresolved || []).some(function (u) { return u.field === 'in_game_sens'; });
        });
        if (anyUnresolvedSens) {
            mult *= cfg(config, 'penaltyUnresolvedSensitivity');
            penalties.push({ code: 'unresolved_sensitivity', factor: cfg(config, 'penaltyUnresolvedSensitivity') });
        }
        if (!inventory.dataFreshness.tzKnownForAll) {
            mult *= cfg(config, 'penaltyTzUnknownMajority');
            penalties.push({ code: 'timezone_unknown', factor: cfg(config, 'penaltyTzUnknownMajority') });
        }

        var value = clamp01(base * mult);
        var belowMinimum = n < cfg(config, 'minSessionsForAnyConfidence');

        var missing = [];
        if (belowMinimum) missing.push('セッションが ' + cfg(config, 'minSessionsForAnyConfidence') + ' 件に満たない（現在 ' + n + ' 件）');
        if (inventory.sensitivityLevelCount <= 1) missing.push('感度水準が1つしかない。別の感度でも測定が必要');
        if (inventory.sourceTypeCount <= 1) missing.push('データ元が1種類しかない');
        if (anyUnresolvedSens) missing.push('in_game_sens が未確定（実ファイル検証待ち）');
        if (inventory.dataFreshness.spanDays < 1) missing.push('測定が1日に偏っている');

        return {
            kind: 'evidence_completeness_preview',
            note: '本番Recommendationのconfidenceではない。根拠の揃い具合を示すプレビュー。',
            value: Math.round(value * 1000) / 1000,
            subscores: sub,
            penalties: penalties,
            belowMinimumEvidence: belowMinimum,
            missing: missing,
            algorithmVersion: PROFILE_ALGORITHM_VERSION
        };
    }

    // ------------------------------------ D. raw/normalized/derived/unresolved

    /** 開発用プレビュー。production UI の最終デザインではない。 */
    function buildProfilePreview(sessions, config) {
        var profile = buildAimProfile(sessions, config);
        var sessionProfiles = (sessions || []).map(buildSessionProfile);

        var kindCounts = {};
        kindCounts[VALUE_KIND.RAW] = 0;
        kindCounts[VALUE_KIND.NORMALIZED] = 0;
        kindCounts[VALUE_KIND.DERIVED] = 0;
        kindCounts[VALUE_KIND.UNRESOLVED] = 0;

        sessionProfiles.forEach(function (sp) {
            for (var f in sp.fields) {
                if (!sp.fields.hasOwnProperty(f)) continue;
                var k = sp.fields[f].kind;
                if (kindCounts[k] !== undefined) kindCounts[k]++;
            }
        });

        return {
            isDevelopmentPreview: true,
            note: '設計検証用。production UI の最終デザインではない。',
            sessionProfiles: sessionProfiles,
            inventory: profile.inventory,
            confidence: profile.confidence,
            valueKindCounts: kindCounts,
            evidenceCount: profile.evidence.length,
            aggregation: profile.aggregation,
            persistence: { willSave: false, reason: 'Phase E prototype — 本番保存は禁止' }
        };
    }

    root.LC_PROFILE = {
        PROFILE_ALGORITHM_VERSION: PROFILE_ALGORITHM_VERSION,
        VALUE_KIND: VALUE_KIND,
        DEFAULT_CONFIG: DEFAULT_CONFIG,
        buildSessionProfile: buildSessionProfile,
        buildEvidence: buildEvidence,
        traceMetric: traceMetric,
        sensitivityConditionKey: sensitivityConditionKey,
        buildAimProfile: buildAimProfile,
        buildConfidencePreview: buildConfidencePreview,
        buildProfilePreview: buildProfilePreview
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
