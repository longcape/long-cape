/**
 * ロングケープの定理 — 診断結果レポート Ver.2 と診断履歴（index.html 用）
 *
 * ここにあるのは「表示・単位の換算・比較」だけで、**感度の計算式には一切触れない**。
 * 推奨値そのものは従来どおり index.html の calculateEDPI() が出す。
 *
 * 単位の決まり（2026-10-10 の仕様修正）:
 *   - 利用者に見せるのは「ゲーム内感度」と「eDPI」だけ。cm/360（振り向き距離）は出さない
 *   - eDPI = マウスDPI × ゲーム内感度（どのタイトルでも同じ定義）
 *   - eDPI が同じでも、タイトルが違えば視点の回る量は違う。
 *     タイトルをまたぐ換算・比較は、タイトルごとの感度倍率（1カウントあたりの回転角）を通す
 *   - タイトルをまたぐ比較に使う共通の基準値（回転量）は内部だけで使い、画面には出さない
 *
 * 守っていること:
 *   - 確率としての信頼度（「信頼度 81%」など）や統計的な信頼区間を作らない
 *   - 新しい補正係数・推定式を作らない（履歴は比較と可視化のみ）
 *   - 感度の変化と成績の変化の因果を言わない
 *   - 倍率を確認できていないタイトルは、推測で換算しない
 *   - 履歴はこの端末の localStorage だけに置く（サーバー・DB・calc_logs の5件枠に触れない）
 *
 * このファイルが読み込めなくても、index.html の診断は従来どおり動く。
 */
