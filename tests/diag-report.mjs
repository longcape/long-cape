// 診断結果レポート Ver.2 / 診断履歴 / eDPI とタイトル間換算のテスト。
//
//   node tests/diag-report.mjs
//
// ui/diag-report.js の判断（単位の換算・比較・履歴・描画）と、index.html への組み込みを検証する。
// 感度の計算式そのものは tests/regression.mjs（8,064 パターン）が見る。
// 本番DB・ネットワーク・本番サイトには一切触れない。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadApp } from './lib/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function loadDiag() {
    const ctx = { console, Math, JSON, Date, Number, String, Boolean, Array, Object, isFinite, isNaN, parseFloat, Error };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'ui/diag-report.js'), 'utf8'), ctx, { filename: 'ui/diag-report.js' });
    return ctx.LC_DIAG;
}

const D = loadDiag();
const GAMES = JSON.parse(fs.readFileSync(path.join(ROOT, 'games.json'), 'utf8')).games;
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let passed = 0;
const failures = [];
const pending = [];
const check = (name, fn) => pending.push({ name, fn });
function eq(a, b, l) {
    const x = JSON.stringify(a), y = JSON.stringify(b);
    if (x !== y) throw new Error(`${l || ''} 期待 ${y} / 実際 ${x}`);
}
function ok(c, l) { if (!c) throw new Error(l || '条件を満たしません'); }
function near(a, b, tol, l) { if (!(Math.abs(a - b) <= tol)) throw new Error(`${l || ''} 期待 ${b}±${tol} / 実際 ${a}`); }

// 描画用の道具（index.html と同じ役割）
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
const makeT = (lang) => (key, vars) => {
    let s = D.I18N[lang][key] ?? key;
    if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
    return s;
};
const fmt = (v, key) => {
    const g = GAMES.find((x) => x.key === key);
    if (g && g.display.integer) return String(Math.round(v));
    return (Math.round(v * 1000) / 1000).toString() + (g ? g.display.suffix : '');
};
const titles = GAMES.map((g) => ({ key: g.key, name: g.name })).concat(D.EXTRA_TITLES);
const integerScaleOf = (k) => !!GAMES.find((g) => g.key === k)?.display.integer;
const helpers = (lang = 'ja', extra = {}) => ({ T: makeT(lang), esc, fmt, titles, integerScaleOf, ...extra });

const CONFIG = { base_edpi: 230, height_factor: 0.005, neuro_3_factor: 0, neuro_1_factor: 0.25,
    arm_normal_factor: 0, weight_standard_factor: 0, pivot_wrist_factor: 0.4, pivot_arm_factor: 0 };
const INPUTS = { height: 173, dexterity: '3', armThickness: 'normal', mouseWeight: 'standard', aimPart: 'wrist' };
const report = (over = {}) => ({
    game: 'valo', gameName: 'VALORANT', dpi: 800, dpiAssumed: false, sens: 0.4, integerScale: false,
    baseEdpi: 230, gameFactor: 1, inputs: INPUTS, config: CONFIG, currentSens: null, games: titles, ...over,
});
const entry = (over = {}) => ({ id: 'e' + Math.random(), at: '2026-10-01T00:00:00.000Z', game: 'valo', dpi: 800,
    sens: '0.4', inputs: INPUTS, coef: 'a', ...over });

// ============================================================ eDPI の定義

check('DPI 800・VALORANT 感度 0.4 → eDPI 320', () => eq(D.edpi(800, 0.4), 320));
check('DPI 800・CS2 感度 0.4 → eDPI 320（定義はタイトルによらない）', () => {
    eq(D.edpi(800, 0.4), 320);
    eq(D.viewEntry(entry({ game: 'cs2' }), 'cs2').edpi, 320);
    eq(D.viewEntry(entry({ game: 'valo' }), 'valo').edpi, 320);
});
check('不正な入力では eDPI を出さない（0 や負・非数）', () => {
    eq(D.edpi(0, 0.4), null); eq(D.edpi(800, -1), null); eq(D.edpi(NaN, 0.4), null); eq(D.edpi(800, '0.4'), null);
});

// ============================================================ タイトル間換算

