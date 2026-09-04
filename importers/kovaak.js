/**
 * KovaaK Adapter — Phase D read-only prototype
 * =============================================
 *
 * ファイル選択 → format detection → parse → validation → normalization →
 * provenance → preview のうち、Adapter が担う部分を実装する。
 *
 * 【この版の制約（Phase D の禁止事項）】
 *   - 本番DBへ保存しない。DBのことを一切知らない
 *   - Recommendation へ投入しない
 *   - `Horiz Sens` を正規化しない（値が2箇所で約100倍違い未解決のため）
 *   - cm/360 を自動確定しない
 *   - 実ファイル検証を通していないため production-ready ではない
 *
 * 【設計上の不変条件】
 *   - 純粋関数。ネットワークにも DOM にも触らない
 *   - 例外を投げない。問題は warnings / errors に積む
 *   - 未知formatは推測解析せず unsupported_format で停止する
 *   - 未知の列は捨てず unknownFields に記録するだけ。勝手に指標化しない
 *
 * ブラウザでは <script> で読み込んで globalThis.LC_IMPORTERS へ登録される。
 * Node のテストからは vm で評価して同じオブジェクトを取り出す。
 */
(function (root) {
    'use strict';

    // ---------------------------------------------------------------- 定数

    var FORMATS = {
        LEGACY: 'legacy_stats_csv',
        CURRENT: 'current_stats_csv',
        TIMESERIES: 'performance_timeseries',
        UNSUPPORTED: 'unsupported_format'
    };

    var PARSER_VERSION = '0.1.0';        // ファイルの読み方
    var NORMALIZATION_VERSION = '0.1.0'; // 読んだ値の意味づけ

    var FILENAME_SEP = ' - Challenge - ';
    var FILENAME_SUFFIX = ' Stats.csv';

    /**
     * フッター／サマリのキー → session レベルの metric_key。
     * ここに無いキーは unknownFields へ回す。勝手に指標化しない。
     * `Horiz Sens` / `Vert Sens` は意図的に含めない（第0節の禁止事項）。
     */
    var FOOTER_METRIC_MAP = {
        'kills': { metricKey: 'kovaak.kills', unit: 'count' },
        'deaths': { metricKey: 'kovaak.deaths', unit: 'count' },
        'fight time': { metricKey: 'kovaak.fight_time', unit: 's' },
        'score': { metricKey: 'kovaak.score', unit: 'score' },
        'hit count': { metricKey: 'kovaak.hit_count', unit: 'count' },
        'avg fps': { metricKey: 'kovaak.avg_fps', unit: 'fps' },
        'damage done': { metricKey: 'kovaak.damage_done', unit: 'damage' },
        'damage taken': { metricKey: 'kovaak.damage_taken', unit: 'damage' },
        'midairs': { metricKey: 'kovaak.midairs', unit: 'count' },
        'midaired': { metricKey: 'kovaak.midaired', unit: 'count' },
        'directs': { metricKey: 'kovaak.directs', unit: 'count' },
        'directed': { metricKey: 'kovaak.directed', unit: 'count' },
        'distance traveled': { metricKey: 'kovaak.distance_traveled', unit: 'unit' },
        // 実ファイル（3.9.8）で確認した単位。Avg TTK は秒であってミリ秒ではない。
        'avg ttk': { metricKey: 'kovaak.avg_ttk', unit: 's' },
        'miss count': { metricKey: 'kovaak.miss_count', unit: 'count' },
        'total overshots': { metricKey: 'kovaak.total_overshots', unit: 'count' },
        'reloads': { metricKey: 'kovaak.reloads', unit: 'count' },
        'mbs points': { metricKey: 'kovaak.mbs_points', unit: 'score' },
        'time remaining': { metricKey: 'kovaak.time_remaining', unit: 's' },
        'pause count': { metricKey: 'kovaak.pause_count', unit: 'count' },
        'pause duration': { metricKey: 'kovaak.pause_duration', unit: 's' }
    };

    /**
     * 武器行の指標。**weapon レベル**の記録として全行を保持する。
     * Adapter は代表武器を選ばず、合算もしない。集約は Derived 層の責務。
     */
    var WEAPON_METRIC_MAP = {
        'shots': { metricKey: 'kovaak.weapon.shots', unit: 'count' },
        'hits': { metricKey: 'kovaak.weapon.hits', unit: 'count' },
        'damage done': { metricKey: 'kovaak.weapon.damage_done', unit: 'damage' },
        'damage possible': { metricKey: 'kovaak.weapon.damage_possible', unit: 'damage' }
    };

    /**
     * 測定条件（metric ではなく session の属性へ入る）。
     * `horiz sens` / `vert sens` は candidates として別扱いにするためここに入れない。
     */
    var FOOTER_CONTEXT_KEYS = {
        'dpi': 'dpi',
        'fov': 'fov',
        'fovscale': 'fovScale',
        'resolution': 'resolution',
        'resolution scale': 'resolutionScale',
        'scenario': 'scenarioFromFooter',
        'game version': 'sourceAppVersion',
        'hash': 'sourceHash',
        // 3.9.8 では設定が武器行ではなくフッターにある
        'sens scale': 'sensScale',
        'sens increment': 'sensIncrement',
        'avg target scale': 'avgTargetScale',
        'avg time dilation': 'avgTimeDilation',
        'input lag': 'inputLag',
        'max fps (config)': 'maxFps',
        'hide gun': 'hideGun',
        'challenge start': 'challengeStartClock'
    };

    var WEAPON_CONTEXT_KEYS = {
        'sens scale': 'sensScale',
        'fov': 'fovFromWeaponRow',
        'ads sens': 'adsSens',
        'ads zoom scale': 'adsZoomScale',
        'avg target scale': 'avgTargetScale',
        'avg time dilation': 'avgTimeDilation',
        'hide gun': 'hideGun'
    };

    // ------------------------------------------------------------ 小道具

    function stripBom(text) {
        return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    }

    /** CRLF / CR / LF を LF へ揃える。改行コードで結果が変わらないようにする。 */
    function normalizeEol(text) {
        return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }

    /** 引用符を考慮しない単純なCSV分割。KovaaKの出力に引用符は観測されていない。 */
    function splitCsvLine(line) {
        return line.split(',').map(function (c) { return c.trim(); });
    }

    function toNumber(raw) {
        if (raw === undefined || raw === null) return null;
        var s = String(raw).trim();
        if (s === '' || s === '-' || s.toLowerCase() === 'n/a') return null;
        // 実ファイルで観測された単位付き表記に対応する。
        //   TTK: "7.649000s"  /  旧形式の感度: "6.50%"
        s = s.replace('%', '');
        if (/^-?[0-9.]+s$/.test(s)) s = s.slice(0, -1);
        var n = Number(s);
        return isFinite(n) ? n : null;
    }

    /**
     * raw_content_hash — 元ファイルの実バイト列に対する SHA-256。
     *
     * 【logical_fingerprint とは別物】
     * raw_content_hash は「バイト列が同一か」だけを見る。ファイル名や改行コードが
     * 違えば別のハッシュになる。同一runなのに表現が違う場合を検知する
     * logical_fingerprint は意味ベースの別概念で、Phase D では実装しない。
     * この2つを同じ列・同じ意味として扱ってはいけない。
     */
    async function rawContentHash(bytesOrText) {
        var data;
        if (typeof bytesOrText === 'string') {
            data = new TextEncoder().encode(bytesOrText);
        } else {
            data = bytesOrText;
        }
        var digest = await crypto.subtle.digest('SHA-256', data);
        var out = '';
        var view = new Uint8Array(digest);
        for (var i = 0; i < view.length; i++) {
            out += ('00' + view[i].toString(16)).slice(-2);
        }
        return out;
    }

    function warn(list, level, code, message, extra) {
        var w = { level: level, code: code, message: message };
        if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) w[k] = extra[k];
        list.push(w);
        return w;
    }

    // ------------------------------------------------------- ファイル名解析

    /**
     * `<scenario> - Challenge - <YYYY.MM.DD-HH.MM.SS> Stats.csv`
     * シナリオ名自体に ' - ' を含みうるため、**右から**分割する。
     */
    function parseFileName(name) {
        if (typeof name !== 'string' || name.slice(-FILENAME_SUFFIX.length) !== FILENAME_SUFFIX) {
            return { ok: false, reason: 'suffix_mismatch' };
        }
        var body = name.slice(0, -FILENAME_SUFFIX.length);
        var idx = body.lastIndexOf(FILENAME_SEP);
        if (idx < 0) return { ok: false, reason: 'separator_missing' };

        var scenario = body.slice(0, idx);
        var ts = body.slice(idx + FILENAME_SEP.length);
        var m = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2})$/.exec(ts);
        if (!m) return { ok: false, reason: 'timestamp_unparsable', scenario: scenario, rawTimestamp: ts };

        return {
            ok: true,
            scenario: scenario,
            // タイムゾーン情報が無いため、ここでは文字列として保持し UTC 断定をしない
            localTimestamp: m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6],
            tzKnown: false
        };
    }

    // -------------------------------------------------------- ブロック分割

    /** 空行で区切られたブロックへ分ける。 */
    function splitBlocks(text) {
        return normalizeEol(stripBom(text))
            .split(/\n\s*\n/)
            .map(function (b) { return b.replace(/\s+$/, ''); })
            .filter(function (b) { return b.trim() !== ''; });
    }

    function blockLines(block) {
        return block.split('\n').filter(function (l) { return l.trim() !== ''; });
    }

    // ------------------------------------------------------ format detection

    /**
     * 形式を判別する。推測で解析しないための入口。
     * @returns {{format:string, confidence:number, signals:string[], reasons:string[]}}
     */
    function detectFormat(file) {
        var signals = [];
        var reasons = [];
        var name = file && file.name;
        var text = (file && file.text) || '';

        var fn = parseFileName(name);
        if (fn.ok) signals.push('filename_matches_challenge_stats');
        else reasons.push('filename: ' + fn.reason);

        var blocks = splitBlocks(text);
        if (blocks.length === 0) {
            return { format: FORMATS.UNSUPPORTED, confidence: 0, signals: signals, reasons: reasons.concat(['empty_file']) };
        }

        var first = blockLines(blocks[0])[0] || '';
        var hasKillHeader = first.indexOf('Kill #,') === 0;
        if (hasKillHeader) signals.push('kill_header_present');
        else reasons.push('first block does not start with "Kill #,"');

        var lower = normalizeEol(text).toLowerCase();

        // 実ファイル（3.9.8）で確認した判別材料。
        // 旧来の想定と違い、3.9.x は Kill/Weapon/Summary/Settings の4ブロック構成を
        // 保ったまま Accuracy 列とフッターの DPI 等が増えている。したがって
        // 「セクション構成」や「Timestamp書式」では世代を判別できない。
        // 決定打はフッターに DPI: があるかどうか。
        var hasAccuracyCol = hasKillHeader && first.toLowerCase().indexOf('accuracy') >= 0;
        var hasDpiFooter = /(^|\n)dpi:,/.test(lower);
        var hasSensIncrement = /(^|\n)sens increment:,/.test(lower);
        var hasResolution = /(^|\n)resolution:,/.test(lower);
        var hasLegacyMarkers = /(^|\n)(scenario:|game version:|input lag:)/.test(lower);

        if (hasAccuracyCol) signals.push('kill_header_has_accuracy');
        if (hasDpiFooter) signals.push('footer_has_dpi');
        if (hasSensIncrement) signals.push('footer_has_sens_increment');
        if (hasResolution) signals.push('footer_has_resolution');
        if (hasLegacyMarkers) signals.push('section_markers_present');

        // Kill 行の Timestamp 書式は世代判別に使わない。実ファイルは時刻表記だった。
        if (hasKillHeader) {
            var rows = blockLines(blocks[0]);
            if (rows.length > 1) {
                var cells = splitCsvLine(rows[1]);
                var tsIdx = splitCsvLine(first).map(function (h) { return h.toLowerCase(); }).indexOf('timestamp');
                var tsVal = tsIdx >= 0 ? cells[tsIdx] : undefined;
                if (tsVal !== undefined) {
                    if (/^\d+(\.\d+)?$/.test(tsVal)) signals.push('timestamp_elapsed_seconds');
                    else if (/^\d{1,2}:\d{2}:\d{2}[:.]\d{1,3}$/.test(tsVal)) signals.push('timestamp_clock');
                    else reasons.push('timestamp style unrecognized: ' + tsVal);
                }
            }
        }

        // ゲーム版を拾う（判別ではなく記録用）
        var gv = /(^|\n)game version:,([^\n\r]*)/.exec(lower);
        if (gv) signals.push('game_version:' + gv[2].trim());

        if (!hasKillHeader) {
            return { format: FORMATS.UNSUPPORTED, confidence: 0, signals: signals, reasons: reasons };
        }

        // 現行（3.9.x）: フッターに DPI がある
        if (hasDpiFooter) {
            var extra = (hasAccuracyCol ? 1 : 0) + (hasSensIncrement ? 1 : 0) + (hasResolution ? 1 : 0);
            return {
                format: FORMATS.CURRENT,
                confidence: Math.min(1, 0.7 + extra * 0.1),
                signals: signals, reasons: reasons
            };
        }

        // 旧: DPI が無く、セクションマーカーはある
        if (hasLegacyMarkers) {
            return { format: FORMATS.LEGACY, confidence: 0.7, signals: signals, reasons: reasons };
        }

        reasons.push('footer に DPI: が無く、旧形式のマーカーも見つからないため世代を決められない');
        return { format: FORMATS.UNSUPPORTED, confidence: 0, signals: signals, reasons: reasons };
    }

    // --------------------------------------------------------------- parse

    /** `Key:,Value` 形式の行をマップにする。 */
    function parseKeyValueBlock(block) {
        var out = {};
        blockLines(block).forEach(function (line) {
            var cells = splitCsvLine(line);
            var key = cells[0] || '';
            if (key.slice(-1) !== ':') return;
            out[key.slice(0, -1).trim().toLowerCase()] = cells.length > 1 ? cells.slice(1).join(',').trim() : '';
        });
        return out;
    }

    function parseTableBlock(block) {
        var lines = blockLines(block);
        if (lines.length === 0) return { headers: [], rows: [] };
        var headers = splitCsvLine(lines[0]);
        var rows = [];
        for (var i = 1; i < lines.length; i++) {
            var cells = splitCsvLine(lines[i]);
            var row = {};
            for (var j = 0; j < headers.length; j++) row[headers[j]] = cells[j];
            row.__cellCount = cells.length;
            rows.push(row);
        }
        return { headers: headers, rows: rows };
    }

    /**
     * 1ファイルを解析する。例外は投げない。
     */
    async function parseFile(file, detection, warnings, unknownFields) {
        var text = stripBom(String(file.text || ''));
        var blocks = splitBlocks(text);
        var fn = parseFileName(file.name);

        var killBlock = null, weaponBlock = null;
        var kvBlocks = [];

        blocks.forEach(function (b) {
            var head = blockLines(b)[0] || '';
            if (head.indexOf('Kill #,') === 0) killBlock = b;
            else if (head.indexOf('Weapon,') === 0) weaponBlock = b;
            else kvBlocks.push(b);
        });

        var kills = killBlock ? parseTableBlock(killBlock) : { headers: [], rows: [] };
        var weapon = weaponBlock ? parseTableBlock(weaponBlock) : { headers: [], rows: [] };

        // 旧形式は Summary / Settings が別ブロック、現行は平坦フッター。
        // どちらも Key:,Value なので統合して読む（キー衝突は後勝ちにせず先勝ちで記録）。
        var footer = {};
        kvBlocks.forEach(function (b) {
            var kv = parseKeyValueBlock(b);
            for (var k in kv) {
                if (!kv.hasOwnProperty(k)) continue;
                if (footer.hasOwnProperty(k) && footer[k] !== kv[k]) {
                    warn(warnings, 'warn', 'duplicate_footer_key',
                        'フッターに同じキーが異なる値で複数回現れました: ' + k,
                        { file: file.name, first: footer[k], second: kv[k] });
                    continue;
                }
                footer[k] = kv[k];
            }
        });

        // 壊れた行の検出（列数がヘッダと合わない）
        kills.rows.forEach(function (r, i) {
            if (r.__cellCount !== kills.headers.length) {
                warn(warnings, 'warn', 'kill_row_column_mismatch',
                    'Kill行の列数がヘッダと一致しません', { file: file.name, line: i + 2, expected: kills.headers.length, actual: r.__cellCount });
            }
        });

        return {
            fileName: file.name,
            fileMeta: fn,
            format: detection.format,
            killHeaders: kills.headers,
            killRows: kills.rows,
            weaponHeaders: weapon.headers,
            weaponRows: weapon.rows,
            footer: footer,
            rawContentHash: await rawContentHash(text),
            rawContentHashAlgo: 'sha-256'
        };
    }

    // ---------------------------------------------------------- validation

    function validate(parsed) {
        var errors = [];
        var warnings = [];

        if (!parsed.fileMeta || !parsed.fileMeta.ok) {
            errors.push({ code: 'filename_unparsable', message: 'ファイル名から シナリオ名と日時 を取得できません', file: parsed.fileName });
        }
        if (toNumber(parsed.footer['score']) === null) {
            errors.push({ code: 'score_missing', message: 'フッターに有効な Score がありません', file: parsed.fileName });
        }
        if (parsed.killRows.length === 0) {
            warnings.push({ level: 'warn', code: 'no_kill_rows', message: 'Kill行がありません', file: parsed.fileName });
        }

        // Kills と Kill行数の整合（不一致でも取込は止めない）
        var killsDeclared = toNumber(parsed.footer['kills']);
        if (killsDeclared !== null && parsed.killRows.length > 0 && killsDeclared !== parsed.killRows.length) {
            warnings.push({
                level: 'warn', code: 'kill_count_mismatch',
                message: 'Kills の宣言値と Kill行数が一致しません', file: parsed.fileName,
                declared: killsDeclared, rows: parsed.killRows.length
            });
        }

        return { ok: errors.length === 0, errors: errors, warnings: warnings };
    }

    // -------------------------------------------------------- normalization

    /**
     * Normalized 層のみを作る。**Derived は一切計算しない。**
     * accuracy / cm360 / score_per_min 等の導出はこの段階では行わない。
     */
    function normalize(parsed, warnings, unknownFields) {
        var metrics = [];
        var context = {};
        var unresolved = [];

        // --- フッター
        var IGNORED_FOOTER_KEYS = { 'crosshair': 1, 'crosshair scale': 1, 'crosshair color': 1 };

        for (var key in parsed.footer) {
            if (!parsed.footer.hasOwnProperty(key)) continue;
            var raw = parsed.footer[key];

            if (key === 'horiz sens' || key === 'vert sens') continue; // 後段で candidates として扱う
            if (IGNORED_FOOTER_KEYS[key]) continue;                    // 表示設定。分析に使わない

            if (FOOTER_METRIC_MAP[key]) {
                var def = FOOTER_METRIC_MAP[key];
                var v = toNumber(raw);
                if (v === null) {
                    warn(warnings, 'warn', 'value_not_numeric', 'フッターの値を数値化できません: ' + key, { file: parsed.fileName, raw: raw });
                } else {
                    metrics.push({ metricKey: def.metricKey, value: v, unit: def.unit, rawText: String(raw) });
                }
            } else if (FOOTER_CONTEXT_KEYS[key]) {
                context[FOOTER_CONTEXT_KEYS[key]] = raw;
            } else {
                unknownFields.push({ section: 'footer', key: key, sample: String(raw).slice(0, 32), file: parsed.fileName });
            }
        }

        // --- 武器行: **全件を weapon レベルの記録として保持する**
        //
        // Adapter は代表武器を選ばず、合算もしない（Phase D 承認時の指示）。
        //   Raw weapon rows → Normalized weapon-level records → Derived aggregation
        // 集約・重み付け・代表値の決定は Long Cape 独自計算であり Derived 層の責務。
        //
        // なお設定列（Sens Scale / FOV / ADS 等）は武器ではなく **セッションの測定条件** を
        // 表すため、行をまたいで同一であることを確認したうえで context へ入れる。
        // これは「代表武器の選択」ではない。
        var weapons = [];
        var sessionContextFromRows = {};
        var contextConflicts = {};

        parsed.weaponRows.forEach(function (wrow, rowIndex) {
            var wMetrics = [];
            var wName = null;

            parsed.weaponHeaders.forEach(function (h) {
                if (h === '' || h === undefined) return;          // 区切りの空列
                var lk = h.trim().toLowerCase();

                if (lk === 'weapon') { wName = wrow[h]; return; }
                if (lk === 'horiz sens' || lk === 'vert sens') return; // candidates 側で扱う
                if (lk === 'crosshair' || lk === 'crosshair scale' || lk === 'crosshair color') return; // 表示設定

                // 3.9.8 の武器行はヘッダに設定名が並ぶが、データ行には武器統計しか無い。
                // 値が存在しない列は欠損ではなく「その版では使われていない列」なので警告しない。
                if (wrow[h] === undefined || String(wrow[h]).trim() === '') return;

                if (WEAPON_METRIC_MAP[lk]) {
                    var d = WEAPON_METRIC_MAP[lk];
                    var v = toNumber(wrow[h]);
                    if (v === null) {
                        warn(warnings, 'warn', 'value_not_numeric',
                            '武器行の値を数値化できません: ' + h,
                            { file: parsed.fileName, weaponRow: rowIndex, raw: wrow[h] });
                    } else {
                        wMetrics.push({ metricKey: d.metricKey, value: v, unit: d.unit, rawText: String(wrow[h]) });
                    }
                } else if (WEAPON_CONTEXT_KEYS[lk]) {
                    // セッション条件。行をまたいで食い違えば警告し、先勝ちで保持する
                    var ck = WEAPON_CONTEXT_KEYS[lk];
                    if (sessionContextFromRows.hasOwnProperty(ck)) {
                        if (sessionContextFromRows[ck] !== wrow[h]) contextConflicts[ck] = true;
                    } else {
                        sessionContextFromRows[ck] = wrow[h];
                    }
                } else {
                    unknownFields.push({
                        section: 'weapon', key: h,
                        sample: String(wrow[h]).slice(0, 32), file: parsed.fileName
                    });
                }
            });

            weapons.push({
                index: rowIndex,
                weapon: wName,
                metrics: wMetrics
            });
        });

        for (var ck2 in sessionContextFromRows) {
            if (sessionContextFromRows.hasOwnProperty(ck2)) context[ck2] = sessionContextFromRows[ck2];
        }
        for (var cf in contextConflicts) {
            if (!contextConflicts.hasOwnProperty(cf)) continue;
            warn(warnings, 'warn', 'weapon_row_context_conflict',
                '武器行によってセッション条件の値が異なります: ' + cf,
                { file: parsed.fileName, field: cf });
        }
        if (weapons.length > 1) {
            warn(warnings, 'info', 'multiple_weapons_present',
                '武器が複数あります。全件を weapon レベルで保持しました（集約はDerived層の責務）',
                { file: parsed.fileName, count: weapons.length });
        }

        // --- Kill ヘッダの未知列を記録（値の正規化はしない）
        parsed.killHeaders.forEach(function (h) {
            var known = ['Kill #', 'Timestamp', 'Bot', 'Weapon', 'TTK', 'Shots', 'Hits',
                'Accuracy', 'Damage Done', 'Damage Possible', 'Efficiency', 'Cheated', 'OverShots'];
            if (known.indexOf(h) < 0 && h !== '') {
                unknownFields.push({ section: 'kill', key: h, sample: '', file: parsed.fileName });
            }
        });

        // --- 時刻の意味。実ファイルで確認したところ、**ファイル名の日時は終了時刻**で、
        // 開始時刻はフッターの Challenge Start にある（時刻のみで日付を含まない）。
        if (context.challengeStartClock) {
            context.challengeStartClockOnly = context.challengeStartClock;
            context.filenameTimestampMeaning = 'challenge_end';
        } else {
            context.filenameTimestampMeaning = 'unknown';
        }

        // --- DPI の出どころ
        //
        // 【重要・実測で判明】KovaaK の DPI 欄は **ユーザーが手で入力する設定値**であって、
        // マウスの実際のDPIを検出したものではない。KovaaK 自身の cm/360 表示にしか使われず、
        // 入力を忘れる／変え忘れると実機と食い違う。
        // 実際、最初の実ファイルで「ファイル 400 / 実機 800」の食い違いが確認された。
        // この差はそのまま cm/360 の2倍の誤差になるため、**自己申告として扱い、
        // ユーザーの確認を必須とする**。ファイルにあることを「確定」と同一視しない。
        var dpi = toNumber(context.dpi);
        context.dpi = dpi;
        context.dpiSource = dpi === null ? 'unknown' : 'file_self_declared';
        context.dpiNeedsConfirmation = dpi !== null;

        // --- Horiz Sens は **正規化しない**（Phase D の禁止事項）
        var candidates = [];
        var candidatesExtra = [];
        var wHorizVals = [];
        parsed.weaponRows.forEach(function (wr) {
            parsed.weaponHeaders.forEach(function (h) {
                if (String(h).trim().toLowerCase() === 'horiz sens') {
                    var v = toNumber(wr[h]);
                    if (v !== null && wHorizVals.indexOf(v) < 0) wHorizVals.push(v);
                }
            });
        });
        var wHoriz = wHorizVals.length === 1 ? wHorizVals[0] : null;
        if (wHorizVals.length > 1) {
            wHorizVals.forEach(function (v, i) { candidatesExtra.push({ origin: 'weapon_row[' + i + ']', value: v }); });
        }
        var fHoriz = toNumber(parsed.footer['horiz sens']);
        if (wHoriz !== null) candidates.push({ origin: 'weapon_row', value: wHoriz });
        candidatesExtra.forEach(function (c) { candidates.push(c); });
        if (fHoriz !== null) candidates.push({ origin: 'footer', value: fHoriz });

        if (candidates.length > 0) {
            unresolved.push({
                field: 'in_game_sens',
                reason: candidates.length > 1 ? 'horiz_sens_multiple_sources' : 'horiz_sens_single_source_unverified',
                candidates: candidates,
                note: '実ファイル検証まで in_game_sens を確定しない（Phase C.5 未確定事項2）'
            });
        }
        if (dpi !== null) {
            unresolved.push({
                field: 'dpi_verified',
                reason: 'file_value_is_self_declared',
                candidates: [{ origin: 'file', value: dpi }],
                note: 'KovaaKのDPI欄は手入力の設定値であり実機DPIとは限らない。'
                    + '実測で「ファイル400 / 実機800」の食い違いを確認済み。ユーザー確認が必要。'
            });
        }

        var cmBlockers = ['in_game_sens'];
        if (dpi === null) cmBlockers.push('dpi_missing');
        else cmBlockers.push('dpi_unverified');
        unresolved.push({
            field: 'cm360',
            reason: 'blocked_by:' + cmBlockers.join(','),
            note: 'cm/360 は in_game_sens と実機DPIの両方が確定するまで自動算出しない。'
                + 'DPIが2倍違えば cm/360 も2倍ずれる。'
        });

        return { metrics: metrics, weapons: weapons, context: context, unresolved: unresolved };
    }

    // ---------------------------------------------------------- provenance

    /**
     * Phase B 最終条件4。原本を保存しない場合でも来歴を必ず残す。
     */
    function buildProvenance(parsed, adapter, importedAt) {
        return {
            source: adapter.source,
            sourceType: adapter.sourceType,
            sourceIdentifier: parsed.fileName,
            rawContentHash: parsed.rawContentHash,
            rawContentHashAlgo: parsed.rawContentHashAlgo,
            // 意味ベースの識別子。raw_content_hash とは別物で、Phase D では未実装。
            logicalFingerprint: null,
            logicalFingerprintStatus: 'not_implemented_phase_d',
            parserVersion: PARSER_VERSION,
            normalizationVersion: NORMALIZATION_VERSION,
            importedAt: importedAt,
            consentId: null,          // プロトタイプでは同意を取得しない
            rawStored: false,
            notStoredReason: 'phase_d_prototype_no_persistence'
        };
    }

    /** 重複判定キー。ファイル名 + シナリオ + Score + 内容ハッシュ。 */
    async function computeExternalId(parsed) {
        var scenario = (parsed.fileMeta && parsed.fileMeta.scenario) || '';
        var score = parsed.footer['score'] || '';
        // 現段階の重複判定キー。raw_content_hash を含むためバイト列が違えば別IDになる。
        // ファイル名や改行が違う同一runを同一視する logical_fingerprint は別概念で、
        // ここでは実装しない（Phase D 承認時の指示）。
        return await rawContentHash([parsed.fileName, scenario, score, parsed.rawContentHash].join('|'));
    }

    // ------------------------------------------------------------ pipeline

    /**
     * 複数ファイルを一括処理する。DBにも本番にも一切触れない。
     * @param {{name:string,text:string}[]} files
     * @param {{importedAt?:string}} [opts]
     */
    async function run(files, opts) {
        opts = opts || {};
        var importedAt = opts.importedAt || new Date().toISOString();
        var warnings = [];
        var unknownFields = [];
        var sessions = [];
        var rejected = [];
        var seen = {};
        var duplicatesInBatch = 0;

        var fileList = files || [];
        for (var fi = 0; fi < fileList.length; fi++) {
            var file = fileList[fi];
            var detection = detectFormat(file);

            if (detection.format === FORMATS.UNSUPPORTED) {
                rejected.push({
                    file: file.name, format: detection.format,
                    reasons: detection.reasons, signals: detection.signals
                });
                warn(warnings, 'error', 'unsupported_format',
                    '未対応の形式のため解析していません', { file: file.name, reasons: detection.reasons });
                continue; // 推測解析しない
            }
            if (detection.format === FORMATS.TIMESERIES) {
                rejected.push({ file: file.name, format: detection.format, reasons: ['timeseries format not implemented'] });
                warn(warnings, 'error', 'format_not_implemented',
                    '秒単位データ形式は仕様未確定のため未対応です', { file: file.name });
                continue;
            }

            var parsed = await parseFile(file, detection, warnings, unknownFields);
            var v = validate(parsed);
            v.warnings.forEach(function (w) { warnings.push(w); });

            if (!v.ok) {
                rejected.push({ file: file.name, format: detection.format, errors: v.errors });
                v.errors.forEach(function (e) {
                    warn(warnings, 'error', e.code, e.message, { file: e.file });
                });
                continue;
            }

            var norm = normalize(parsed, warnings, unknownFields);
            var externalId = await computeExternalId(parsed);

            if (seen[externalId]) {
                duplicatesInBatch++;
                warn(warnings, 'info', 'duplicate_in_batch',
                    '同一内容のファイルが複数あります', { file: file.name, firstSeen: seen[externalId] });
                continue;
            }
            seen[externalId] = file.name;

            sessions.push({
                externalId: externalId,
                format: detection.format,
                formatConfidence: detection.confidence,
                scenario: (parsed.fileMeta && parsed.fileMeta.scenario) || null,
                localTimestamp: (parsed.fileMeta && parsed.fileMeta.localTimestamp) || null,
                tzKnown: false,
                killRowCount: parsed.killRows.length,
                metrics: norm.metrics,
                weapons: norm.weapons,
                context: norm.context,
                unresolved: norm.unresolved,
                provenance: buildProvenance(parsed, adapter, importedAt)
            });
        }

        return {
            sessions: sessions,
            rejected: rejected,
            warnings: warnings,
            unknownFields: unknownFields,
            stats: {
                filesReceived: (files || []).length,
                sessionsParsed: sessions.length,
                filesRejected: rejected.length,
                duplicatesInBatch: duplicatesInBatch
            }
        };
    }

    /**
     * 取込前プレビュー。ここで表示して、保存はしない。
     */
    function buildPreview(result) {
        var scenarios = {};
        var formats = {};
        var earliest = null, latest = null;

        result.sessions.forEach(function (s) {
            scenarios[s.scenario] = (scenarios[s.scenario] || 0) + 1;
            formats[s.format] = (formats[s.format] || 0) + 1;
            if (s.localTimestamp) {
                if (!earliest || s.localTimestamp < earliest) earliest = s.localTimestamp;
                if (!latest || s.localTimestamp > latest) latest = s.localTimestamp;
            }
        });

        var errors = result.warnings.filter(function (w) { return w.level === 'error'; });
        var warns = result.warnings.filter(function (w) { return w.level === 'warn'; });

        var dpiSelfDeclared = result.sessions.filter(function (s) {
            return s.context.dpiSource === 'file_self_declared';
        }).length;

        return {
            summary: {
                filesReceived: result.stats.filesReceived,
                sessionsParsed: result.stats.sessionsParsed,
                filesRejected: result.stats.filesRejected,
                duplicatesInBatch: result.stats.duplicatesInBatch,
                errorCount: errors.length,
                warningCount: warns.length,
                unknownFieldCount: result.unknownFields.length
            },
            period: { earliest: earliest, latest: latest, tzKnown: false },
            scenarios: scenarios,
            formats: formats,
            dpi: {
                selfDeclaredInFile: dpiSelfDeclared,
                missing: result.stats.sessionsParsed - dpiSelfDeclared,
                // ファイルに書いてあっても確定ではない。全件ユーザー確認が要る。
                needsUserConfirmation: result.stats.sessionsParsed,
                note: 'KovaaKのDPI欄は手入力の設定値。実機DPIと食い違いうるため必ず確認する。'
            },
            weapons: (function () {
                var names = {}; var maxPer = 0;
                result.sessions.forEach(function (s) {
                    var ws = s.weapons || [];
                    if (ws.length > maxPer) maxPer = ws.length;
                    ws.forEach(function (w) { if (w.weapon) names[w.weapon] = (names[w.weapon] || 0) + 1; });
                });
                return { distinctWeapons: Object.keys(names), perWeaponSessionCount: names, maxPerSession: maxPer };
            })(),
            unresolvedFields: (function () {
                var acc = {};
                result.sessions.forEach(function (s) {
                    s.unresolved.forEach(function (u) { acc[u.field] = (acc[u.field] || 0) + 1; });
                });
                return acc;
            })(),
            persistence: {
                willSave: false,
                reason: 'Phase D prototype — 本番DB保存とRecommendation投入は禁止されている'
            }
        };
    }

    // ------------------------------------------------------------- 公開

    var adapter = {
        source: 'kovaak',
        sourceType: 'aim_trainer',
        parserVersion: PARSER_VERSION,
        normalizationVersion: NORMALIZATION_VERSION,
        productionReady: false,
        notProductionReadyReason: '実ファイル未検証（fixtureのみ）／in_game_sens 未確定',

        FORMATS: FORMATS,
        accepts: { extensions: ['.csv'], maxBytes: 2 * 1024 * 1024, maxFiles: 500 },

        // 各段階を個別に呼べるようにしてテストしやすくする
        parseFileName: parseFileName,
        detectFormat: detectFormat,
        parseFile: parseFile,
        validate: validate,
        normalize: normalize,
        computeExternalId: computeExternalId,
        buildProvenance: buildProvenance,
        run: run,
        buildPreview: buildPreview
    };

    root.LC_IMPORTERS = root.LC_IMPORTERS || {};
    root.LC_IMPORTERS.kovaak = adapter;
})(typeof globalThis !== 'undefined' ? globalThis : this);
