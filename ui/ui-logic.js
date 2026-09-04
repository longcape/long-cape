/**
 * Long Cape — UI ロジック（G-3 prototype）
 *
 * 画面から独立した純粋関数だけを置く。HTML にロジックを書かないのは、
 * ここを Node の vm 上でテストできるようにするため。
 *
 * **このモジュールはネットワークへ一切アクセスしない。**
 * 外部送信の可否は canSendExternally() が判定するだけで、送信そのものは行わない。
 *
 * 依存: LC_METRICS / LC_PROFILE / LC_REESTIMATE / LC_IMPORTERS（すべて任意）
 */
(function (root) {
    'use strict';

    // ------------------------------------------------------------ データ状態
    //
    // ユーザーに見せる4状態。内部用語をそのまま出さないための対応表でもある。
    var DATA_STATE = {
        CONFIRMED: 'confirmed',      // 確認済み
        NEEDS_CHECK: 'needs_check',  // 要確認
        EXCLUDED: 'excluded',        // 分析対象外
        UNSUPPORTED: 'unsupported'   // 未対応
    };

    var STATE_LABEL = {
        confirmed: { ja: '確認済み', tone: 'ok', desc: '内容を確認できました。分析に使えます。' },
        needs_check: { ja: '要確認', tone: 'warn', desc: 'そのままでは確定できない項目があります。' },
        excluded: { ja: '分析対象外', tone: 'muted', desc: '記録は残していますが、感度の比較には使いません。' },
        unsupported: { ja: '未対応', tone: 'error', desc: '対応していない形式です。推測で読み込みません。' }
    };

    // ------------------------------------------------------------- DPI の確認
    //
    // KovaaK の DPI 欄は実機検出値ではなく自己申告の設定値。
    // 実測で4件中3件が実機と食い違ったため、ファイルにあっても自動確定しない。
    var DPI_ANSWER = {
        AS_IS: 'as_is',        // このDPIで正しい
        OVERRIDE: 'override',  // 別のDPIを入力
        DEFER: 'defer'         // 今は確認しない
    };

    // DPI が確定していないと出せないもの
    var DPI_GATED = ['cm360', 'sensitivity_level', 'recommendation'];

    /**
     * DPI の確認状態を解決する。
     * @param {Array} sessions パース済みセッション
     * @param {{answer:string, value:number}} answerState ユーザーの回答
     */
    function resolveDpi(sessions, answerState) {
        var a = answerState || {};
        var fileDpis = {};
        (sessions || []).forEach(function (s) {
            var d = s.context && s.context.dpi;
            if (typeof d === 'number') fileDpis[d] = (fileDpis[d] || 0) + 1;
        });
        var declared = Object.keys(fileDpis).map(Number);

        var base = {
            declaredInFile: declared,
            declaredIsMixed: declared.length > 1,
            fileSource: 'file_self_declared',
            note: 'KovaaKのDPI欄は手で入力する設定値です。実際のマウス設定と違っていることがあります。'
        };

        if (a.answer === DPI_ANSWER.AS_IS && declared.length === 1) {
            return merge(base, {
                status: DATA_STATE.CONFIRMED, confirmedDpi: declared[0],
                confirmedBy: 'user_confirmed_file_value', blocked: [],
                message: 'DPI ' + declared[0] + ' で確認できました。'
            });
        }
        if (a.answer === DPI_ANSWER.OVERRIDE && typeof a.value === 'number' && a.value > 0) {
            return merge(base, {
                status: DATA_STATE.CONFIRMED, confirmedDpi: a.value,
                confirmedBy: 'user_entered', blocked: [],
                mismatch: declared.length === 1 && declared[0] !== a.value
                    ? { fileValue: declared[0], actual: a.value }
                    : null,
                message: 'DPI ' + a.value + ' として扱います。'
            });
        }
        // 未回答 / 保留 / ファイル内で値が割れている
        return merge(base, {
            status: DATA_STATE.NEEDS_CHECK, confirmedDpi: null,
            confirmedBy: null, blocked: DPI_GATED.slice(),
            message: a.answer === DPI_ANSWER.DEFER
                ? 'DPIが未確認のままです。スコアなどの分析はできますが、振り向き（cm/360）と感度の推奨は出せません。'
                : '実際に使っているマウスのDPIを確認してください。'
        });
    }

    /** DPI ゲートに掛かっているか。 */
    function isBlockedByDpi(dpiState, what) {
        if (!dpiState || !dpiState.blocked) return false;
        return dpiState.blocked.indexOf(what) >= 0;
    }

    // ------------------------------------------------------------- cm/360
    //
    // 感度スケールごとの換算定数。**推測で増やさない。**
    // 実測で裏取りできたものだけをここに置き、それ以外は「換算しない」を返す。
    var SENS_SCALE = {
        valorant: {
            degPerCountAtSens1: 0.06996,
            verifiedAt: '2026-09-04',
            basis: 'ゲーム内感度 0.4 / DPI 800 で 40.8cm となり、VALORANT の既知の値と一致することを実測で確認した。'
        }
    };

    /**
     * 振り向き（cm/360）。
     * DPI が確定していない、または換算定数が未確定のスケールでは **計算しない**。
     */
    function cm360(sensScale, sens, dpi) {
        if (typeof sens !== 'number' || typeof dpi !== 'number' || sens <= 0 || dpi <= 0) {
            return { available: false, reason: 'missing_input' };
        }
        var def = SENS_SCALE[String(sensScale || '').toLowerCase()];
        if (!def) {
            return {
                available: false, reason: 'scale_not_verified',
                note: '「' + sensScale + '」の換算はまだ確認できていないため計算しません。'
            };
        }
        var counts = 360 / (sens * def.degPerCountAtSens1);
        return {
            available: true,
            value: Math.round((2.54 * counts / dpi) * 10) / 10,
            scale: sensScale, sens: sens, dpi: dpi, basis: def.basis
        };
    }

    // ------------------------------------------------------- import 画面の行
    var METRIC = function (s, key) {
        var hit = (s.metrics || []).filter(function (m) { return m.metricKey === key; })[0];
        return hit ? hit.value : null;
    };

    /**
     * session-level の命中率。KovaaK のフッターには存在しないので Long Cape の導出値。
     * kill-level の公式値（kovaak.kill_accuracy）とは粒度が違う別物。
     */
    function derivedAccuracy(s) {
        var hits = METRIC(s, 'kovaak.hit_count');
        var shots = null;
        (s.weapons || []).forEach(function (w) {
            (w.metrics || []).forEach(function (m) {
                if (m.metricKey === 'kovaak.weapon.shots') shots = (shots || 0) + m.value;
            });
        });
        if (typeof hits !== 'number' || typeof shots !== 'number' || shots <= 0) {
            return { available: false, reason: 'hit_count または shots が取得できない' };
        }
        return {
            available: true, value: hits / shots, hits: hits, shots: shots,
            layer: 'derived', granularity: 'session',
            note: 'Long Cape が Hit Count ÷ Shots で計算した値です。'
        };
    }

    /** 1セッションを画面用の1行にする。 */
    function sessionRow(s, dpiState) {
        var ctx = s.context || {};
        var adaptive = ctx.difficultyVaried === true;
        var acc = derivedAccuracy(s);
        var blocked = isBlockedByDpi(dpiState, 'cm360');
        var confirmedDpi = dpiState && typeof dpiState.confirmedDpi === 'number' ? dpiState.confirmedDpi : null;
        var cm = blocked || confirmedDpi === null
            ? { available: false, reason: 'dpi_unconfirmed' }
            : cm360(ctx.sensScale, ctx.inGameSens, confirmedDpi);
        // 取り込み時点の未確定項目のうち、ユーザーがDPIを確認したことで解消したものを取り除く。
        // importer 側の unresolved は解析時のスナップショットなので、画面側で解決を反映する。
        var DPI_RESOLVES = { dpi_verified: 1, cm360: 1 };
        var open = (s.unresolved || []).filter(function (u) {
            if (confirmedDpi !== null && DPI_RESOLVES[u.field]) {
                // cm/360 は感度スケールの換算が確定している場合のみ解消したとみなす
                if (u.field === 'cm360' && !cm.available) return true;
                return false;
            }
            return true;
        });
        var state = adaptive ? DATA_STATE.EXCLUDED
            : (open.length > 0 ? DATA_STATE.NEEDS_CHECK : DATA_STATE.CONFIRMED);

        return {
            sessionId: s.externalId || null,
            scenario: s.scenario || null,
            scenarioIdentity: ctx.scenarioKey || null,
            timestamp: s.localTimestamp || null,
            timestampMeaning: ctx.filenameTimestampMeaning || null,
            tzKnown: !!s.tzKnown,
            dpiInFile: typeof ctx.dpi === 'number' ? ctx.dpi : null,
            dpiSource: ctx.dpiSource || 'unknown',
            dpiConfirmed: dpiState && dpiState.confirmedDpi !== null && dpiState.confirmedDpi !== undefined
                ? dpiState.confirmedDpi : null,
            sensScale: ctx.sensScale || null,
            horizSens: typeof ctx.inGameSens === 'number' ? ctx.inGameSens : null,
            fov: ctx.fov !== undefined ? ctx.fov : null,
            score: METRIC(s, 'kovaak.score'),
            kills: METRIC(s, 'kovaak.kills'),
            accuracy: acc,
            adaptive: adaptive,
            adaptiveBasis: ctx.difficultyVariedBasis || null,
            unresolved: open.map(function (u) {
                return { field: u.field, reason: u.reason, note: u.note || null };
            }),
            state: state,
            // cm/360 は DPI が確定するまで出さない。
            // 確定しても、換算定数が未確認のスケールでは計算しない（推測しない）。
            cm360: blocked ? null : cm.value !== undefined ? cm.value : null,
            cm360Detail: blocked ? null : cm,
            cm360Blocked: blocked,
            cm360BlockedReason: blocked ? 'DPIが未確認のため計算しません'
                : (cm.available ? null : cm.note || '換算できません')
        };
    }

    /**
     * importer の結果を画面用にまとめる。
     * 未対応ファイルは推測で読まず、未対応として並べるだけ。
     */
    function buildImportView(runResult, dpiState) {
        var r = runResult || {};
        var sessions = r.sessions || [];
        var rows = sessions.map(function (s) { return sessionRow(s, dpiState); });

        var rejected = (r.warnings || []).filter(function (w) {
            return w.level === 'error';
        }).map(function (w) {
            return {
                file: (w.context && w.context.file) || null,
                code: w.code, message: w.message,
                state: w.code === 'unsupported_format' ? DATA_STATE.UNSUPPORTED : DATA_STATE.NEEDS_CHECK,
                parsed: false,
                note: w.code === 'unsupported_format'
                    ? '対応していない形式のため、推測して読み込むことはしません。' : null
            };
        });

        var counts = { confirmed: 0, needs_check: 0, excluded: 0, unsupported: 0 };
        rows.forEach(function (x) { counts[x.state]++; });
        rejected.forEach(function (x) { counts[x.state]++; });

        return {
            kind: 'import_view',
            summary: {
                filesReceived: (r.stats && r.stats.filesReceived) || (sessions.length + rejected.length),
                parsed: sessions.length,
                rejected: rejected.length,
                warningCount: (r.warnings || []).length
            },
            stateCounts: counts,
            rows: rows,
            rejected: rejected,
            warnings: (r.warnings || []).map(function (w) {
                return { level: w.level, code: w.code, message: w.message };
            }),
            unknownFields: r.unknownFields || [],
            // 解析はブラウザ内だけで完結している
            transport: { sentToServer: false, note: 'ファイルはこの端末の中だけで解析しています。' }
        };
    }

    // ------------------------------------------------------ 開発モードの内訳
    /**
     * production では隠す技術情報。構造として分けておき、画面側は表示するかどうかだけ選ぶ。
     */
    function devInspect(sessions, evidence) {
        var M = root.LC_METRICS;
        var layers = { raw: [], normalized: [], derived: [], unresolved: [] };

        (sessions || []).forEach(function (s) {
            var ctx = s.context || {};
            Object.keys(ctx).forEach(function (k) {
                if (layers.raw.indexOf(k) < 0) layers.raw.push(k);
            });
            (s.metrics || []).forEach(function (m) {
                if (layers.normalized.indexOf(m.metricKey) < 0) layers.normalized.push(m.metricKey);
            });
            (s.unresolved || []).forEach(function (u) {
                if (layers.unresolved.indexOf(u.field) < 0) layers.unresolved.push(u.field);
            });
            if (derivedAccuracy(s).available && layers.derived.indexOf('kovaak.accuracy') < 0) {
                layers.derived.push('kovaak.accuracy');
            }
        });

        // 収集方法は metric ごとに違う。決め打ちすると別 source の metric が
        // 「未評価」に見えてしまうので、実際の evidence から引く。
        var methodOf = {};
        (evidence || []).forEach(function (e) {
            if (e.metricKey && e.collectionMethod && !methodOf[e.metricKey]) {
                methodOf[e.metricKey] = e.collectionMethod;
            }
        });

        var metricRows = layers.normalized.concat(layers.derived).map(function (key) {
            var def = M && M.get ? M.get(key) : null;
            var pol = def ? def.reliability_policy : null;
            var method = methodOf[key] || (pol && pol.collection_method) || null;
            var rel = M && M.resolveReliability ? M.resolveReliability(key, method) : null;
            return {
                metricKey: key,
                layer: def ? def.layer : 'unknown',
                registered: !!def,
                ratingStatus: rel ? rel.status : 'unknown',
                effectiveReliability: rel ? rel.value : null,
                effectivePolicy: rel ? rel.effectivePolicy : null,
                collectionMethod: method,
                comparabilityGroup: def ? def.comparability_group : null,
                recommendationEligible: def ? def.recommendation_eligible === true : false,
                recommendationHold: !!(pol && pol.recommendation_hold && pol.recommendation_hold.held),
                holdReason: pol && pol.recommendation_hold ? pol.recommendation_hold.reason : null,
                usageProhibition: pol ? pol.usage_prohibition || null : null
            };
        });

        return {
            kind: 'dev_inspect',
            layers: layers,
            metrics: metricRows,
            evidenceCount: (evidence || []).length,
            note: 'この内訳は開発モードでのみ表示します。'
        };
    }

    // --------------------------------------------------------- 除外セッション
    /**
     * 除外は「消した」ではない。存在は見せて、理由を必ず添える。
     */
    function buildExcludedView(sessions) {
        return (sessions || []).filter(function (s) {
            return s.context && s.context.difficultyVaried === true;
        }).map(function (s) {
            return {
                sessionId: s.externalId,
                scenario: s.scenario,
                kept: true,
                excludedFrom: ['sensitivity_comparison', 'recommendation'],
                reason: '難易度がセッション中に変化したため、現在の感度比較からは除外',
                basis: (s.context && s.context.difficultyVariedBasis) || null,
                note: 'データは保持しています。難易度の変化を補正できるようになれば再び使えます。'
            };
        });
    }

    // ------------------------------------------------------- Recommendation
    /**
     * 推奨の表示用ビュー。
     * DPI 未確認・証拠不足のときは「出せません」で終わらせず、
     * 何を足せば出せるようになるかを返す。
     */
    function buildRecommendationView(reest, dpiState, opts) {
        var o = opts || {};
        var blockedByDpi = isBlockedByDpi(dpiState, 'recommendation');

        if (blockedByDpi) {
            return {
                kind: 'recommendation_view', status: 'withheld',
                reasonCode: 'dpi_unconfirmed',
                headline: 'まだ推奨できません',
                why: 'マウスのDPIが未確認だからです。DPIが2倍違うと、振り向きの距離も2倍ずれてしまいます。',
                whatToDo: [{
                    action: 'confirm_dpi',
                    label: '実際に使っているマウスのDPIを確認してください',
                    detail: 'DPIさえ分かれば、いま取り込んだデータのまま計算できます。'
                }],
                recommended_cm360: null, recommended_range: null,
                nextBestTest: null,
                dataSource: o.dataSource || null
            };
        }

        var r = reest || {};
        if (!r.status || r.status !== 'issued') {
            var todo = (r.insufficient_evidence || []).map(function (i) {
                return { action: i.code, label: i.message, detail: i.detail || null };
            });
            if (todo.length === 0) {
                todo.push({ action: 'import_more', label: '測定データをもう少し取り込んでください', detail: null });
            }
            return {
                kind: 'recommendation_view', status: 'withheld',
                reasonCode: 'insufficient_evidence',
                headline: 'まだ推奨できません',
                why: '感度を比べるための材料が足りていません。',
                whatToDo: todo,
                recommended_cm360: null, recommended_range: null,
                nextBestTest: buildNextBestTestView(r.next_best_test),
                evidenceCount: r.evidence_count || 0,
                dataSource: o.dataSource || null
            };
        }

        return {
            kind: 'recommendation_view', status: 'available',
            headline: '現時点の推奨',
            recommended_cm360: r.recommended_cm360,
            recommended_range: r.recommended_range,
            range_definition: r.range_definition || null,
            confidence: r.confidence || null,
            evidenceCount: r.evidence_count || 0,
            sourceMix: r.source_mix || {},
            evidenceExcluded: r.evidence_excluded || {},
            whyThisChanged: r.change_reason,
            edgeOptimum: r.edge_optimum || null,
            coverage: r.sensitivity_coverage || null,
            nextBestTest: buildNextBestTestView(r.next_best_test),
            // 「スコアが高い＝最適」ではないことを構造として持たせる
            composition: compositionExplainer(r),
            dataSource: o.dataSource || null
        };
    }

    /**
     * 何を根拠に決めたのかの内訳。トップに全部は出さず、「なぜこの結果？」で開く用。
     */
    function compositionExplainer(r) {
        var top = (r && r.ranked && r.ranked[0]) || null;
        var parts = top && top.parts ? top.parts : {};
        var FACTOR_JA = {
            performance: { label: '成績', desc: 'そのままのスコアの高さ' },
            stability: { label: '安定性', desc: '1回ごとのブレの小ささ' },
            repeatability: { label: '再現性', desc: '日をまたいでも同じように出せるか' },
            recency: { label: '新しさ', desc: '最近のデータかどうか' },
            coverage: { label: '測定の広がり', desc: '前後の感度も試したか' }
        };
        var used = Object.keys(parts).map(function (k) {
            var meta = FACTOR_JA[k] || { label: k, desc: '' };
            return { key: k, label: meta.label, desc: meta.desc, value: parts[k] };
        });
        return {
            headline: 'スコアが一番高い感度を、そのまま選んでいるわけではありません',
            summary: '成績だけでなく、ブレの小ささや日をまたいだ再現性も合わせて判断しています。',
            factors: used,
            note: '調子の良い1回だけ極端に高い感度より、いつも同じように出せる感度を優先します。'
        };
    }

    /**
     * Next Best Test。「次に何をすればよいか」を1つだけ返す。
     * 不確実性の減少量を数値で捏造しない（qualitative_only を内部で保持）。
     */
    function buildNextBestTestView(nbt) {
        if (!nbt || nbt.next_test_cm360 === undefined || nbt.next_test_cm360 === null) return null;

        var REASON_JA = {
            increase_level_count: '比べられる感度がまだ足りないためです。',
            explore_beyond_edge: 'いちばん良かったのが試した範囲の端だったので、その外側も確かめます。',
            distinguish_close_levels: '上位2つの差がまだ判別できないためです。',
            reinforce_thin_level: 'この感度のデータが少ないためです。'
        };

        return {
            kind: 'next_best_test',
            nextSensitivity: nbt.next_test_cm360,
            sessionCount: nbt.recommended_sessions,
            scenarioConcept: nbt.scenario_concept || nbt.concept || null,
            reasonCode: nbt.reason,
            reason: REASON_JA[nbt.reason] || nbt.detail || null,
            detail: nbt.detail || null,
            // 内部仕様をそのまま保持する。定量的な不確実性減少量は作らない。
            uncertaintyReduction: nbt.uncertainty_reduction || 'qualitative_only',
            uncertaintyNote: 'どれくらい確信が上がるかを数値では出しません。まだ根拠がないためです。',
            sentence: buildNextTestSentence(nbt)
        };
    }

    /**
     * 指示は1文で言い切る。理由は別の行に出すので、ここには混ぜない。
     * 例: 「次は 33cm で 3回 試してください。」／理由「32cmと34cmの差を判別するためです。」
     */
    function buildNextTestSentence(nbt) {
        var s = '次は ' + nbt.next_test_cm360 + 'cm で ' + nbt.recommended_sessions + '回 試してください。';
        if (nbt.scenario_concept) s += ' シナリオは ' + nbt.scenario_concept + ' を使ってください。';
        return s;
    }

    // ---------------------------------------------------------- Profile 表示
    function buildProfileView(aimProfile, sessions, reest) {
        var p = aimProfile || {};
        var inv = p.inventory || {};
        var conf = p.confidence || {};

        return {
            kind: 'profile_view',
            inventory: {
                importedSessions: inv.sessionCount || 0,
                sources: inv.sources || [],
                sourceCount: inv.sourceCount || 0,
                scenarioCount: inv.scenarioCount || 0,
                scenarios: inv.scenarios || [],
                sensitivityLevels: inv.sensitivityLevels || [],
                dataFreshness: inv.dataFreshness || null
            },
            sensitivityCoverage: (reest && reest.sensitivity_coverage) || null,
            scoreTrend: buildScoreTrend(sessions),
            evidenceCount: (conf.evidenceQuality && conf.evidenceQuality.evidenceCount) || 0,
            // 【重要】この3つは別物なので、1つのメーターに統合しない
            meters: [
                {
                    id: 'profile_completeness', label: 'プロフィールの充実度',
                    value: conf.profileCompleteness ? conf.profileCompleteness.value : null,
                    desc: 'どれだけ材料が集まったか。推奨の当たりやすさとは別です。',
                    gaps: conf.profileCompleteness ? conf.profileCompleteness.gaps : []
                },
                {
                    id: 'evidence_quality', label: 'データの質',
                    value: conf.evidenceQuality ? conf.evidenceQuality.ratedRatio : null,
                    desc: '意味と信頼度が確定している項目の割合です。',
                    detail: conf.evidenceQuality || null
                },
                {
                    id: 'recommendation_confidence', label: '推奨の確からしさ',
                    value: reest && reest.status === 'issued' && reest.confidence
                        ? reest.confidence.value : null,
                    desc: '推奨そのものの確からしさ。上の2つとは別の指標です。',
                    unavailable: !(reest && reest.status === 'issued'),
                    unavailableReason: '推奨がまだ出せないため計算していません。'
                }
            ],
            unresolved: collectUnresolved(sessions),
            excludedSessions: buildExcludedView(sessions),
            separationNote: 'プロフィールの充実度と推奨の確からしさは別物です。同じメーターにまとめていません。'
        };
    }

    function collectUnresolved(sessions) {
        var byField = {};
        (sessions || []).forEach(function (s) {
            (s.unresolved || []).forEach(function (u) {
                if (!byField[u.field]) byField[u.field] = { field: u.field, count: 0, reasons: {}, note: u.note || null };
                byField[u.field].count++;
                byField[u.field].reasons[u.reason] = true;
            });
        });
        return Object.keys(byField).map(function (k) {
            var x = byField[k];
            return { field: x.field, count: x.count, reasons: Object.keys(x.reasons), note: x.note };
        });
    }

    function buildScoreTrend(sessions) {
        var pts = [];
        (sessions || []).forEach(function (s) {
            var v = METRIC(s, 'kovaak.score');
            if (v === null) {
                (s.metrics || []).forEach(function (m) {
                    if (m.metricKey === 'manual.benchmark_score') v = m.value;
                });
            }
            if (v !== null && v !== undefined) {
                pts.push({
                    at: s.localTimestamp || null, value: v,
                    scenario: s.scenario || null,
                    scenarioIdentity: (s.context && s.context.scenarioKey) || null,
                    adaptive: !!(s.context && s.context.difficultyVaried)
                });
            }
        });
        pts.sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
        return {
            points: pts,
            note: pts.length > 0
                ? 'シナリオが違うとスコアの尺度も違うため、別シナリオの点を直接くらべないでください。'
                : null
        };
    }

    // ------------------------------------------------------------- Consent
    /**
     * 目的ごとに独立。1つのチェックボックスへまとめない。
     * ローカルプレビューは同意なしで使える。
     */
    var CONSENT_PURPOSES = [
        {
            id: 'profile_storage', label: '個人プロフィールとして保存する',
            desc: '次に来たときも続きから測定できるようになります。', required: false
        },
        {
            id: 'anonymized_stats', label: '匿名の集計統計に使う',
            desc: '個人が分からない形で、全体の傾向を出すために使います。', required: false
        },
        {
            id: 'model_improvement', label: 'モデルの改善・学習に使う',
            desc: '推奨の精度を上げるために使います。', required: false
        }
    ];

    function defaultConsent() {
        return { profile_storage: false, anonymized_stats: false, model_improvement: false };
    }

    /**
     * 外部送信してよいか。**同意が無ければ常に false。**
     * この関数は判定するだけで、送信はしない。
     */
    function canSendExternally(consent, purpose) {
        var c = consent || {};
        if (!purpose) return false;
        if (CONSENT_PURPOSES.filter(function (p) { return p.id === purpose; }).length === 0) return false;
        return c[purpose] === true;
    }

    /** ローカルプレビューに同意は要らない。 */
    function localPreviewAllowed() {
        return { allowed: true, requiresConsent: false, requiresLogin: false };
    }

    // --------------------------------------------------------------- ログイン
    /**
     * ログイン前でも CSV → local preview → Profile preview まで使える。
     * 「アカウントを作らないと中身も見られない」設計にはしない。
     */
    function loginCapabilities(loggedIn) {
        return {
            loggedIn: !!loggedIn,
            canImportCsv: true,
            canPreviewLocally: true,
            canPreviewProfile: true,
            canSeeRecommendationPreview: true,
            canSave: !!loggedIn,
            canContinueAcrossSessions: !!loggedIn,
            // 削除と Export は常に無料。有料機能にしない。
            canDeleteData: true,
            canExportData: true,
            dataRightsArePaid: false,
            note: loggedIn
                ? '保存と継続的な測定ができます。'
                : 'ログインしなくても、取り込みとプロフィールの確認まではできます。保存は要ログインです。'
        };
    }

    // --------------------------------------------------------------- helpers
    function merge(a, b) {
        var o = {};
        Object.keys(a).forEach(function (k) { o[k] = a[k]; });
        Object.keys(b).forEach(function (k) { o[k] = b[k]; });
        return o;
    }

    root.LC_UI = {
        version: '0.1.0-g3-prototype',
        DATA_STATE: DATA_STATE,
        STATE_LABEL: STATE_LABEL,
        DPI_ANSWER: DPI_ANSWER,
        DPI_GATED: DPI_GATED,
        CONSENT_PURPOSES: CONSENT_PURPOSES,

        cm360: cm360,
        SENS_SCALE: SENS_SCALE,
        resolveDpi: resolveDpi,
        isBlockedByDpi: isBlockedByDpi,
        derivedAccuracy: derivedAccuracy,
        sessionRow: sessionRow,
        buildImportView: buildImportView,
        devInspect: devInspect,
        buildExcludedView: buildExcludedView,
        buildRecommendationView: buildRecommendationView,
        buildNextBestTestView: buildNextBestTestView,
        compositionExplainer: compositionExplainer,
        buildProfileView: buildProfileView,
        buildScoreTrend: buildScoreTrend,

        defaultConsent: defaultConsent,
        canSendExternally: canSendExternally,
        localPreviewAllowed: localPreviewAllowed,
        loginCapabilities: loginCapabilities
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