check('同じ eDPI でも VALORANT と CS2 では視点の回転量が違う', () => {
    const v = D.rotation('valo', 0.4, 800), c = D.rotation('cs2', 0.4, 800);
    ok(v !== null && c !== null);
    near(v / c, 0.07 / 0.022, 1e-9, '比は倍率の比');
    ok(Math.abs(v - c) / v > 0.5, '大きく違う');
});
check('eDPI をそのまま別タイトルへ写さない（換算すると eDPI は変わる）', () => {
    const c = D.convertSens('valo', 'cs2', 0.4, 800, 800);
    near(c.value, 1.2727, 0.0005, 'VALORANT 0.4 → CS2');
    near(D.edpi(800, c.value), 1018.2, 0.1, 'CS2 側の eDPI');
});
check('換算後の回転量が一致する（倍率が確認済みの全組み合わせ）', () => {
    const keys = Object.keys(D.YAW);
    for (const a of keys) for (const b of keys) {
        const c = D.convertSens(a, b, 1.37, 800, 800);
        ok(c.available, `${a}→${b}`);
        const ra = D.rotation(a, 1.37, 800), rb = D.rotation(b, c.value, 800);
        ok(Math.abs(ra - rb) / ra < 1e-9, `${a}→${b} の回転量`);
        const back = D.convertSens(b, a, c.value, 800, 800);
        near(back.value, 1.37, 1e-9, `${a}→${b}→${a} の往復`);
    }
});
check('広く知られた換算と一致する（VALORANT→CS2 ×3.18 / OW ×10.6 / Fortnite ×12.6）', () => {
    near(D.convertSens('valo', 'cs2', 1, 800).value, 3.18, 3.18 * 0.005);
    near(D.convertSens('valo', 'apex', 1, 800).value, 3.18, 3.18 * 0.005);
    near(D.convertSens('valo', 'ow', 1, 800).value, 10.6, 10.6 * 0.005);
    near(D.convertSens('valo', 'cod', 1, 800).value, 10.6, 10.6 * 0.005);
    near(D.convertSens('valo', 'fn', 1, 800).value, 12.6, 12.6 * 0.005);
});
check('倍率の表が games.json の scale と一致している', () => {
    const a = D.auditYaw(GAMES);
    ok(a.ok, a.problems.join(' / '));
});
check('scale が食い違えば検出する（意図的な破壊）', () => {
    const broken = GAMES.map((g) => (g.key === 'apex' ? { ...g, scale: 3.5 } : g));
    ok(!D.auditYaw(broken).ok, 'apex の食い違いを見逃した');
    ok(!D.auditYaw(GAMES.filter((g) => g.key !== 'ow')).ok, 'games.json から消えたタイトルを見逃した');
});
check('倍率を確認できていないタイトル（Delta Force / PUBG）は推測で換算しない', () => {
    for (const k of ['delta', 'pubg', 'unknown']) {
        eq(D.rotation(k, 5, 800), null, k);
        eq(D.convertSens(k, 'valo', 5, 800).available, false, k + '→valo');
        eq(D.convertSens('valo', k, 0.4, 800).available, false, 'valo→' + k);
    }
});
check('DPI を変えたときのゲーム内感度（同じタイトル・eDPI は変わらない）', () => {
    const c = D.convertSens('valo', 'valo', 0.4, 800, 1600);
    near(c.value, 0.2, 1e-12);
    eq(D.edpi(1600, c.value), 320);
    // 倍率が未確認のタイトルでも、同じタイトルの DPI 変更は換算できる
    near(D.convertSens('delta', 'delta', 6, 800, 400).value, 12, 1e-12);
    // タイトルと DPI を同時に変えても回転量は一致する
    const x = D.convertSens('valo', 'ow', 0.4, 800, 1600);
    near(D.rotation('ow', x.value, 1600), D.rotation('valo', 0.4, 800), 1e-9);
    eq(D.convertSens('valo', 'valo', 0.4, 800, 0).available, false, 'DPI 0');
});

// ============================================================ 現在の設定との比較

check('現在の設定との差・中間・範囲（新しい係数を使わない単純な計算）', () => {
    const c = D.compareCurrent(0.3, 0.4, false);
    eq(c.relation, 'lower'); eq(c.pct, -25); near(c.midpoint, 0.35, 1e-12); eq([c.lo, c.hi], [0.3, 0.4]);
    eq(D.compareCurrent(0.402, 0.4, false).relation, 'same');
    eq(D.compareCurrent(0.3, null, false), null);
    eq(D.compareCurrent(0.3, 0, false), null);
});
check('対数スケールの設定値（PUBG）では割合を出さない', () => {
    const c = D.compareCurrent(44, 50, true);
    eq(c.pct, null); eq(c.relation, 'lower'); eq(c.midpoint, 47);
});

