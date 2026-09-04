/**
 * Long Cape — Aim データの保存・読込（G-5）
 *
 * 設計:
 *   * DB へ触る手順そのものは純粋な「計画（plan）」として組み立て、実行はあとから行う。
 *     こうすると、SQL や Supabase を持たない Node のテストで手順を検証できる。
 *   * 実行は client（Supabase の PostgREST クライアント互換）を差し替えられる形にする。
 *     テストでは偽クライアントを渡し、RLS 相当の判定も含めて検証する。
 *
 * 守っていること:
 *   * profile_storage の同意が無ければ**保存の計画を作らない**（DB の policy と二重の守り）。
 *   * anonymized_statistics / model_improvement は保存の条件にしない。
 *   * 未ログインでは保存しない。ローカル preview だけは同意もログインも要らない。
 *   * 元の CSV は保存しない。SHA-256 と来歴だけを保存する。
 *   * idempotency key は user_id + source + raw_content_hash + parser_version。
 *     parser を上げた再取り込みは別の行として許可する。
 */
(function (root) {
    'use strict';

    var PARSER_VERSION = '0.1.0-g5';
    var NORMALIZATION_VERSION = '0.1.0-g5';

    var CONSENT = {
        REQUIRED_FOR_STORAGE: 'profile_storage',
        OPTIONAL: ['anonymized_statistics', 'model_improvement']
    };

    // ------------------------------------------------------------ 保存の可否
    /**
     * 保存してよいか。**理由まで返す。**
     * @param {{loggedIn:boolean, userId:string}} auth
     * @param {object} consent 目的 → boolean
     */
    function canPersist(auth, consent) {
        var a = auth || {}, c = consent || {};
        if (!a.loggedIn || !a.userId) {
            return {
                allowed: false, reason: 'not_logged_in',
                message: '保存するにはログインが必要です。取り込みと確認はログインなしでもできます。'
            };
        }
        if (c[CONSENT.REQUIRED_FOR_STORAGE] !== true) {
            return {
                allowed: false, reason: 'consent_missing',
                message: '「個人プロフィールとして保存する」に同意すると保存できます。',
                requiredConsent: CONSENT.REQUIRED_FOR_STORAGE
            };
        }
        // 任意の同意は保存の条件にしない
        return {
            allowed: true, reason: null,
            optionalConsentsIgnored: CONSENT.OPTIONAL.slice(),
            message: '保存できます。'
        };
    }

    // ---------------------------------------------------------- idempotency
    function idempotencyKey(userId, source, rawContentHash, parserVersion) {
        return [userId, source, rawContentHash, parserVersion].join('|');
    }

    /**
     * 既存の保存済みセッションと突き合わせ、どれを新規に入れるか決める。
     * 同じ parser 版で同じ中身なら入れない。parser 版が違えば入れる。
     */
    function planSessions(sessions, existing, ctx) {
        var known = {};
        (existing || []).forEach(function (e) {
            known[idempotencyKey(ctx.userId, e.source, e.raw_content_hash, e.parser_version)] = e;
        });

        var toInsert = [], skipped = [], reanalysis = [];
        (sessions || []).forEach(function (s) {
            var hash = (s.provenance && s.provenance.rawContentHash) || s.rawContentHash;
            var source = (s.provenance && s.provenance.source) || s.source || 'kovaak';
            if (!hash) { skipped.push({ session: s, reason: 'no_raw_content_hash' }); return; }

            var key = idempotencyKey(ctx.userId, source, hash, ctx.parserVersion);
            if (known[key]) {
                skipped.push({ session: s, reason: 'already_imported', existingId: known[key].id });
                return;
            }
            // 同じ中身が別の parser 版で入っているか
            var older = (existing || []).filter(function (e) {
                return e.raw_content_hash === hash && e.source === source
                    && e.parser_version !== ctx.parserVersion;
            });
            if (older.length > 0) {
                reanalysis.push({ hash: hash, previousVersions: older.map(function (o) { return o.parser_version; }) });
            }
            toInsert.push(s);
        });

        return { toInsert: toInsert, skipped: skipped, reanalysis: reanalysis };
    }

    // ------------------------------------------------------------- 行の組立
    function sessionRow(s, ctx) {
        var c = s.context || {};
        var p = s.provenance || {};
        var dpi = ctx.confirmedDpi;
        var hasDpi = typeof dpi === 'number' && dpi > 0;

        return {
            user_id: ctx.userId,
            batch_id: ctx.batchId,
            external_id: s.externalId || null,
            scenario_name: s.scenario || null,
            scenario_identity: c.scenarioKey || null,
            context_group: ctx.contextGroup || null,

            // timezone を勝手に UTC にしない
            observed_at_local: s.localTimestamp || null,
            observed_at_tz: null,
            observed_at_utc: null,
            timezone_status: 'unknown',

            dpi_confirmed: hasDpi ? dpi : null,
            dpi_source: ctx.dpiSource || null,
            dpi_in_file: typeof c.dpi === 'number' ? c.dpi : null,
            sens_scale: c.sensScale || null,
            in_game_sens: typeof c.inGameSens === 'number' ? c.inGameSens : null,
            fov: c.fov !== undefined && c.fov !== null ? Number(c.fov) : null,
            // DPI が確定していなければ cm360 を入れない（DB の CHECK と二重の守り）
            cm360: hasDpi && typeof ctx.cm360Of === 'function' ? ctx.cm360Of(s, dpi) : null,

            difficulty_varied: c.difficultyVaried === true,
            difficulty_varied_basis: c.difficultyVariedBasis || null,

            source: p.source || s.source || 'kovaak',
            raw_content_hash: p.rawContentHash || s.rawContentHash,
            parser_version: ctx.parserVersion,
            logical_fingerprint: p.logicalFingerprint || null,
            logical_fingerprint_status: p.logicalFingerprintStatus || 'not_implemented'
        };
    }

    /** Registry に載っていて単位が一致する metric だけを行にする。 */
    function metricRows(s, sessionId, ctx) {
        var out = [], skipped = [];
        var reg = ctx.registry || {};

        function push(metricKey, value, unit, weapon) {
            var def = reg[metricKey];
            if (!def) { skipped.push({ metricKey: metricKey, reason: 'not_registered' }); return; }
            if (unit && def.unit !== unit) {
                skipped.push({ metricKey: metricKey, reason: 'unit_mismatch', expected: def.unit, got: unit });
                return;
            }
            if (typeof value !== 'number' || !isFinite(value)) {
                skipped.push({ metricKey: metricKey, reason: 'not_a_number' });
                return;
            }
            out.push({
                user_id: ctx.userId, session_id: sessionId,
                metric_key: metricKey, metric_version: def.metric_version || '1',
                unit: def.unit, value: value, weapon: weapon || null
            });
        }

        (s.metrics || []).forEach(function (m) { push(m.metricKey, m.value, m.unit, null); });
        (s.weapons || []).forEach(function (w) {
            (w.metrics || []).forEach(function (m) { push(m.metricKey, m.value, m.unit, w.weapon || null); });
        });

        // Long Cape 側の導出値（session-level accuracy）
        if (typeof ctx.derivedAccuracyOf === 'function') {
            var acc = ctx.derivedAccuracyOf(s);
            if (acc && acc.available) push('kovaak.accuracy', acc.value, 'ratio', null);
        }

        return { rows: out, skipped: skipped };
    }

    // ------------------------------------------------------------- 保存計画
    /**
     * 保存の手順を組み立てる。**この関数は DB に触らない。**
     */
    function buildSavePlan(input) {
        var auth = input.auth, consent = input.consent;
        var gate = canPersist(auth, consent);
        if (!gate.allowed) {
            return { ok: false, gate: gate, steps: [], willSave: false };
        }

        var ctx = {
            userId: auth.userId,
            parserVersion: input.parserVersion || PARSER_VERSION,
            normalizationVersion: input.normalizationVersion || NORMALIZATION_VERSION,
            // NOT NULL の列。渡されなければ Registry 自身の版を使う。
            // null のまま送ると DB で弾かれる（実 E2E で検出）。
            registryVersion: input.registryVersion
                || (root.LC_METRICS && root.LC_METRICS.registryVersion) || 'unknown',
            confirmedDpi: input.confirmedDpi,
            dpiSource: input.dpiSource,
            contextGroup: input.contextGroup,
            registry: input.registry,
            cm360Of: input.cm360Of,
            derivedAccuracyOf: input.derivedAccuracyOf
        };

        var plan = planSessions(input.sessions, input.existingSessions, ctx);

        return {
            ok: true, gate: gate, willSave: plan.toInsert.length > 0,
            consentId: input.consentId || null,
            batch: {
                user_id: ctx.userId,
                source: input.source || 'kovaak',
                source_app_version: input.sourceAppVersion || null,
                adapter_format: input.adapterFormat || null,
                adapter_confidence: input.adapterConfidence !== undefined ? input.adapterConfidence : null,
                parser_version: ctx.parserVersion,
                normalization_version: ctx.normalizationVersion,
                registry_version: ctx.registryVersion,
                files_received: input.filesReceived || 0,
                sessions_parsed: (input.sessions || []).length,
                files_rejected: input.filesRejected || 0,
                consent_id: input.consentId || null
            },
            toInsert: plan.toInsert,
            skipped: plan.skipped,
            reanalysis: plan.reanalysis,
            // 元CSVは保存しない。何を保存するかを明示しておく。
            rawRetention: {
                storesOriginalFile: false,
                stores: ['raw_content_hash', 'source', 'parser_version', 'normalization_version',
                         'imported_at', 'normalized_metrics', 'measurement_context'],
                note: '元のCSVそのものは保存しません。ハッシュと来歴だけを保存します。'
            },
            buildSessionRow: function (s, batchId) {
                var c2 = {}; Object.keys(ctx).forEach(function (k) { c2[k] = ctx[k]; });
                c2.batchId = batchId;
                return sessionRow(s, c2);
            },
            buildMetricRows: function (s, sessionId) { return metricRows(s, sessionId, ctx); }
        };
    }

    // ------------------------------------------------------------- 実行
    /**
     * 計画を実行する。client は Supabase 互換（from().insert().select() 等）。
     * **同意が無ければ1行も書かない。**
     */
    function executeSavePlan(client, plan) {
        if (!plan.ok) {
            return Promise.resolve({ saved: false, reason: plan.gate.reason, message: plan.gate.message });
        }
        if (!plan.consentId) {
            return Promise.resolve({ saved: false, reason: 'consent_id_missing',
                message: '同意の記録が見つからないため保存しません。' });
        }
        if (plan.toInsert.length === 0) {
            return Promise.resolve({ saved: false, reason: 'nothing_new',
                message: '新しく取り込むものはありませんでした。', skipped: plan.skipped });
        }

        var result = { saved: true, batchId: null, sessionIds: [], metricCount: 0,
                       skipped: plan.skipped, reanalysis: plan.reanalysis, skippedMetrics: [] };

        return client.from('aim_import_batches').insert(plan.batch).select().single()
            .then(function (r) {
                if (r.error) throw r.error;
                result.batchId = r.data.id;
                var rows = plan.toInsert.map(function (s) { return plan.buildSessionRow(s, result.batchId); });
                return client.from('aim_sessions').insert(rows).select();
            })
            .then(function (r) {
                if (r.error) throw r.error;
                var inserted = r.data || [];
                result.sessionIds = inserted.map(function (x) { return x.id; });

                var metricRowsAll = [];
                inserted.forEach(function (row, i) {
                    var built = plan.buildMetricRows(plan.toInsert[i], row.id);
                    metricRowsAll = metricRowsAll.concat(built.rows);
                    result.skippedMetrics = result.skippedMetrics.concat(built.skipped);
                });
                if (metricRowsAll.length === 0) return { data: [], error: null };
                result.metricCount = metricRowsAll.length;
                return client.from('aim_metrics').insert(metricRowsAll).select();
            })
            .then(function (r) {
                if (r.error) throw r.error;
                return result;
            })
            .catch(function (e) {
                return { saved: false, reason: 'error', message: (e && e.message) || String(e), error: e };
            });
    }

    // ------------------------------------------------------------- 同意の記録
    function grantConsent(client, userId, purpose, consentVersion) {
        return client.from('user_consents')
            .insert({ user_id: userId, purpose: purpose, consent_version: consentVersion })
            .select().single();
    }

    function revokeConsent(client, userId, purpose) {
        return client.from('user_consents')
            .update({ revoked_at: new Date().toISOString() })
            .eq('user_id', userId).eq('purpose', purpose).is('revoked_at', null)
            .select();
    }

    function loadConsents(client, userId) {
        return client.from('user_consents')
            .select('id,purpose,consent_version,granted_at,revoked_at')
            .eq('user_id', userId)
            .then(function (r) {
                if (r.error) return { error: r.error, active: {}, rows: [] };
                var active = {};
                (r.data || []).forEach(function (row) {
                    if (row.revoked_at === null) active[row.purpose] = row;
                });
                return { error: null, rows: r.data || [], active: active };
            });
    }

    // ------------------------------------------------------------- 読込
    /** 保存済みのセッションと metric を読み戻し、Profile に渡せる形へ復元する。 */
    function loadSessions(client, userId) {
        return client.from('aim_sessions').select('*').eq('user_id', userId)
            .then(function (sr) {
                if (sr.error) return { error: sr.error, sessions: [] };
                var rows = sr.data || [];
                if (rows.length === 0) return { error: null, sessions: [] };
                return client.from('aim_metrics').select('*').eq('user_id', userId)
                    .then(function (mr) {
                        if (mr.error) return { error: mr.error, sessions: [] };
                        return { error: null, sessions: rehydrate(rows, mr.data || []) };
                    });
            });
    }

    /** DB の行を、importer が返すのと同じ形へ戻す。 */
    function rehydrate(sessionRows, metricRows) {
        var bySession = {};
        (metricRows || []).forEach(function (m) {
            (bySession[m.session_id] = bySession[m.session_id] || []).push(m);
        });

        return (sessionRows || []).map(function (r) {
            var mine = bySession[r.id] || [];
            var sessionMetrics = [], weapons = {};
            mine.forEach(function (m) {
                var entry = { metricKey: m.metric_key, value: Number(m.value), unit: m.unit };
                if (m.weapon) (weapons[m.weapon] = weapons[m.weapon] || []).push(entry);
                else sessionMetrics.push(entry);
            });

            return {
                externalId: r.external_id,
                scenario: r.scenario_name,
                localTimestamp: r.observed_at_local,
                tzKnown: r.timezone_status !== 'unknown',
                metrics: sessionMetrics,
                weapons: Object.keys(weapons).map(function (w) { return { weapon: w, metrics: weapons[w] }; }),
                context: {
                    dpi: r.dpi_in_file,
                    dpiSource: r.dpi_source,
                    confirmedDpi: r.dpi_confirmed,
                    sensScale: r.sens_scale,
                    inGameSens: r.in_game_sens === null ? null : Number(r.in_game_sens),
                    fov: r.fov === null ? null : Number(r.fov),
                    scenarioKey: r.scenario_identity,
                    difficultyVaried: r.difficulty_varied === true,
                    difficultyVariedBasis: r.difficulty_varied_basis,
                    sensitivity: r.cm360 === null ? undefined
                        : { cm360: Number(r.cm360), verified: true, origin: 'stored_confirmed_dpi' }
                },
                unresolved: [],
                provenance: {
                    source: r.source, sourceType: r.source === 'kovaak' ? 'aim_trainer' : 'manual',
                    rawContentHash: r.raw_content_hash,
                    parserVersion: r.parser_version,
                    logicalFingerprint: r.logical_fingerprint,
                    logicalFingerprintStatus: r.logical_fingerprint_status,
                    importedAt: r.created_at, storedId: r.id, batchId: r.batch_id
                },
                storedId: r.id
            };
        });
    }

    // ------------------------------------------------------------- 削除 / Export
    /**
     * 利用者のデータを消す。**スコープを明示して返す。**
     * インフラ側のログまで消えるとは言わない。
     */
    function deleteAll(client, userId) {
        // sessions を消せば metrics は cascade で消える。batch も消して来歴を残さない。
        return client.from('aim_import_batches').delete().eq('user_id', userId)
            .then(function (r) {
                if (r.error) throw r.error;
                return client.from('aim_sessions').delete().eq('user_id', userId);
            })
            .then(function (r) {
                if (r.error) throw r.error;
                return {
                    deleted: true,
                    scope: ['aim_import_batches', 'aim_sessions', 'aim_metrics'],
                    kept: ['user_consents'],
                    note: 'Long Cape が保存していた測定データを削除しました。同意の記録は残ります（取り消すこともできます）。'
                        + 'なお、これはアプリのデータベース上の話です。'
                        + 'インフラ側の運用ログやセキュリティログまで同時に消えるわけではありません。'
                };
            })
            .catch(function (e) { return { deleted: false, message: (e && e.message) || String(e) }; });
    }

    // ------------------------------------------------------------- Export
    //
    // 【方針】内部の生 JSON をそのまま出さない。
    //   * 版を持つ可搬形式にする（export_version）
    //   * metric は key / version / unit を必ず添える
    //   * 来歴（source / parser / normalization / hash）を添える
    //   * **内部の DB ID、user_id、認証情報、batch_id は出さない**
    //   * 元の CSV は含まない（そもそも保存していない）
    var EXPORT_VERSION = '1.0.0';

    /** metric を「意味が分かる形」に整える。単位を落とさない。 */
    function exportMetric(m, registry) {
        var def = registry && registry[m.metricKey];
        return {
            metric_key: m.metricKey,
            metric_version: (def && def.metric_version) || m.metricVersion || '1',
            unit: m.unit || (def && def.unit) || null,
            value: m.value
        };
    }

    function exportSession(s, registry) {
        var c = s.context || {}, p = s.provenance || {};
        return {
            scenario: {
                name: s.scenario || null,
                // 表示名は改名されうるので、比較の鍵になる識別子も出す
                identity: c.scenarioKey || null
            },
            observed_at: {
                local: s.localTimestamp || null,
                timezone: c.observedAtTz || null,
                // timezone が不明なことを隠さない
                timezone_status: s.tzKnown ? 'known' : 'unknown'
            },
            measurement_context: {
                dpi_confirmed: c.confirmedDpi !== undefined ? c.confirmedDpi : null,
                dpi_in_file: typeof c.dpi === 'number' ? c.dpi : null,
                dpi_source: c.dpiSource || null,
                sens_scale: c.sensScale || null,
                in_game_sens: c.inGameSens !== undefined ? c.inGameSens : null,
                fov: c.fov !== undefined ? c.fov : null,
                cm_per_360: c.sensitivity && typeof c.sensitivity.cm360 === 'number'
                    ? c.sensitivity.cm360 : null
            },
            comparability: {
                difficulty_varied: c.difficultyVaried === true,
                difficulty_varied_basis: c.difficultyVariedBasis || null,
                usable_for_sensitivity_comparison: c.difficultyVaried !== true
            },
            provenance: {
                source: p.source || s.source || null,
                source_type: p.sourceType || null,
                raw_content_hash: p.rawContentHash || null,
                raw_file_included: false,
                parser_version: p.parserVersion || null,
                normalization_version: p.normalizationVersion || null,
                logical_fingerprint: p.logicalFingerprint || null,
                logical_fingerprint_status: p.logicalFingerprintStatus || null,
                imported_at: p.importedAt || null
            },
            metrics: (s.metrics || []).map(function (m) { return exportMetric(m, registry); }),
            weapons: (s.weapons || []).map(function (w) {
                return {
                    weapon: w.weapon || null,
                    metrics: (w.metrics || []).map(function (m) { return exportMetric(m, registry); })
                };
            })
        };
    }

    /**
     * 可搬な Export を作る。保存済みでも手元のものでも同じ形式で出す。
     * **内部 DB ID・user_id・認証情報は含めない。**
     */
    function buildExport(sessions, meta) {
        var m = meta || {};
        var list = sessions || [];
        return {
            format: 'long-cape-aim-export',
            export_version: EXPORT_VERSION,
            exported_at: new Date().toISOString(),
            generator: {
                app: 'long-cape',
                origin: m.source === 'stored' ? 'saved_profile' : 'local_preview',
                parser_version: m.parserVersion || PARSER_VERSION,
                normalization_version: m.normalizationVersion || NORMALIZATION_VERSION,
                registry_version: m.registryVersion || null,
                algorithm_version: m.algorithmVersion || null
            },
            contents: {
                includes_raw_files: false,
                includes_account_identifiers: false,
                includes_credentials: false,
                note: '元のCSVは含まれません（保存していないため）。'
                    + 'アカウントの識別子や認証情報も含めていません。'
            },
            profile_summary: m.profileSummary || null,
            session_count: list.length,
            sessions: list.map(function (s) { return exportSession(s, m.registry); })
        };
    }

    /** Export に出してはいけない鍵。テストと実装の両方から参照する。 */
    var EXPORT_FORBIDDEN_KEYS = [
        'user_id', 'batch_id', 'session_id', 'storedId', 'id',
        'access_token', 'refresh_token', 'apikey', 'password', 'consent_id'
    ];

    /** 禁止キーが混ざっていないか自分で検査する。 */
    function auditExport(payload) {
        var found = [];
        (function walk(v, pathStr) {
            if (v === null || typeof v !== 'object') return;
            if (Array.isArray(v)) { v.forEach(function (x, i) { walk(x, pathStr + '[' + i + ']'); }); return; }
            Object.keys(v).forEach(function (k) {
                if (EXPORT_FORBIDDEN_KEYS.indexOf(k) >= 0) found.push(pathStr + '.' + k);
                walk(v[k], pathStr + '.' + k);
            });
        })(payload, '$');
        return { clean: found.length === 0, offendingKeys: found };
    }

    root.LC_STORAGE = {
        PARSER_VERSION: PARSER_VERSION,
        NORMALIZATION_VERSION: NORMALIZATION_VERSION,
        CONSENT: CONSENT,
        canPersist: canPersist,
        idempotencyKey: idempotencyKey,
        planSessions: planSessions,
        buildSavePlan: buildSavePlan,
        executeSavePlan: executeSavePlan,
        grantConsent: grantConsent,
        revokeConsent: revokeConsent,
        loadConsents: loadConsents,
        loadSessions: loadSessions,
        rehydrate: rehydrate,
        deleteAll: deleteAll,
        buildExport: buildExport,
        auditExport: auditExport,
        EXPORT_VERSION: EXPORT_VERSION,
        EXPORT_FORBIDDEN_KEYS: EXPORT_FORBIDDEN_KEYS
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