(function (root) {
    'use strict';

    var VERSION = '2.1.0';
    var HISTORY_KEY = 'lc_diag_history_v1';
    var HISTORY_SCHEMA = 1;

    // ------------------------------------------------------- タイトルごとの感度倍率
    //
    // yaw = ゲーム内感度 1・マウス 1 カウントで視点が回る角度（度）。**推測で増やさない。**
    // 載せる条件: 広く知られた値であること、かつ games.json の scale（診断が実際に使っている
    // VALORANT 比の単位変換）と 0.5% 以内で一致すること（auditYaw と tests/diag-report.mjs が検査）。
    //
    // Delta Force と PUBG は、突き合わせる既知の値を確認できていないため載せていない
    // （PUBG は設定値が対数スケールで、倍率ひとつでは表せない）。この2つは他タイトルと換算しない。
    //
    // CS2 は診断の選択肢では「VALORANT / CS2」と1つにまとめられているが、
    // 倍率は VALORANT と約 3.18 倍違う。換算のためだけに別の行として持つ。
    var YAW = {
        valo: { yaw: 0.07, basis: 'VALORANT。1カウントあたり 0.07 度。games.json の基準（scale 1）。' },
        cs2: { yaw: 0.022, name: 'CS2', conversionOnly: true, expectScale: 3.18,
               basis: 'Source 系の m_yaw 0.022。VALORANT の感度 × 3.18 が広く使われる換算。' },
        apex: { yaw: 0.022, basis: 'Source 系の 0.022。games.json の scale 3.18 と一致。' },
        ow: { yaw: 0.0066, basis: '1カウントあたり 0.0066 度。games.json の scale 10.6 と一致。' },
        fn: { yaw: 0.005555, basis: '感度%で 1カウントあたり 0.005555 度。games.json の scale 12.6 と一致。' },
        cod: { yaw: 0.0066, basis: '1カウントあたり 0.0066 度。games.json の scale 10.6 と一致。' }
    };
    var EXTRA_TITLES = [{ key: 'cs2', name: 'CS2' }];
    var SCALE_TOLERANCE = 0.005;

    function isNum(v) { return typeof v === 'number' && isFinite(v); }
    function round(v, d) { var p = Math.pow(10, d); return Math.round(v * p) / p; }
    function hasYaw(key) { return Object.prototype.hasOwnProperty.call(YAW, key); }

    /** eDPI = DPI × ゲーム内感度。タイトルによらず同じ定義。 */
    function edpi(dpi, sens) {
        if (!isNum(dpi) || !isNum(sens) || dpi <= 0 || sens <= 0) return null;
        return round(dpi * sens, 1);
    }

    /**
     * 内部用の共通基準値（マウスを 1 インチ動かしたときに視点が回る角度）。
     * タイトルをまたぐ比較にだけ使う。**画面には出さない。**
     */
    function rotation(gameKey, sens, dpi) {
        if (!hasYaw(gameKey) || !isNum(sens) || !isNum(dpi) || sens <= 0 || dpi <= 0) return null;
        return dpi * sens * YAW[gameKey].yaw;
    }

    /**
     * 視点の回転量が同じになる、別タイトル（または別 DPI）のゲーム内感度。
     *   target = source × (source の倍率 ÷ target の倍率) × (source の DPI ÷ target の DPI)
     * 同じタイトルで DPI だけ変える換算は、倍率が要らないので全タイトルで使える。
     */
    function convertSens(fromKey, toKey, sens, fromDpi, toDpi) {
        var td = (toDpi === undefined || toDpi === null) ? fromDpi : toDpi;
        if (!isNum(sens) || !isNum(fromDpi) || !isNum(td) || sens <= 0 || fromDpi <= 0 || td <= 0) {
            return { available: false, reason: 'missing_input' };
        }
        if (fromKey === toKey) return { available: true, value: sens * fromDpi / td };
        if (!hasYaw(fromKey) || !hasYaw(toKey)) return { available: false, reason: 'multiplier_not_verified' };
        return { available: true, value: sens * YAW[fromKey].yaw / YAW[toKey].yaw * fromDpi / td };
    }

    /** 倍率の表が games.json の scale と食い違っていないか。games = [{key, scale, sensTransform}] */
    function auditYaw(games) {
        var problems = [];
        var byKey = {};
        (games || []).forEach(function (g) { byKey[g.key] = g; });
        Object.keys(YAW).forEach(function (k) {
            var d = YAW[k];
            if (!isNum(d.yaw) || d.yaw <= 0) problems.push(k + ': yaw が不正です');
            if (!d.basis) problems.push(k + ': basis がありません');
            var scale = d.conversionOnly ? d.expectScale : (byKey[k] ? byKey[k].scale : null);
            if (!d.conversionOnly && !byKey[k]) { problems.push(k + ': games.json にありません'); return; }
            if (byKey[k] && byKey[k].sensTransform !== 'linear') problems.push(k + ': 線形でないタイトルは載せられません');
            var implied = YAW.valo.yaw / d.yaw;
            if (!isNum(scale) || Math.abs(implied - scale) / scale > SCALE_TOLERANCE) {
                problems.push(k + ': 倍率 ' + round(implied, 4) + ' が scale ' + scale + ' と一致しません');
            }
        });
        return { ok: problems.length === 0, problems: problems };
    }

    // ------------------------------------------------------ 根拠（入力ごとの寄与）

    var INPUT_KEYS = ['height', 'dexterity', 'armThickness', 'mouseWeight', 'aimPart'];

    /**
     * 既存の計算式が各入力に与えている補正（%）をそのまま並べる。新しい計算はしない。
     * config は index.html の dynamicConfig。
     */
    function breakdown(inputs, config) {
        var c = config || {};
        var i = inputs || {};
        function f(key) { return isNum(c[key]) ? c[key] : 0; }
        var h = parseFloat(i.height);
        var parts = [
            { key: 'height', value: isNum(h) ? (170 - h) * f('height_factor') : 0 },
            { key: 'dexterity', value: f('neuro_' + i.dexterity + '_factor') },
            { key: 'armThickness', value: f('arm_' + i.armThickness + '_factor') },
            { key: 'mouseWeight', value: f('weight_' + i.mouseWeight + '_factor') },
            { key: 'aimPart', value: f('pivot_' + i.aimPart + '_factor') }
        ];
        return parts.map(function (p) {
            var pct = round(p.value * 100, 1);
            return { key: p.key, pct: pct, dir: pct > 0 ? 'up' : (pct < 0 ? 'down' : 'none') };
        });
    }

    /** 診断時点の係数の指紋。入力が同じなのに結果が変わった理由（係数の更新）を説明するため。 */
    function coefFingerprint(config) {
        var c = config || {};
        return Object.keys(c).filter(function (k) {
            return /_factor$|^base_edpi$|_trim$/.test(k) && isNum(c[k]);
        }).sort().map(function (k) { return k + '=' + c[k]; }).join(';');
    }

    // ------------------------------------------------------ 現在の設定との比較

    var SAME_TOLERANCE_PCT = 1; // 表示上「ほぼ同じ」とみなす幅（丸めの誤差程度）

    /**
     * 推奨値と、利用者が入力した現在の感度を比べる（同じタイトル・同じ DPI）。
     * 中間値は about / トップの解説が以前から案内している「現在値と目標値の中間から始める」
     * をそのまま数値にしただけで、新しい推定ではない。
     */
    function compareCurrent(rec, cur, integerScale) {
        if (!isNum(rec) || !isNum(cur) || rec <= 0 || cur <= 0) return null;
        var mid = (rec + cur) / 2;
        if (integerScale) {
            // 対数スケールの設定値（PUBG）では割合に意味が無いので出さない
            return { pct: null, relation: rec === cur ? 'same' : (rec > cur ? 'higher' : 'lower'),
                     midpoint: Math.round(mid), lo: Math.min(rec, cur), hi: Math.max(rec, cur) };
        }
        var pct = round((rec - cur) / cur * 100, 1);
        var relation = Math.abs(pct) < SAME_TOLERANCE_PCT ? 'same' : (pct > 0 ? 'higher' : 'lower');
        // 設定画面に入れられる桁（小数3桁）へ丸める。eDPI もこの値から出す
        return { pct: pct, relation: relation, midpoint: round(mid, 3),
                 lo: Math.min(rec, cur), hi: Math.max(rec, cur) };
    }

    // ------------------------------------------------------------- 履歴
    //
    // 1行に持つのは「記録したときのタイトル・DPI・ゲーム内感度・入力」だけ。
    // eDPI や回転量は表示のたびに計算する（持たないので、式や倍率を直しても古い記録と食い違わない）。

    function validEntry(e) {
        if (!e || typeof e !== 'object') return false;
        if (typeof e.id !== 'string' || !e.id) return false;
        if (typeof e.at !== 'string' || isNaN(Date.parse(e.at))) return false;
        if (typeof e.game !== 'string' || !e.game) return false;
        if (!isNum(e.dpi) || e.dpi <= 0) return false;
        var s = parseFloat(e.sens);
        return isNum(s) && s > 0;
    }

    /** 保存文字列を履歴へ。壊れていても例外を出さず、読める行だけ古い順で返す。知らない項目は無視する。 */
    function parseHistory(raw) {
        if (!raw) return [];
        var data;
        try { data = JSON.parse(raw); } catch (e) { return []; }
        var list = data && Array.isArray(data.entries) ? data.entries : (Array.isArray(data) ? data : []);
        return list.filter(validEntry).slice().sort(function (a, b) {
            return Date.parse(a.at) - Date.parse(b.at);
        });
    }

    function serializeHistory(list) {
        return JSON.stringify({ schema: HISTORY_SCHEMA, entries: list });
    }

    function pickInputs(src) {
        var o = {};
        INPUT_KEYS.forEach(function (k) {
            var v = src ? src[k] : undefined;
            o[k] = (v === undefined || v === null) ? null : (k === 'height' ? Number(v) : String(v));
        });
        return o;
    }

    /**
     * 診断結果から履歴の1行を作る。
     * 現在の感度（cur）は利用者が入力したときだけ持つ（未入力なら項目ごと作らない）。
     */
    function makeEntry(result, now) {
        var r = result || {};
        var at = (now instanceof Date ? now : new Date()).toISOString();
        var e = {
            id: at + '-' + Math.random().toString(36).slice(2, 8),
            at: at,
            game: String(r.game),
            dpi: Number(r.dpi),
            sens: String(r.sens),
            inputs: pickInputs(r.inputs),
            coef: r.coef || null
        };
        var cur = parseFloat(r.currentSens);
        if (isNum(cur) && cur > 0) e.cur = String(r.currentSens);
        return e;
    }

    function fingerprint(e) {
        var i = e.inputs || {};
        return [e.game, e.dpi, e.sens, e.cur || '',
                INPUT_KEYS.map(function (k) { return i[k]; }).join(',')].join('|');
    }

    /** 直前の記録とまったく同じ内容なら足さない（ボタン連打・言語切替での重複を防ぐ）。 */
    function addEntry(list, entry) {
        if (!validEntry(entry)) return { list: list, added: false, reason: 'invalid' };
        var last = list.length ? list[list.length - 1] : null;
        if (last && fingerprint(last) === fingerprint(entry)) {
            return { list: list, added: false, reason: 'duplicate' };
        }
        return { list: list.concat([entry]), added: true, reason: null };
    }

    function removeEntry(list, id) {
        return list.filter(function (e) { return e.id !== id; });
    }

    function changedInputs(a, b) {
        var out = [];
        if (a.game !== b.game) out.push('game');
        if (a.dpi !== b.dpi) out.push('dpi');
        var x = a.inputs || {}, y = b.inputs || {};
        INPUT_KEYS.forEach(function (k) { if (String(x[k]) !== String(y[k])) out.push(k); });
        return out;
    }

    /**
     * 2つの記録の差。
     *   - 同じタイトル（線形の設定値）… eDPI で比べる（DPI が違っても比べられる）
     *   - 違うタイトル … 両方の倍率が確認済みなら、内部の回転量で比べる。
     *     **違うタイトルの eDPI をそのまま比べることはしない。**
     *   - どちらでもない（未確認の倍率・対数スケール）… 割合は出さない（null）
     */
    function compareEntries(from, to, integerScaleOf) {
        var res = { basis: null, pct: null, dir: 'none', changed: changedInputs(from, to),
                    coefChanged: !!(from.coef && to.coef && from.coef !== to.coef) };
        var a = null, b = null;
        if (from.game === to.game) {
            if (!(integerScaleOf && integerScaleOf(to.game))) {
                a = edpi(from.dpi, parseFloat(from.sens)); b = edpi(to.dpi, parseFloat(to.sens));
                res.basis = 'edpi';
            }
        } else {
            a = rotation(from.game, parseFloat(from.sens), from.dpi);
            b = rotation(to.game, parseFloat(to.sens), to.dpi);
            res.basis = (a !== null && b !== null) ? 'rotation' : null;
        }
        if (res.basis && isNum(a) && isNum(b) && a > 0) {
            res.pct = round((b - a) / a * 100, 1);
            res.dir = res.pct > 0 ? 'up' : (res.pct < 0 ? 'down' : 'none');
        } else {
            res.basis = null;
        }
        return res;
    }

    /**
     * 1つの記録を、表示用に選んだタイトルの設定値と eDPI へ直す（DPI は記録したときのまま）。
     * 同じタイトルならそのまま。違うタイトルは倍率が確認済みのときだけ。
     */
    function viewEntry(e, viewGame) {
        var s = parseFloat(e.sens);
        if (!viewGame || viewGame === e.game) {
            return { available: true, converted: false, game: e.game, sens: s, edpi: edpi(e.dpi, s) };
        }
        var c = convertSens(e.game, viewGame, s, e.dpi, e.dpi);
        if (!c.available) return { available: false, converted: true, game: viewGame };
        return { available: true, converted: true, game: viewGame, sens: c.value, edpi: edpi(e.dpi, c.value) };
    }

    /** 画面用の行（古い順）。初回比・前回比は毎回その場で計算するので、削除しても食い違わない。 */
    function historyRows(list, integerScaleOf, viewGame) {
        return list.map(function (e, idx) {
            return {
                entry: e,
                view: viewEntry(e, viewGame),
                isFirst: idx === 0,
                vsPrev: idx > 0 ? compareEntries(list[idx - 1], e, integerScaleOf) : null,
                vsFirst: idx > 0 ? compareEntries(list[0], e, integerScaleOf) : null
            };
        });
    }

    // ------------------------------------------------------------- 描画

    function fmtPct(p) { return (p > 0 ? '+' : '') + p.toFixed(1) + '%'; }
    function fmtEdpi(v) { return v === null ? '—' : String(round(v, 1)); }

    function fmtDate(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        function z(n) { return (n < 10 ? '0' : '') + n; }
        return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate())
            + ' ' + z(d.getHours()) + ':' + z(d.getMinutes());
    }

    /**
     * 選んだタイトルでの eDPI の推移。点が2つ未満なら空文字（無理に傾向を見せない）。
     * 横軸は記録の順番で等間隔に置く。件数が少なくても読めることを優先する。
     */
    function chartSvg(rows, label) {
        var pts = rows.filter(function (r) { return r.view.available && isNum(r.view.edpi); });
        if (pts.length < 2) return '';
        // スマホ幅（約 310px）でも文字が読める大きさになるよう、座標系を小さく取る
        var W = 360, H = 190, L = 46, R = 22, T = 24, B = 28;
        var vals = pts.map(function (r) { return r.view.edpi; });
        var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
        if (hi - lo < 1) { lo -= 1; hi += 1; }
        var pad = (hi - lo) * 0.15; lo -= pad; hi += pad;
        function x(i) { return L + (W - L - R) * i / (pts.length - 1); }
        function y(v) { return T + (H - T - B) * (1 - (v - lo) / (hi - lo)); }
        var path = pts.map(function (r, i) {
            return (i ? 'L' : 'M') + round(x(i), 1) + ' ' + round(y(r.view.edpi), 1);
        }).join(' ');
        var dots = pts.map(function (r, i) {
            return '<circle cx="' + round(x(i), 1) + '" cy="' + round(y(r.view.edpi), 1)
                + '" r="4" fill="#38bdf8"/>'
                + '<text x="' + round(x(i), 1) + '" y="' + round(y(r.view.edpi) - 9, 1)
                + '" text-anchor="middle" font-size="12" fill="#f8fafc">' + fmtEdpi(r.view.edpi) + '</text>';
        }).join('');
        var ticks = [lo + pad, hi - pad].map(function (v) {
            return '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + round(y(v), 1) + '" y2="' + round(y(v), 1)
                + '" stroke="#1e293b" stroke-width="1"/>'
                + '<text x="' + (L - 6) + '" y="' + round(y(v) + 4, 1)
                + '" text-anchor="end" font-size="11" fill="#94a3b8">' + fmtEdpi(v) + '</text>';
        }).join('');
        var xl = '<text x="' + L + '" y="' + (H - 8) + '" font-size="11" fill="#94a3b8">'
            + fmtDate(pts[0].entry.at).slice(0, 10) + '</text>'
            + '<text x="' + (W - R) + '" y="' + (H - 8) + '" text-anchor="end" font-size="11" fill="#94a3b8">'
            + fmtDate(pts[pts.length - 1].entry.at).slice(0, 10) + '</text>';
        return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + label
            + '" style="width:100%;height:auto;display:block">'
            + ticks + '<path d="' + path + '" fill="none" stroke="#38bdf8" stroke-width="2"/>'
            + dots + xl + '</svg>';
    }

    var FACTOR_LABEL = { height: 'drFHeight', dexterity: 'drFDex', armThickness: 'drFArm',
                         mouseWeight: 'drFWeight', aimPart: 'drFPivot', game: 'drFGame', dpi: 'drFDpi' };
    var DIR_LABEL = { up: 'drDirUp', down: 'drDirDown', none: 'drDirNone' };

    function section(title, body) {
        return '<div class="dr-sec"><div class="dr-h">' + title + '</div>' + body + '</div>';
    }
    function kv(label, value) {
        return '<div class="dr-kv"><span>' + label + '</span><b>' + value + '</b></div>';
    }

    /** 2つの記録の差を文章にする（レポートと履歴の両方で使う）。 */
    function diffText(cmp, h) {
        var T = h.T, esc = h.esc;
        var lines = [];
        if (cmp.basis === 'edpi') {
            lines.push(esc(T('drDiffEdpi', { pct: fmtPct(cmp.pct), dir: T(DIR_LABEL[cmp.dir]) })));
        } else if (cmp.basis === 'rotation') {
            lines.push(esc(T('drDiffRotation', { pct: fmtPct(cmp.pct), dir: T(DIR_LABEL[cmp.dir]) })));
        } else {
            lines.push(esc(T('drDiffNoBasis')));
        }
        if (cmp.changed.length) {
            lines.push(esc(T('drDiffChanged', {
                list: cmp.changed.map(function (k) { return T(FACTOR_LABEL[k]); }).join(' / ')
            })));
        } else {
            lines.push(esc(T('drDiffUnchanged')));
            if (cmp.pct !== null && cmp.pct !== 0 && cmp.coefChanged) lines.push(esc(T('drDiffCoef')));
        }
        return lines.join('<br>');
    }

    /**
     * 診断結果レポート。並びは「推奨ゲーム内感度 → eDPI → 範囲 → 根拠と不確かさ」。
     * r: { game, gameName, dpi, dpiAssumed, sens(数値), integerScale, baseEdpi, gameFactor,
     *      inputs, config, currentSens(数値|null), currentSensRejected, games:[{key,name}] }
     * h: { T(key, vars), esc(str), fmt(sens, gameKey), prev(直近の履歴 | null) }
     */
    function renderReport(r, h) {
        var T = h.T, esc = h.esc, fmt = h.fmt;
        var out = [];

        // --- 1・2. 推奨ゲーム内感度と eDPI
        var rec = kv(esc(T('drRecSens', { game: r.gameName })), esc(fmt(r.sens, r.game)))
            + kv(esc(T('drEdpi', { game: r.gameName })), esc(fmtEdpi(edpi(r.dpi, r.sens))))
            + kv('DPI', esc(String(r.dpi)))
            + '<p class="dr-note">' + esc(T('drEdpiNote')) + '</p>';
        if (r.game === 'valo') rec += '<p class="dr-note">' + esc(T('drValoOnly')) + '</p>';
        if (r.dpiAssumed) rec += '<p class="dr-note dr-warn">' + esc(T('drDpiAssumed')) + '</p>';
        out.push(section(esc(T('drRecTitle')), rec));

        // --- 3. 現在の設定・候補範囲・次に試す候補
        var cmp = isNum(r.currentSens) ? compareCurrent(r.sens, r.currentSens, r.integerScale) : null;
        if (!cmp) {
            out.push(section(esc(T('drCurTitle')), '<p>' + esc(T('drCurNone')) + '</p>'
                + (r.currentSensRejected ? '<p class="dr-note dr-warn">' + esc(T('drCurRejected')) + '</p>' : '')));
            out.push(section(esc(T('drNextTitle')), '<p>' + esc(T('drNextNoCur')) + '</p>'));
        } else {
            var relKey = { higher: 'drCurHigher', lower: 'drCurLower', same: 'drCurSame' }[cmp.relation];
            if (cmp.pct === null && cmp.relation !== 'same') relKey += 'NoPct';
            out.push(section(esc(T('drCurTitle')),
                kv(esc(T('drCurSens')), esc(fmt(r.currentSens, r.game)))
                + kv(esc(T('drEdpi', { game: r.gameName })), esc(fmtEdpi(edpi(r.dpi, r.currentSens))))
                + '<p>' + esc(T(relKey, { pct: cmp.pct === null ? '' : Math.abs(cmp.pct).toFixed(1) })) + '</p>'));
            if (cmp.relation === 'same') {
                out.push(section(esc(T('drNextTitle')), '<p>' + esc(T('drNextSame')) + '</p>'));
            } else {
                out.push(section(esc(T('drRangeTitle')), '<p>' + esc(T('drRangeBody', {
                    lo: fmt(cmp.lo, r.game), hi: fmt(cmp.hi, r.game),
                    elo: fmtEdpi(edpi(r.dpi, cmp.lo)), ehi: fmtEdpi(edpi(r.dpi, cmp.hi))
                })) + '</p>'));
                out.push(section(esc(T('drNextTitle')), '<p><b class="dr-big">' + esc(fmt(cmp.midpoint, r.game))
                    + '</b> (eDPI ' + esc(fmtEdpi(edpi(r.dpi, cmp.midpoint))) + ') ' + esc(T('drNextMid')) + '</p>'));
            }
        }

        // --- 4. 根拠
        var rows = breakdown(r.inputs, r.config).map(function (p) {
            return '<tr><th scope="row">' + esc(T(FACTOR_LABEL[p.key])) + '</th><td>' + esc(fmtPct(p.pct))
                + '</td><td>' + esc(T(DIR_LABEL[p.dir])) + '</td></tr>';
        }).join('');
        rows += '<tr><th scope="row">' + esc(T('drFGameCorr')) + '</th><td>×' + esc(String(round(r.gameFactor, 3)))
            + '</td><td>' + esc(r.gameName) + '</td></tr>';
        out.push(section(esc(T('drBasisTitle')),
            '<p>' + esc(T('drBasisIntro', { base: String(r.baseEdpi) })) + '</p>'
            + '<table class="dr-table">' + rows + '</table>'));

        // --- 4. 不確かさ
        out.push(section(esc(T('drUncTitle')), '<p>' + esc(T('drUncBody')) + '</p>'));

        // --- 前回の記録との比較
        var gname = function (k) {
            var g = (r.games || []).filter(function (x) { return x.key === k; })[0];
            return g ? g.name : k;
        };
        if (!h.prev) {
            out.push(section(esc(T('drPrevTitle')), '<p>' + esc(T('drPrevNone')) + '</p>'));
        } else {
            var now = { game: r.game, dpi: r.dpi, sens: String(r.sens),
                        inputs: pickInputs(r.inputs), coef: coefFingerprint(r.config) };
            var d = compareEntries(h.prev, now, function (k) { return k === r.game ? r.integerScale : false; });
            var ps = parseFloat(h.prev.sens);
            out.push(section(esc(T('drPrevTitle')),
                '<p>' + esc(T('drPrevLine', {
                    date: fmtDate(h.prev.at), game: gname(h.prev.game),
                    prev: fmt(ps, h.prev.game), pe: fmtEdpi(edpi(h.prev.dpi, ps)),
                    now: fmt(r.sens, r.game), ne: fmtEdpi(edpi(r.dpi, r.sens))
                })) + '<br>' + diffText(d, h) + '</p>'));
        }

        // --- 他タイトルで同じ回転量になる設定値（倍率が確認済みのときだけ）
        if (hasYaw(r.game)) {
            var conv = (r.games || []).filter(function (g) { return g.key !== r.game; }).map(function (g) {
                var s = convertSens(r.game, g.key, r.sens, r.dpi, r.dpi);
                return '<tr><th scope="row">' + esc(g.name) + '</th><td>'
                    + (s.available ? esc(fmt(s.value, g.key)) : esc(T('drConvNA'))) + '</td><td>'
                    + (s.available ? esc(fmtEdpi(edpi(r.dpi, s.value))) : '—') + '</td></tr>';
            }).join('');
            out.push('<details class="dr-sec"><summary class="dr-h">' + esc(T('drConvTitle'))
                + '</summary><p class="dr-note">' + esc(T('drConvNote', { dpi: String(r.dpi) }))
                + '</p><table class="dr-table"><tr><th scope="col">' + esc(T('drFGame')) + '</th><th scope="col">'
                + esc(T('drColSens')) + '</th><th scope="col">eDPI</th></tr>' + conv + '</table></details>');
        }
        return out.join('');
    }

    /**
     * 診断履歴の一覧（新しい順に表示）。
     * h: { T, esc, fmt, titles:[{key,name}], integerScaleOf(key), viewGame }
     */
    function renderHistory(list, h) {
        var T = h.T, esc = h.esc, fmt = h.fmt;
        var titleName = function (k) {
            var g = (h.titles || []).filter(function (x) { return x.key === k; })[0];
            return g ? g.name : k;
        };
        var out = ['<p class="dr-note">' + esc(T('dhIntro')) + '</p>'];
        if (list.length === 0) {
            out.push('<p class="dh-empty">' + esc(T('dhEmpty')) + '</p>');
            return out.join('');
        }
        var viewGame = h.viewGame || list[list.length - 1].game;
        var rows = historyRows(list, h.integerScaleOf, viewGame);

        out.push('<div class="dh-view"><label for="dhViewGame">' + esc(T('dhViewLabel')) + '</label>'
            + '<select id="dhViewGame" data-dh-view="1">' + (h.titles || []).map(function (g) {
                return '<option value="' + esc(g.key) + '"' + (g.key === viewGame ? ' selected' : '') + '>'
                    + esc(g.name) + '</option>';
            }).join('') + '</select><p class="dr-note">' + esc(T('dhViewNote')) + '</p></div>');

        if (list.length === 1) out.push('<p class="dh-empty">' + esc(T('dhOne')) + '</p>');
        else {
            var chartTitle = T('dhChartTitle', { game: titleName(viewGame) });
            var svg = (h.integerScaleOf && h.integerScaleOf(viewGame)) ? '' : chartSvg(rows, esc(chartTitle));
            out.push('<div class="dr-sec"><div class="dr-h">' + esc(chartTitle) + '</div>'
                + (svg || '<p class="dr-note">' + esc(T('dhChartNone')) + '</p>')
                + (list.length < 4 ? '<p class="dr-note">' + esc(T('dhFew')) + '</p>' : '')
                + '<p class="dr-note">' + esc(T('dhCausal')) + '</p></div>');
        }
        out.push(rows.slice().reverse().map(function (row, i) {
            var e = row.entry, v = row.view;
            var head = '<div class="dh-head"><span>' + esc(fmtDate(e.at)) + '</span>'
                + (row.isFirst ? '<span class="log-tag">' + esc(T('dhFirst')) + '</span>' : '')
                + '<button type="button" class="dh-del" data-dh-del="' + esc(e.id) + '" aria-label="'
                + esc(T('dhDelete')) + '">🗑️</button></div>';
            var main = v.available
                ? '<div class="dh-main"><span>' + esc(titleName(v.game)) + '</span><b class="dr-big">'
                    + esc(fmt(v.sens, v.game)) + '</b></div>'
                    + '<div class="dh-meta">eDPI ' + esc(fmtEdpi(v.edpi)) + ' ・ DPI ' + esc(String(e.dpi)) + '</div>'
                : '<div class="dh-main"><span>' + esc(titleName(v.game)) + '</span><span class="dr-note">'
                    + esc(T('dhNoConv')) + '</span></div>';
            var orig = (v.converted || !v.available)
                ? '<div class="dh-meta">' + esc(T('dhRecordedAs', {
                    game: titleName(e.game), sens: fmt(parseFloat(e.sens), e.game),
                    edpi: fmtEdpi(edpi(e.dpi, parseFloat(e.sens))), dpi: String(e.dpi) })) + '</div>' : '';
            var cur = e.cur ? '<div class="dh-meta">' + esc(T('dhCur', {
                cur: fmt(parseFloat(e.cur), e.game), game: titleName(e.game) })) + '</div>' : '';
            var diff = '';
            if (row.vsPrev) {
                diff = '<div class="dh-diff"><b>' + esc(T('dhVsPrev')) + '</b> ' + diffText(row.vsPrev, h) + '</div>';
                if (rows.indexOf(row) > 1 && row.vsFirst) {
                    diff += '<div class="dh-diff"><b>' + esc(T('dhVsFirst')) + '</b> ' + diffText(row.vsFirst, h) + '</div>';
                }
            }
            return '<div class="dh-item">' + head + main + orig + cur + diff + '</div>';
        }).join(''));
        out.push('<button type="button" class="dh-clear" data-dh-clear="1">' + esc(T('dhClear')) + '</button>');
        return out.join('');
    }

    // ------------------------------------------------------------- 文言

    var I18N = {
        ja: {
            tabHistory: '診断履歴',
            drRecTitle: '推奨値（理論計算による参考値）',
            drRecSens: '{game} の推奨ゲーム内感度',
            drEdpi: '{game} の eDPI',
            drEdpiNote: 'eDPI = マウスDPI × ゲーム内感度。同じ eDPI でも、タイトルが違えば視点の回る速さは違います。',
            drValoOnly: 'この値は VALORANT の設定値です。CS2 で使う場合は、下の「他のタイトルで同じ速さになる設定値」の CS2 の行を見てください。',
            drDpiAssumed: 'DPI が未入力のため 800 と仮定して計算しました。実際の DPI が違う場合、ゲーム内感度は変わります。',
            drCurTitle: '現在の設定',
            drCurSens: '入力された現在のゲーム内感度',
            drCurNone: '「現在のインゲーム感度」を入力すると、推奨値との差と候補範囲を表示します（入力は任意です）。',
            drCurRejected: '入力された現在の感度は、このタイトルの想定範囲の外だったため、比較に使っていません。',
            drCurHigher: '推奨値は、現在の設定より {pct}% 高感度です。',
            drCurLower: '推奨値は、現在の設定より {pct}% 低感度です。',
            drCurHigherNoPct: '推奨値は、現在の設定より高感度側です。',
            drCurLowerNoPct: '推奨値は、現在の設定より低感度側です。',
            drCurSame: '現在の設定は推奨値とほぼ同じです。',
            drRangeTitle: '候補範囲',
            drRangeBody: 'ゲーム内感度 {lo} 〜 {hi}（eDPI {elo} 〜 {ehi}）。現在の設定と推奨値のあいだで、試す範囲の目安です。統計的な信頼区間ではありません。',
            drNextTitle: '次に試す候補（実験的）',
            drNextMid: '現在の設定と推奨値の中間です。一度に乗り換えず、数日使ってから再診断して比べてください。',
            drNextNoCur: '推奨値を数日試し、使った感度を「感度メモ」に残してから再診断すると比較しやすくなります。',
            drNextSame: 'いまの設定のまま使い続けて問題ありません。変更は必須ではありません。',
            drBasisTitle: 'この結果の根拠（入力ごとの補正）',
            drBasisIntro: '基準値 {base} に、入力ごとの補正を足し合わせ、最後にタイトルごとの補正と単位の変換を掛けています。',
            drFHeight: '身長', drFDex: '手先の器用さ', drFArm: '腕の太さ', drFWeight: 'マウス重量',
            drFPivot: 'エイムの支点', drFGame: 'タイトル', drFDpi: 'DPI', drFGameCorr: 'タイトル補正',
            drColSens: 'ゲーム内感度',
            drDirUp: '高感度方向', drDirDown: '低感度方向', drDirNone: '変化なし',
            drUncTitle: 'この結果の不確かさ',
            drUncBody: 'この値は身体・環境の入力から計算した参考値で、あなた個人の最適感度を実証したものではありません。補正係数は限られたデータに基づく推定値です。確率としての信頼度や統計的な信頼区間は算出していません。',
            drPrevTitle: '前回の記録との比較',
            drPrevNone: 'この結果を診断履歴に記録すると、次回から前回との差を表示します。',
            drPrevLine: '前回（{date}・{game}）{prev}（eDPI {pe}）→ 今回 {now}（eDPI {ne}）',
            drDiffEdpi: 'eDPI は {pct}（{dir}）。',
            drDiffRotation: 'タイトルが違うため、タイトルごとの感度倍率で換算して比べると {pct}（{dir}）。eDPI の数字どうしは比べていません。',
            drDiffNoBasis: 'タイトルが違い、感度倍率を確認できていない組み合わせのため、割合は表示しません。',
            drDiffChanged: '変わった入力: {list}',
            drDiffUnchanged: '入力は同じです。',
            drDiffCoef: '入力が同じで値が変わったのは、補正係数が更新されたためです。',
            drConvTitle: '他のタイトルで同じ速さになる設定値',
            drConvNote: '視点の回る量が同じになるよう、タイトルごとの感度倍率で換算した値です（DPI {dpi} のまま）。eDPI の数字はタイトルごとに変わります。各タイトルを選んで診断した結果にはタイトル別の補正が入るため、この値とは一致しません。',
            drConvNA: '倍率が未確認のため換算しません',
            drRecordBtn: '📈 この結果を診断履歴に記録する（この端末に保存）',
            drRecorded: '診断履歴に記録しました。',
            drRecordDup: '直前の記録と同じ内容のため、追加しませんでした。',
            drRecordFail: '記録できませんでした（ブラウザの保存領域が使えないか、容量が不足しています）。',
            drOpenHistory: '診断履歴を見る',
            dhIntro: '診断履歴はこの端末のブラウザにだけ保存され、サーバーには送信されません。「マイ感度ログ」の保存枠（5件）とは別です。',
            dhEmpty: 'まだ記録がありません。診断結果の「診断履歴に記録する」から追加できます。',
            dhOne: '記録は1件です。次回の診断を記録すると、前回との比較と推移が表示されます。',
            dhFew: '記録が少ないため、推移は参考程度にご覧ください。',
            dhViewLabel: '表示するタイトル',
            dhViewNote: '別のタイトルで記録した結果は、タイトルごとの感度倍率で換算して表示します（DPI は記録時のまま）。',
            dhChartTitle: '{game} の eDPI の推移（古い順）',
            dhChartNone: 'このタイトルで表示できる記録が2件未満のため、グラフは表示しません。',
            dhCausal: '感度の変化と成績の変化の因果関係は、この履歴からは判断できません。',
            dhFirst: '初回', dhVsPrev: '前回比', dhVsFirst: '初回比',
            dhNoConv: 'このタイトルへは換算できません（倍率が未確認）',
            dhRecordedAs: '記録時: {game} {sens}（eDPI {edpi}・DPI {dpi}）',
            dhCur: '当時の使用感度: {game} {cur}',
            dhDelete: 'この記録を削除',
            dhDeleteConfirm: 'この記録を診断履歴から削除しますか？',
            dhClear: '診断履歴をすべて削除',
            dhClearConfirm: 'この端末の診断履歴をすべて削除しますか？元に戻せません。',
            dhRediag: '再診断する',
            dhLoadFail: '診断履歴を読み込めませんでした（ブラウザの保存領域が使えません）。'
        },
        en: {
            tabHistory: 'History',
            drRecTitle: 'Recommended value (a reference from a theoretical calculation)',
            drRecSens: 'Recommended in-game sensitivity for {game}',
            drEdpi: 'eDPI in {game}',
            drEdpiNote: 'eDPI = mouse DPI × in-game sensitivity. The same eDPI turns the view at a different speed in a different title.',
            drValoOnly: 'This is a VALORANT setting. For CS2, see the CS2 row under "Settings with the same speed in other titles" below.',
            drDpiAssumed: 'No DPI was entered, so 800 was assumed. If your real DPI differs, the in-game sensitivity will change.',
            drCurTitle: 'Your current setting',
            drCurSens: 'Current in-game sensitivity you entered',
            drCurNone: 'Enter your current in-game sensitivity to see the gap to the recommended value and a candidate range (optional).',
            drCurRejected: 'The current sensitivity you entered is outside the expected range for this title, so it was not used for comparison.',
            drCurHigher: 'The recommended value is {pct}% faster than your current setting.',
            drCurLower: 'The recommended value is {pct}% slower than your current setting.',
            drCurHigherNoPct: 'The recommended value is on the faster side of your current setting.',
            drCurLowerNoPct: 'The recommended value is on the slower side of your current setting.',
            drCurSame: 'Your current setting is about the same as the recommended value.',
            drRangeTitle: 'Candidate range',
            drRangeBody: 'In-game sensitivity {lo} to {hi} (eDPI {elo} to {ehi}). This is the span between your current setting and the recommended value: a range to try, not a statistical confidence interval.',
            drNextTitle: 'Next candidate to try (experimental)',
            drNextMid: 'Halfway between your current setting and the recommended value. Do not switch all at once; use it for a few days, then run the diagnosis again and compare.',
            drNextNoCur: 'Try the recommended value for a few days, save the sensitivity you used in the Memo tab, then run the diagnosis again to compare.',
            drNextSame: 'You can keep using your current setting. No change is required.',
            drBasisTitle: 'What this result is based on (correction per input)',
            drBasisIntro: 'Starting from a baseline of {base}, the corrections for each input are added, then the title correction and unit conversion are applied.',
            drFHeight: 'Height', drFDex: 'Dexterity', drFArm: 'Arm thickness', drFWeight: 'Mouse weight',
            drFPivot: 'Aiming pivot', drFGame: 'Title', drFDpi: 'DPI', drFGameCorr: 'Title correction',
            drColSens: 'In-game sensitivity',
            drDirUp: 'faster', drDirDown: 'slower', drDirNone: 'no change',
            drUncTitle: 'How uncertain this result is',
            drUncBody: 'This value is a reference calculated from your physical and equipment inputs. It has not been shown to be your personal optimum. The correction factors are estimates based on limited data. No probability-style confidence or statistical confidence interval is calculated.',
            drPrevTitle: 'Compared with your previous record',
            drPrevNone: 'Record this result in your history to see the difference from next time on.',
            drPrevLine: 'Previous ({date}, {game}) {prev} (eDPI {pe}) → now {now} (eDPI {ne})',
            drDiffEdpi: 'eDPI changed by {pct} ({dir}).',
            drDiffRotation: 'The titles differ, so after converting with each title\'s sensitivity multiplier the change is {pct} ({dir}). The eDPI numbers themselves are not compared.',
            drDiffNoBasis: 'The titles differ and the sensitivity multiplier for this pair has not been verified, so no percentage is shown.',
            drDiffChanged: 'Inputs that changed: {list}',
            drDiffUnchanged: 'The inputs are the same.',
            drDiffCoef: 'The value changed with the same inputs because the correction factors were updated.',
            drConvTitle: 'Settings with the same speed in other titles',
            drConvNote: 'Converted with each title\'s sensitivity multiplier so the view turns by the same amount (DPI stays at {dpi}). The eDPI number changes per title. A diagnosis run for each title includes a title-specific correction, so it will not match these values.',
            drConvNA: 'not converted (multiplier not verified)',
            drRecordBtn: '📈 Record this result in your history (saved on this device)',
            drRecorded: 'Recorded in your history.',
            drRecordDup: 'Not added, because it is identical to the latest record.',
            drRecordFail: 'Could not record (browser storage is unavailable or full).',
            drOpenHistory: 'View history',
            dhIntro: 'Your diagnosis history is stored only in this browser on this device and is never sent to the server. It is separate from the 5-entry limit of My Sensitivity Logs.',
            dhEmpty: 'No records yet. Add one with "Record this result in your history" on a diagnosis result.',
            dhOne: 'You have 1 record. Record your next diagnosis to see a comparison and a trend.',
            dhFew: 'There are only a few records, so treat the trend as a rough guide.',
            dhViewLabel: 'Title to display',
            dhViewNote: 'Results recorded for another title are converted with each title\'s sensitivity multiplier (DPI stays as recorded).',
            dhChartTitle: 'eDPI in {game} over time (oldest first)',
            dhChartNone: 'Fewer than 2 records can be shown for this title, so no chart is shown.',
            dhCausal: 'This history cannot tell you whether a change in sensitivity caused a change in performance.',
            dhFirst: 'First', dhVsPrev: 'vs previous', dhVsFirst: 'vs first',
            dhNoConv: 'Cannot be converted to this title (multiplier not verified)',
            dhRecordedAs: 'Recorded as: {game} {sens} (eDPI {edpi}, DPI {dpi})',
            dhCur: 'Sensitivity in use then: {game} {cur}',
            dhDelete: 'Delete this record',
            dhDeleteConfirm: 'Delete this record from your history?',
            dhClear: 'Delete all history',
            dhClearConfirm: 'Delete all diagnosis history on this device? This cannot be undone.',
            dhRediag: 'Run the diagnosis again',
            dhLoadFail: 'Could not load your history (browser storage is unavailable).'
        },
        ko: {
            tabHistory: '진단 기록',
            drRecTitle: '추천값 (이론 계산에 따른 참고값)',
            drRecSens: '{game} 추천 인게임 감도',
            drEdpi: '{game} 의 eDPI',
            drEdpiNote: 'eDPI = 마우스 DPI × 인게임 감도. eDPI 가 같아도 타이틀이 다르면 시점이 도는 속도는 다릅니다.',
            drValoOnly: '이 값은 발로란트 설정값입니다. CS2 에서 쓰려면 아래 「다른 타이틀에서 같은 속도가 되는 설정값」의 CS2 행을 확인해 주세요.',
            drDpiAssumed: 'DPI 가 입력되지 않아 800 으로 가정해 계산했습니다. 실제 DPI 가 다르면 인게임 감도가 달라집니다.',
            drCurTitle: '현재 설정',
            drCurSens: '입력한 현재 인게임 감도',
            drCurNone: '「현재 인게임 감도」를 입력하면 추천값과의 차이와 후보 범위를 표시합니다 (입력은 선택입니다).',
            drCurRejected: '입력한 현재 감도가 이 타이틀의 예상 범위를 벗어나 비교에 사용하지 않았습니다.',
            drCurHigher: '추천값은 현재 설정보다 {pct}% 고감도입니다.',
            drCurLower: '추천값은 현재 설정보다 {pct}% 저감도입니다.',
            drCurHigherNoPct: '추천값은 현재 설정보다 고감도 쪽입니다.',
            drCurLowerNoPct: '추천값은 현재 설정보다 저감도 쪽입니다.',
            drCurSame: '현재 설정은 추천값과 거의 같습니다.',
            drRangeTitle: '후보 범위',
            drRangeBody: '인게임 감도 {lo} ~ {hi} (eDPI {elo} ~ {ehi}). 현재 설정과 추천값 사이로, 시도해 볼 범위의 기준입니다. 통계적 신뢰구간이 아닙니다.',
            drNextTitle: '다음에 시도할 후보 (실험적)',
            drNextMid: '현재 설정과 추천값의 중간입니다. 한 번에 바꾸지 말고 며칠 사용한 뒤 다시 진단해 비교해 보세요.',
            drNextNoCur: '추천값을 며칠 사용해 보고, 사용한 감도를 「감도 메모」에 남긴 뒤 다시 진단하면 비교하기 쉽습니다.',
            drNextSame: '지금 설정을 그대로 사용해도 됩니다. 변경은 필수가 아닙니다.',
            drBasisTitle: '이 결과의 근거 (입력별 보정)',
            drBasisIntro: '기준값 {base} 에 입력별 보정을 더하고, 마지막에 타이틀별 보정과 단위 변환을 곱합니다.',
            drFHeight: '신장', drFDex: '손재주', drFArm: '팔 두께', drFWeight: '마우스 무게',
            drFPivot: '에임의 지점', drFGame: '타이틀', drFDpi: 'DPI', drFGameCorr: '타이틀 보정',
            drColSens: '인게임 감도',
            drDirUp: '고감도 방향', drDirDown: '저감도 방향', drDirNone: '변화 없음',
            drUncTitle: '이 결과의 불확실성',
            drUncBody: '이 값은 신체·환경 입력으로 계산한 참고값이며, 개인의 최적 감도를 실증한 것이 아닙니다. 보정 계수는 제한된 데이터에 근거한 추정값입니다. 확률로서의 신뢰도나 통계적 신뢰구간은 산출하지 않습니다.',
            drPrevTitle: '이전 기록과의 비교',
            drPrevNone: '이 결과를 진단 기록에 남기면 다음부터 이전과의 차이를 표시합니다.',
            drPrevLine: '이전 ({date}・{game}) {prev} (eDPI {pe}) → 이번 {now} (eDPI {ne})',
            drDiffEdpi: 'eDPI 는 {pct} ({dir}).',
            drDiffRotation: '타이틀이 달라 타이틀별 감도 배율로 환산해 비교하면 {pct} ({dir}). eDPI 숫자끼리는 비교하지 않습니다.',
            drDiffNoBasis: '타이틀이 다르고 감도 배율이 확인되지 않은 조합이라 비율은 표시하지 않습니다.',
            drDiffChanged: '바뀐 입력: {list}',
            drDiffUnchanged: '입력은 같습니다.',
            drDiffCoef: '입력이 같은데 값이 바뀐 것은 보정 계수가 갱신되었기 때문입니다.',
            drConvTitle: '다른 타이틀에서 같은 속도가 되는 설정값',
            drConvNote: '시점이 도는 양이 같아지도록 타이틀별 감도 배율로 환산한 값입니다 (DPI {dpi} 그대로). eDPI 숫자는 타이틀마다 달라집니다. 각 타이틀을 선택해 진단한 결과에는 타이틀별 보정이 들어가므로 이 값과 일치하지 않습니다.',
            drConvNA: '배율 미확인으로 환산하지 않음',
            drRecordBtn: '📈 이 결과를 진단 기록에 남기기 (이 기기에 저장)',
            drRecorded: '진단 기록에 남겼습니다.',
            drRecordDup: '직전 기록과 내용이 같아 추가하지 않았습니다.',
            drRecordFail: '기록하지 못했습니다 (브라우저 저장 공간을 사용할 수 없거나 용량이 부족합니다).',
            drOpenHistory: '진단 기록 보기',
            dhIntro: '진단 기록은 이 기기의 브라우저에만 저장되며 서버로 전송되지 않습니다. 「마이 감도 로그」의 저장 한도(5건)와는 별개입니다.',
            dhEmpty: '아직 기록이 없습니다. 진단 결과의 「진단 기록에 남기기」로 추가할 수 있습니다.',
            dhOne: '기록이 1건입니다. 다음 진단을 기록하면 이전과의 비교와 추이가 표시됩니다.',
            dhFew: '기록이 적으므로 추이는 참고 정도로만 봐 주세요.',
            dhViewLabel: '표시할 타이틀',
            dhViewNote: '다른 타이틀로 기록한 결과는 타이틀별 감도 배율로 환산해 표시합니다 (DPI 는 기록 당시 그대로).',
            dhChartTitle: '{game} 의 eDPI 추이 (오래된 순)',
            dhChartNone: '이 타이틀로 표시할 수 있는 기록이 2건 미만이라 그래프를 표시하지 않습니다.',
            dhCausal: '감도 변화와 성적 변화의 인과관계는 이 기록으로는 판단할 수 없습니다.',
            dhFirst: '첫 기록', dhVsPrev: '이전 대비', dhVsFirst: '첫 기록 대비',
            dhNoConv: '이 타이틀로는 환산할 수 없습니다 (배율 미확인)',
            dhRecordedAs: '기록 당시: {game} {sens} (eDPI {edpi}・DPI {dpi})',
            dhCur: '당시 사용 감도: {game} {cur}',
            dhDelete: '이 기록 삭제',
            dhDeleteConfirm: '이 기록을 진단 기록에서 삭제할까요?',
            dhClear: '진단 기록 모두 삭제',
            dhClearConfirm: '이 기기의 진단 기록을 모두 삭제할까요? 되돌릴 수 없습니다.',
            dhRediag: '다시 진단하기',
            dhLoadFail: '진단 기록을 불러오지 못했습니다 (브라우저 저장 공간을 사용할 수 없습니다).'
        }
    };

    root.LC_DIAG = {
        VERSION: VERSION, HISTORY_KEY: HISTORY_KEY, HISTORY_SCHEMA: HISTORY_SCHEMA,
        YAW: YAW, EXTRA_TITLES: EXTRA_TITLES, INPUT_KEYS: INPUT_KEYS, I18N: I18N,
        edpi: edpi, rotation: rotation, convertSens: convertSens, auditYaw: auditYaw,
        breakdown: breakdown, coefFingerprint: coefFingerprint, compareCurrent: compareCurrent,
        parseHistory: parseHistory, serializeHistory: serializeHistory, makeEntry: makeEntry,
        addEntry: addEntry, removeEntry: removeEntry, compareEntries: compareEntries,
        viewEntry: viewEntry, historyRows: historyRows, chartSvg: chartSvg, fmtDate: fmtDate,
        renderReport: renderReport, renderHistory: renderHistory
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