// ============================================================ 根拠

check('根拠は既存の係数をそのまま並べる', () => {
    const b = D.breakdown(INPUTS, CONFIG);
    eq(b.map((p) => p.key), ['height', 'dexterity', 'armThickness', 'mouseWeight', 'aimPart']);
    eq(b.find((p) => p.key === 'aimPart'), { key: 'aimPart', pct: 40, dir: 'up' });
    eq(b.find((p) => p.key === 'height'), { key: 'height', pct: -1.5, dir: 'down' });
    eq(D.breakdown({}, {}).every((p) => p.pct === 0), true, '欠損でも落ちない');
});

// ============================================================ 履歴

check('過去の保存形式を読める（配列だけの形・知らない項目つき）', () => {
    const legacy = [{ ...entry({ id: 'a' }), cm360: 40.8, extra: 1 }];
    eq(D.parseHistory(JSON.stringify(legacy)).length, 1, '配列の形');
    eq(D.parseHistory(JSON.stringify({ schema: 1, entries: legacy })).length, 1, '現行の形');
    eq(D.parseHistory(JSON.stringify({ schema: 99, entries: legacy, future: true })).length, 1, '将来の版');
    const back = D.parseHistory(D.serializeHistory(D.parseHistory(JSON.stringify(legacy))));
    eq(back[0].sens, '0.4', '往復しても値が変わらない');
});
check('壊れた保存内容でも落ちず、読める行だけ返す', () => {
    eq(D.parseHistory(null), []); eq(D.parseHistory(''), []); eq(D.parseHistory('{{{'), []);
    eq(D.parseHistory('"text"'), []); eq(D.parseHistory('{"entries":"x"}'), []);
    const mixed = [entry({ id: 'ok' }), null, 5, { id: 'x' }, entry({ id: 'bad1', dpi: 0 }),
        entry({ id: 'bad2', sens: 'abc' }), entry({ id: 'bad3', at: 'not a date' }), entry({ id: '', game: 'valo' })];
    eq(D.parseHistory(JSON.stringify(mixed)).map((e) => e.id), ['ok']);
});
check('古い順に並べ直す', () => {
    const list = D.parseHistory(JSON.stringify([
        entry({ id: 'b', at: '2026-10-05T00:00:00Z' }), entry({ id: 'a', at: '2026-10-01T00:00:00Z' })]));
    eq(list.map((e) => e.id), ['a', 'b']);
});
check('記録の作成: 現在の感度は入力があるときだけ持つ', () => {
    const base = { game: 'valo', dpi: 800, sens: '0.353', inputs: INPUTS, coef: 'c' };
    const a = D.makeEntry({ ...base, currentSens: null }, new Date('2026-10-10T00:00:00Z'));
    ok(!('cur' in a), '未入力なら項目を作らない');
    ok(!('cm360' in a), 'cm/360 は保存しない');
    eq(D.makeEntry({ ...base, currentSens: 0.4 }).cur, '0.4');
    eq(a.at, '2026-10-10T00:00:00.000Z');
    eq(D.parseHistory(D.serializeHistory([a])).length, 1, '作った行は読み戻せる');
});
check('直前と同じ内容は足さない。内容が違えば足す', () => {
    const a = entry({ id: 'a' });
    let r = D.addEntry([], a); eq(r.added, true);
    r = D.addEntry(r.list, entry({ id: 'b' })); eq([r.added, r.reason], [false, 'duplicate']);
    r = D.addEntry(r.list, entry({ id: 'c', sens: '0.41' })); eq(r.added, true); eq(r.list.length, 2);
    r = D.addEntry(r.list, entry({ id: 'd' })); eq(r.added, true, '間に別の記録があれば同じ内容でも足す');
    eq(D.addEntry(r.list, { id: 'x' }).reason, 'invalid');
    eq(r.list.length, 3, '元の配列を壊さない');
});
check('削除しても初回比・前回比が食い違わない', () => {
    const list = [entry({ id: 'a', sens: '0.4' }), entry({ id: 'b', sens: '0.5' }), entry({ id: 'c', sens: '0.6' })];
    let rows = D.historyRows(list, integerScaleOf);
    eq(rows[2].vsFirst.pct, 50); eq(rows[2].vsPrev.pct, 20); eq(rows[0].vsPrev, null);
    rows = D.historyRows(D.removeEntry(list, 'a'), integerScaleOf);
    eq(rows.length, 2); eq(rows[0].isFirst, true); eq(rows[1].vsFirst.pct, 20, '初回が入れ替わる');
    eq(D.removeEntry(list, 'zzz').length, 3, '無い id は何も消さない');
    eq(D.historyRows([], integerScaleOf), []);
});
check('同じタイトルは eDPI で比べる（DPI が違っても比べられる）', () => {
    const c = D.compareEntries(entry({ dpi: 800, sens: '0.4' }), entry({ dpi: 1600, sens: '0.2' }), integerScaleOf);
    eq([c.basis, c.pct, c.dir], ['edpi', 0, 'none']);
    eq(c.changed, ['dpi']);
});
check('違うタイトルの eDPI を比べて「同じ」と判定しない', () => {
    // eDPI はどちらも 320 だが、回転量は約 3.18 倍違う
    const c = D.compareEntries(entry({ game: 'valo', sens: '0.4' }), entry({ game: 'cs2', sens: '0.4' }), integerScaleOf);
    eq(c.basis, 'rotation'); ok(Math.abs(c.pct) > 50, '差が出る: ' + c.pct); eq(c.dir, 'down');
    // 回転量が同じ設定どうしは 0%
    const same = D.compareEntries(entry({ game: 'valo', sens: '0.4' }),
        entry({ game: 'cs2', sens: String(0.4 * 0.07 / 0.022) }), integerScaleOf);
    eq([same.basis, same.pct], ['rotation', 0]);
});
check('比べる根拠が無い組み合わせでは割合を出さない', () => {
    const a = D.compareEntries(entry({ game: 'valo' }), entry({ game: 'delta', sens: '6' }), integerScaleOf);
    eq([a.basis, a.pct], [null, null]);
    const b = D.compareEntries(entry({ game: 'pubg', sens: '40' }), entry({ game: 'pubg', sens: '50' }), integerScaleOf);
    eq([b.basis, b.pct], [null, null]);
});
check('履歴を選んだタイトルの設定値と eDPI で表示する', () => {
    const v = D.viewEntry(entry({ game: 'valo', sens: '0.4' }), 'ow');
    eq(v.converted, true); near(v.sens, 4.2424, 0.0005); near(v.edpi, 3393.9, 0.1);
    eq(D.viewEntry(entry({ game: 'delta', sens: '6' }), 'delta').edpi, 4800, '同じタイトルならそのまま');
    eq(D.viewEntry(entry({ game: 'delta', sens: '6' }), 'valo').available, false);
});

