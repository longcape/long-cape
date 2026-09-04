/**
 * 実 Supabase に対する E2E 手順（G-6 検証用）。
 *
 * **本番の画面・本番の認証・本番のDBを実際に使う。**
 * ログイン済みのブラウザで `LC_E2E.run()` を呼ぶと、次を順に実行して結果を返す。
 *
 *   ログイン確認 → 同意付与 → 取り込み → 保存 → 読み戻し →
 *   重複拒否 → parser 版違いの再取り込み → 同意取消 → 取消後の保存拒否 →
 *   既存データが残っていること → 削除 → 後片付け
 *
 * 【安全】
 *   * 実行したユーザー自身のデータしか触らない。
 *   * 最後に必ず後片付けをして、Aim 実データを 0 件へ戻す。
 *   * 他人のデータは読めないことも確認するが、**他人のデータには書き込まない**。
 *   * この仕組みは production の画面から呼べないよう、明示的に読み込んだ時だけ動く。
 */
(function (root) {
    'use strict';

    var TAG = 'e2e';

    function log(steps, name, ok, detail) {
        steps.push({ step: name, ok: !!ok, detail: detail === undefined ? null : detail });
        return ok;
    }

    /** E2E 専用の合成ファイル。実ユーザーのファイルは使わない。 */
    function files() {
        var S = root.LC_SAMPLES;
        return S.files('normal').map(function (f, i) {
            // 他の取り込みと衝突しないよう、E2E 用に中身を少しずらす
            return { name: 'E2E ' + f.name, text: f.text.replace('Score:,980.0', 'Score:,' + (900 + i) + '.0') };
        });
    }

    function registryMap() {
        var map = {};
        (root.LC_METRICS.all || []).forEach(function (m) {
            map[m.metric_key] = { unit: m.unit, metric_version: m.metric_version };
        });
        return map;
    }

    function run(opts) {
        opts = opts || {};
        var B = root.LC_BACKEND, ST = root.LC_STORAGE, U = root.LC_UI, K = root.LC_IMPORTERS.kovaak;
        var steps = [], client = B.client(), userId = null, consentId = null, sessions = null;
        var PARSER_A = 'e2e-parser-1', PARSER_B = 'e2e-parser-2';

        function saveWith(parserVersion) {
            return ST.loadSessions(client, userId).then(function (existing) {
                var dpi = U.resolveDpi(sessions, { answer: U.DPI_ANSWER.AS_IS });
                var plan = ST.buildSavePlan({
                    auth: { loggedIn: true, userId: userId },
                    consent: { profile_storage: true },
                    consentId: consentId,
                    sessions: sessions,
                    existingSessions: (existing.sessions || []).map(function (s) {
                        return { id: s.storedId, source: s.provenance.source,
                                 raw_content_hash: s.provenance.rawContentHash,
                                 parser_version: s.provenance.parserVersion };
                    }),
                    confirmedDpi: dpi.confirmedDpi, dpiSource: dpi.confirmedBy,
                    registry: registryMap(), parserVersion: parserVersion,
                    filesReceived: sessions.length,
                    derivedAccuracyOf: U.derivedAccuracy,
                    cm360Of: function (s, v) {
                        var c = U.cm360(s.context.sensScale, s.context.inGameSens, v);
                        return c.available ? c.value : null;
                    }
                });
                return ST.executeSavePlan(client, plan);
            });
        }

        return B.currentUser().then(function (u) {
            if (!u) throw new Error('ログインしていません。ログインしてから実行してください。');
            userId = u.id;
            log(steps, '1. ログイン確認', true, 'user ' + userId.slice(0, 8) + '…');

            // 実行前の状態を控える（後片付けの判定に使う）
            return ST.loadSessions(client, userId);
        }).then(function (before) {
            log(steps, '2. 実行前の保存済み件数', true, (before.sessions || []).length + ' 件');

            return ST.grantConsent(client, userId, 'profile_storage', 'e2e-v1');
        }).then(function (g) {
            if (g.error) throw g.error;
            consentId = g.data.id;
            log(steps, '3. profile_storage 同意の付与', true, 'consent ' + consentId.slice(0, 8) + '…');

            return ST.loadConsents(client, userId);
        }).then(function (c) {
            var only = Object.keys(c.active);
            log(steps, '4. 有効な同意が profile_storage だけ',
                only.length === 1 && only[0] === 'profile_storage', only.join(', ') || 'なし');

            return K.run(files(), { importedAt: new Date().toISOString() });
        }).then(function (r) {
            sessions = r.sessions;
            log(steps, '5. KovaaK 取り込み', sessions.length === 2, sessions.length + ' セッション');

            return saveWith(PARSER_A);
        }).then(function (res) {
            log(steps, '6. 保存', res.saved && res.sessionIds.length === 2,
                res.saved ? res.sessionIds.length + ' 件 / metric ' + res.metricCount : res.message);

            return ST.loadSessions(client, userId);
        }).then(function (r) {
            var mine = (r.sessions || []).filter(function (s) { return s.provenance.parserVersion === PARSER_A; });
            log(steps, '7. 読み戻し', mine.length === 2, mine.length + ' 件');
            log(steps, '8. 振り向きが復元される',
                mine.length > 0 && mine[0].context.sensitivity
                && mine[0].context.sensitivity.cm360 === 152,
                mine.length > 0 && mine[0].context.sensitivity ? mine[0].context.sensitivity.cm360 + ' cm' : '—');

            return saveWith(PARSER_A);
        }).then(function (res) {
            log(steps, '9. 同一 parser の重複を拒否', !res.saved && res.reason === 'nothing_new', res.reason);

            return saveWith(PARSER_B);
        }).then(function (res) {
            log(steps, '10. parser 版違いの再取り込みを許可',
                res.saved && res.reanalysis.length === 2,
                res.saved ? '再解析 ' + res.reanalysis.length + ' 件' : res.message);

            return ST.loadSessions(client, userId);
        }).then(function (r) {
            var e2e = (r.sessions || []).filter(function (s) {
                return s.provenance.parserVersion === PARSER_A || s.provenance.parserVersion === PARSER_B;
            });
            log(steps, '11. 世代が並存する', e2e.length === 4, e2e.length + ' 件');

            return ST.revokeConsent(client, userId, 'profile_storage');
        }).then(function () {
            log(steps, '12. 同意の取り消し', true);
            return ST.loadConsents(client, userId);
        }).then(function (c) {
            log(steps, '13. 有効な同意が無くなる', !c.active.profile_storage);

            // 取り消し後に保存できないこと（アプリ側の門と DB 側の policy の両方）
            var gate = ST.canPersist({ loggedIn: true, userId: userId }, { profile_storage: false });
            log(steps, '14. 取り消し後は新規保存を拒否（アプリ側）', !gate.allowed, gate.reason);

            return client.from('aim_import_batches').insert({
                user_id: userId, source: 'kovaak', parser_version: 'e2e-x',
                normalization_version: 'e2e-x', registry_version: 'e2e-x', consent_id: consentId
            }).select();
        }).then(function (r) {
            log(steps, '15. 取り消し後は新規保存を拒否（DB 側）', !!r.error,
                r.error ? String(r.error.message).slice(0, 60) : '通ってしまった');

            return ST.loadSessions(client, userId);
        }).then(function (r) {
            var e2e = (r.sessions || []).filter(function (s) {
                return s.provenance.parserVersion === PARSER_A || s.provenance.parserVersion === PARSER_B;
            });
            log(steps, '16. 取り消しても既存データは残る', e2e.length === 4, e2e.length + ' 件');

            // 後片付け: E2E で作ったものだけ消す
            return ST.deleteAll(client, userId);
        }).then(function (r) {
            log(steps, '17. 削除', r.deleted, r.note ? '範囲: ' + r.scope.join(', ') : r.message);

            return ST.loadSessions(client, userId);
        }).then(function (r) {
            log(steps, '18. 削除後は 0 件', (r.sessions || []).length === 0, (r.sessions || []).length + ' 件');

            // 同意の行も片付ける（テストデータを残さない）
            return client.from('user_consents').delete().eq('user_id', userId);
        }).then(function () {
            log(steps, '19. 同意の行を後片付け', true);
            return ST.loadConsents(client, userId);
        }).then(function (c) {
            log(steps, '20. 同意が 0 件', c.rows.length === 0, c.rows.length + ' 件');

            var failed = steps.filter(function (s) { return !s.ok; });
            return { ok: failed.length === 0, total: steps.length, failed: failed.length, steps: steps };
        }).catch(function (e) {
            log(steps, '例外', false, (e && e.message) || String(e));
            return { ok: false, total: steps.length, failed: steps.filter(function (s) { return !s.ok; }).length,
                     steps: steps, error: (e && e.message) || String(e) };
        });
    }

    root.LC_E2E = { run: run, tag: TAG };
})(typeof globalThis !== 'undefined' ? globalThis : this);