// ============================================================ 描画

const CM_PATTERN = /cm\s*\/\s*360|cm360|振り向き|cm per 360|turn distance|회전 거리/i;

check('結果レポートに cm/360・振り向き距離が出ない（3言語・全タイトル）', () => {
    for (const lang of ['ja', 'en', 'ko']) for (const g of GAMES) {
        const html = D.renderReport(report({ game: g.key, gameName: g.name, sens: g.display.integer ? 44 : 2.5,
            integerScale: g.display.integer, currentSens: g.display.integer ? 50 : 3 }),
            helpers(lang, { prev: entry({ game: 'valo' }) }));
        ok(!CM_PATTERN.test(html), `${lang}/${g.key}: ${html.match(CM_PATTERN)}`);
        ok(!/\d\s*cm\b/.test(html), `${lang}/${g.key}: cm の数値`);
    }
});
check('履歴画面にも cm/360 が出ない', () => {
    const list = [entry({ id: 'a' }), entry({ id: 'b', game: 'ow', sens: '4.5', at: '2026-10-02T00:00:00Z' })];
    for (const lang of ['ja', 'en', 'ko']) ok(!CM_PATTERN.test(D.renderHistory(list, helpers(lang))), lang);
});
check('文言にも cm/360 を使っていない', () => {
    for (const lang of ['ja', 'en', 'ko']) for (const [k, v] of Object.entries(D.I18N[lang])) {
        ok(!CM_PATTERN.test(v), `${lang}.${k}`);
    }
});
check('表示順は「推奨ゲーム内感度 → eDPI → 範囲 → 根拠 → 不確かさ」', () => {
    const T = makeT('ja');
    const html = D.renderReport(report({ currentSens: 0.5 }), helpers('ja'));
    const pos = [T('drRecSens', { game: 'VALORANT' }), T('drEdpi', { game: 'VALORANT' }), T('drRangeTitle'),
        T('drBasisTitle'), T('drUncTitle')].map((s) => html.indexOf(esc(s)));
    ok(pos.every((p) => p >= 0), '見出しが揃っている: ' + pos);
    eq(pos.slice().sort((a, b) => a - b), pos, '順序');
    ok(html.includes('>320<'), 'eDPI 320 を表示');
});
check('確率としての信頼度・信頼区間の数値を作らない', () => {
    for (const lang of ['ja', 'en', 'ko']) {
        const html = D.renderReport(report({ currentSens: 0.5 }), helpers(lang));
        ok(!/信頼度\s*[:：]?\s*\d|confidence\s*[:：]?\s*\d|신뢰도\s*[:：]?\s*\d/i.test(html), lang);
        ok(html.includes(esc(makeT(lang)('drUncBody'))), lang + ': 不確かさの説明');
    }
});
check('現在の感度が無ければ、範囲も中間値も出さない', () => {
    const T = makeT('ja');
    const html = D.renderReport(report(), helpers('ja'));
    const rangeHead = '<div class="dr-h">' + esc(T('drRangeTitle')) + '</div>';
    ok(!html.includes(rangeHead), '範囲を出していない');
    ok(html.includes(esc(T('drCurNone'))) && html.includes(esc(T('drNextNoCur'))));
    const same = D.renderReport(report({ currentSens: 0.4 }), helpers('ja'));
    ok(!same.includes(rangeHead) && same.includes(esc(T('drNextSame'))), 'ほぼ同じなら範囲なし');
});
check('DPI を仮定したときは明示する', () => {
    const T = makeT('ja');
    ok(D.renderReport(report({ dpiAssumed: true }), helpers('ja')).includes(esc(T('drDpiAssumed'))));
    ok(!D.renderReport(report(), helpers('ja')).includes(esc(T('drDpiAssumed'))));
});
check('他タイトルの換算表: 確認済みは値、未確認は「換算しない」', () => {
    const T = makeT('ja');
    const html = D.renderReport(report(), helpers('ja'));
    ok(html.includes('1.273'), 'CS2 の換算値'); ok(html.includes(esc(T('drConvNA'))), 'Delta / PUBG');
    const delta = D.renderReport(report({ game: 'delta', gameName: 'Delta Force', sens: 6 }), helpers('ja'));
    ok(!delta.includes(esc(T('drConvTitle'))), '未確認のタイトルからは換算表を出さない');
});
check('前回の記録との比較を出す（入力の変化・係数の更新の説明）', () => {
    const T = makeT('ja');
    const prev = entry({ sens: '0.5', coef: 'old', inputs: { ...INPUTS, aimPart: 'arm' } });
    const html = D.renderReport(report(), helpers('ja', { prev }));
    ok(html.includes('-20.0%'), 'eDPI の差'); ok(html.includes(esc(T('drFPivot'))), '変わった入力');
    const coef = D.renderReport(report(), helpers('ja', { prev: entry({ sens: '0.5', coef: 'old' }) }));
    ok(coef.includes(esc(T('drDiffCoef'))), '係数の更新の説明');
    ok(D.renderReport(report(), helpers('ja')).includes(esc(T('drPrevNone'))), '履歴が無いときの案内');
});
check('履歴: 0件・1件では傾向を見せず、次の行動を案内する', () => {
    const T = makeT('ja');
    const none = D.renderHistory([], helpers('ja'));
    ok(none.includes(esc(T('dhEmpty'))) && !none.includes('<svg'));
    const one = D.renderHistory([entry()], helpers('ja'));
    ok(one.includes(esc(T('dhOne'))) && !one.includes('<svg') && !one.includes(esc(T('dhVsPrev'))));
});
check('履歴: 2件以上でグラフと前回比、少ないときは注意書き', () => {
    const T = makeT('ja');
    const two = [entry({ id: 'a' }), entry({ id: 'b', sens: '0.5', at: '2026-10-02T00:00:00Z' })];
    const html = D.renderHistory(two, helpers('ja'));
    ok(html.includes('<svg') && html.includes(esc(T('dhVsPrev'))) && html.includes(esc(T('dhFew'))));
    ok(html.includes(esc(T('dhCausal'))), '因果を言わない注意書き');
    ok(!html.includes(esc(T('dhVsFirst'))), '2件では初回比を重ねて出さない');
    const three = two.concat([entry({ id: 'c', sens: '0.6', at: '2026-10-03T00:00:00Z' })]);
    ok(D.renderHistory(three, helpers('ja')).includes(esc(T('dhVsFirst'))));
});
check('履歴: 換算できない記録はグラフに入れず、その旨を表示する', () => {
    const T = makeT('ja');
    const list = [entry({ id: 'a' }), entry({ id: 'b', game: 'delta', sens: '6', at: '2026-10-02T00:00:00Z' })];
    const html = D.renderHistory(list, helpers('ja', { viewGame: 'valo' }));
    ok(!html.includes('<svg') && html.includes(esc(T('dhChartNone'))) && html.includes(esc(T('dhNoConv'))));
    ok(html.includes(esc(T('dhRecordedAs', { game: 'Delta Force', sens: '6', edpi: '4800', dpi: '800' }))), '記録時の値は見せる');
});
check('利用者の入力や保存内容を HTML として解釈させない', () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const h = D.renderHistory([entry({ id: evil, game: evil }), entry({ id: 'b', cur: '0.4', at: '2026-10-02T00:00:00Z' })], helpers('ja'));
    ok(!h.includes('<img'), '履歴');
    const r = D.renderReport(report({ gameName: evil }), helpers('ja', { prev: entry({ game: evil }) }));
    ok(!r.includes('<img'), 'レポート');
});

// ============================================================ 多言語

check('モジュールの文言が3言語で同じ鍵・同じ置換子を持つ', () => {
    const base = Object.keys(D.I18N.ja).sort();
    const ph = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort().join(',');
    for (const lang of ['en', 'ko']) {
        eq(Object.keys(D.I18N[lang]).sort(), base, lang + ' の鍵');
        for (const k of base) {
            eq(ph(D.I18N[lang][k]), ph(D.I18N.ja[k]), `${lang}.${k} の置換子`);
            ok(D.I18N[lang][k].trim().length > 0, `${lang}.${k} が空`);
        }
    }
    ok(base.length > 60, '鍵の数: ' + base.length);
});
check('描画が呼ぶ鍵がすべて辞書にある', () => {
    const src = fs.readFileSync(path.join(ROOT, 'ui/diag-report.js'), 'utf8');
    const used = new Set([...src.matchAll(/T\('(\w+)'/g)].map((m) => m[1]));
    [...src.matchAll(/: '(dr[A-Z]\w+|dh[A-Z]\w+)'/g)].forEach((m) => used.add(m[1]));
    ['drCurHigherNoPct', 'drCurLowerNoPct'].forEach((k) => used.add(k));
    for (const k of used) ok(k in D.I18N.ja, k);
});

// ============================================================ index.html への組み込み

const app = loadApp();

check('index.html の翻訳表が3言語で同じ鍵を持つ', () => {
    const base = Object.keys(app.translations.ja).sort();
    for (const lang of ['en', 'ko']) {
        const keys = Object.keys(app.translations[lang]);
        eq(base.filter((k) => !keys.includes(k)), [], lang + ' に無い鍵');
        eq(keys.filter((k) => !base.includes(k)), [], lang + ' だけにある鍵');
    }
});
check('index.html の data-i18n がすべて辞書にある', () => {
    const keys = new Set([...indexHtml.matchAll(/data-i18n="(\w+)"/g)].map((m) => m[1]));
    for (const k of keys) ok(k in app.translations.ja || k in D.I18N.ja, k);
});
check('index.html の JS が T(\'…\') で呼ぶ鍵がすべて辞書にある', () => {
    const keys = new Set([...indexHtml.matchAll(/\bT\('(\w+)'/g)].map((m) => m[1]));
    ok(keys.size > 10, '検出数: ' + keys.size);
    for (const k of keys) ok(k in app.translations.ja || k in D.I18N.ja, k);
});
check('見出しと補足を入れ子にしていない（言語切替で補足が消えない）', () => {
    ok(!/<label[^>]*data-i18n="label(Dpi|Sens)"/.test(indexHtml), 'label 自体に data-i18n が付いている');
    ok(/<span data-i18n="labelDpi">/.test(indexHtml) && /<span data-i18n="labelSens">/.test(indexHtml));
});
check('韓国語の辞書に日本語の文字が混ざっていない', () => {
    for (const dict of [app.translations.ko, D.I18N.ko]) for (const [k, v] of Object.entries(dict)) {
        ok(!/[぀-ヿ一-鿿]/.test(v.replace(/[「」・〜（）]/g, '')), `ko.${k}: ${v}`);
    }
});
check('結果カード（resultBox）に cm/360 の直書きが無い', () => {
    const m = indexHtml.match(/<div id="resultBox"[\s\S]*?<!-- 解説セクション/);
    ok(m, 'resultBox を取り出せない');
    ok(!CM_PATTERN.test(m[0]), 'cm/360 が残っている');
});
check('診断レポートの部品が読み込めなくても診断は動く（部品なしの環境で計算できる）', () => {
    const r = app.diagnose({ game: 'valo', height: 170, dexterity: '3', armThickness: 'normal',
        mouseWeight: 'standard', aimPart: 'wrist', dpi: 800 });
    const line = fs.readFileSync(path.join(ROOT, 'tests/baseline.csv'), 'utf8').split(/\r?\n/)
        .find((l) => l.startsWith('valo,170,3,normal,standard,wrist,800,'));
    ok(line, 'baseline に行がある');
    eq(r.finalSens, line.split(',')[7], 'baseline と同じ値');
});

function run(values) {
    const set = (id, v) => { app.getElementById(id).value = v; };
    set('game', 'valo'); set('height', '173'); set('neuro', '3'); set('armThickness', 'normal');
    set('weight', 'standard'); set('pivot', 'wrist'); set('currentDpi', '800'); set('currentSens', '');
    for (const [id, v] of Object.entries(values || {})) set(id, v);
    app.calculateEDPI();
    return { result: app.getDiagResult(), error: app.getElementById('diagError').innerText,
             shown: app.getElementById('resultBox').style.display };
}

check('同じ入力なら同じ結果になる', () => {
    const a = run().result.finalSens, b = run().result.finalSens;
    eq(a, b); ok(parseFloat(a) > 0);
});
check('身長が範囲外・空のときは計算せず、理由を表示する', () => {
    for (const h of ['', '400', '1000', '129', '221', 'abc']) {
        const r = run({ height: h });
        eq(r.result, null, `身長 ${h}`); ok(r.error.length > 0, `身長 ${h} の理由`); eq(r.shown, 'none');
    }
    for (const h of ['130', '220']) ok(run({ height: h }).result, `境界 ${h}`);
});
check('DPI が範囲外のときは計算しない。空欄・0 は 800 として計算する', () => {
    for (const d of ['1', '99', '0.001', '25601']) {
        const r = run({ currentDpi: d });
        eq(r.result, null, `DPI ${d}`); ok(r.error.length > 0);
    }
    for (const d of ['', '0', 'abc']) eq(run({ currentDpi: d }).result.dpi, 800, `DPI "${d}"`);
    for (const d of ['100', '25600']) eq(run({ currentDpi: d }).result.dpi, Number(d), `境界 ${d}`);
});
check('エラーの後に正しい入力へ戻すと、エラー表示が消える', () => {
    run({ height: '400' });
    const r = run();
    ok(r.result); eq(r.error, ''); eq(r.shown, 'block');
});
check('マイナスや「-」の感度を結果として出さない（全タイトル・境界の身長）', () => {
    for (const g of GAMES) for (const h of ['130', '220']) for (const d of ['100', '25600']) {
        const r = run({ game: g.key, height: h, currentDpi: d, neuro: '5', pivot: 'shoulder' });
        ok(r.result && parseFloat(r.result.finalSens) > 0, `${g.key}/${h}/${d}: ${r.result && r.result.finalSens}`);
    }
});
check('エラー文言が3言語にある', () => {
    for (const lang of ['ja', 'en', 'ko']) {
        app.changeLanguage(lang);
        const r = run({ height: '400' });
        eq(r.error, app.translations[lang].errHeight, lang);
    }
    app.changeLanguage('ja');
});

// ------------------------------------------------------------- 実行

for (const { name, fn } of pending) {
    try { await fn(); passed++; }
    catch (e) { failures.push({ name, message: e.message }); }
}

const total = passed + failures.length;
if (failures.length === 0) {
    console.log(`✅ 診断レポート / 履歴 / eDPI 換算テスト成功: ${passed}/${total} 件`);
    process.exit(0);
}
console.error(`❌ 診断レポート / 履歴 / eDPI 換算テスト失敗: ${failures.length}/${total} 件`);
for (const f of failures) console.error(`   - ${f.name}\n     ${f.message}`);
process.exit(1);
