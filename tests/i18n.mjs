// 多言語（日本語 / English / 한국어）の整合テスト。
//
//   node tests/i18n.mjs
//
// 目的は「訳し忘れ」と「辞書に無い鍵を画面が呼ぶ」を機械的に止めること。
// 画面に出す文字列を HTML や JS へ直書きしていないかも検査する。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PAGES = ['import.html', 'profile.html'];

function loadI18n() {
    const ctx = { console, Math, JSON, Date, Number, String, Boolean, Array, Object, isFinite, isNaN, Promise, Error };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'ui/i18n.js'), 'utf8'), ctx, { filename: 'ui/i18n.js' });
    return ctx.LC_I18N;
}

const I = loadI18n();

let passed = 0;
const failures = [];
const pending = [];
const check = (name, fn) => pending.push({ name, fn });
function eq(a, b, l) {
    const x = JSON.stringify(a), y = JSON.stringify(b);
    if (x !== y) throw new Error(`${l || ''} 期待 ${y} / 実際 ${x}`);
}
function ok(c, l) { if (!c) throw new Error(l || '条件を満たしません'); }

const pageSrc = {};
PAGES.forEach((p) => { pageSrc[p] = fs.readFileSync(path.join(ROOT, p), 'utf8'); });

/** HTML から <script> の中身だけ取り出す（コメントは除去する）。 */
function scriptOf(src) {
    const m = src.match(/<script>([\s\S]*?)<\/script>/);
    return (m ? m[1] : '')
        .replace(/\/\*[\s\S]*?\*\//g, '')   // ブロックコメント
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 行コメント（URL の // は避ける）
}

// ==================================================== 辞書そのもの

check('3言語すべてに同じ鍵が揃っている', async () => {
    const a = I.auditKeys();
    ok(a.complete, '不足/余分: ' + JSON.stringify({ missing: a.missing, extra: a.extra }));
    ok(a.keyCount > 100, '鍵の数: ' + a.keyCount);
});

check('対応言語が既存サイトと同じ3つ', async () => {
    eq(I.LANGS, ['ja', 'en', 'ko'], '日本語 / 英語 / 韓国語');
    eq(I.DEFAULT, 'ja', '既定は日本語');
});

check('どの言語でも空文字の訳がない', async () => {
    I.LANGS.forEach((l) => {
        Object.keys(I.dict[l]).forEach((k) => {
            const v = I.dict[l][k];
            ok(typeof v === 'string' && v.trim().length > 0, `${l}.${k} が空`);
        });
    });
});

check('置換の {…} が3言語で一致している', async () => {
    const ph = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort().join(',');
    Object.keys(I.dict.ja).forEach((k) => {
        const base = ph(I.dict.ja[k]);
        I.LANGS.forEach((l) => {
            if (l === 'ja') return;
            eq(ph(I.dict[l][k]), base, `${k} の置換子が ${l} でずれている`);
        });
    });
});

check('置換が実際に効く', async () => {
    I.LANGS.forEach((l) => {
        I.setLang(l);
        const s = I.t('dpiQuestion', { dpi: 400 });
        ok(s.indexOf('400') >= 0, `${l}: 値が入る`);
        ok(s.indexOf('{dpi}') < 0, `${l}: 置換子が残らない`);
    });
    I.setLang('ja');
});

check('訳が無い鍵は日本語へ落ちる（画面が空欄にならない）', async () => {
    I.setLang('en');
    // 実在しない鍵は鍵名をそのまま返す（消えない）
    eq(I.t('__no_such_key__'), '__no_such_key__', '鍵名を返す');
    I.setLang('ja');
});

// ==================================================== 画面との結び付き

check('data-i18n が参照する鍵がすべて辞書にある', async () => {
    const missing = [];
    PAGES.forEach((p) => {
        const keys = [...pageSrc[p].matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
        keys.forEach((k) => { if (I.dict.ja[k] === undefined) missing.push(`${p}: ${k}`); });
    });
    eq(missing, [], '辞書に無い鍵');
});

check('data-i18n-attr が参照する鍵がすべて辞書にある', async () => {
    const missing = [];
    PAGES.forEach((p) => {
        [...pageSrc[p].matchAll(/data-i18n-attr="([^"]+)"/g)].forEach((m) => {
            m[1].split(';').forEach((pair) => {
                const kv = pair.split(':');
                if (kv.length === 2 && I.dict.ja[kv[1].trim()] === undefined) {
                    missing.push(`${p}: ${kv[1].trim()}`);
                }
            });
        });
    });
    eq(missing, [], '辞書に無い鍵');
});

check("JS が T('…') で呼ぶ鍵がすべて辞書にある", async () => {
    const missing = [];
    PAGES.forEach((p) => {
        const js = scriptOf(pageSrc[p]);
        [...js.matchAll(/\bT\(\s*'([^']+)'/g)].forEach((m) => {
            const k = m[1];
            // 'errNetwork' + 'Body' のような連結は別で検査する
            if (I.dict.ja[k] === undefined) missing.push(`${p}: ${k}`);
        });
    });
    eq(missing, [], '辞書に無い鍵');
});

check('エラー種別ごとに本文の鍵が揃っている', async () => {
    ['errNetwork', 'errServer', 'errAuth', 'errPermission', 'errUnknown'].forEach((k) => {
        ok(I.dict.ja[k], k + ' がある');
        ok(I.dict.ja[k + 'Body'], k + 'Body がある');
        I.LANGS.forEach((l) => {
            ok(I.dict[l][k] && I.dict[l][k + 'Body'], `${l} に ${k} 一式がある`);
        });
    });
});

check('同意の文言が3言語すべてにある', async () => {
    ['consentProfile', 'consentStats', 'consentModel'].forEach((k) => {
        I.LANGS.forEach((l) => {
            ok(I.dict[l][k] && I.dict[l][k + 'Desc'], `${l}.${k} と説明がある`);
        });
    });
    // 取り消しても既存データを消さない、という説明も3言語に必要
    I.LANGS.forEach((l) => ok(I.dict[l].consentRevokeKeeps, `${l} に取り消しの説明がある`));
});

check('技術用語の言い換えも辞書にある', async () => {
    ['stateConfirmed', 'stateNeedsCheck', 'stateExcluded', 'stateUnsupported',
     'meterCompleteness', 'meterQuality', 'meterConfidence',
     'fieldDpiVerified', 'fieldCm360', 'cm360Blocked'].forEach((k) => {
        I.LANGS.forEach((l) => ok(I.dict[l][k], `${l}.${k}`));
    });
});

// ==================================================== 直書きの検出

check('画面に出す文字列を JS へ直書きしていない', async () => {
    const offenders = [];
    PAGES.forEach((p) => {
        const js = scriptOf(pageSrc[p]);
        // innerHTML / textContent へ代入している行に、日本語の文字列リテラルが無いこと
        js.split('\n').forEach((line, i) => {
            if (!/innerHTML|textContent/.test(line)) return;
            const lits = line.match(/'[^']*'/g) || [];
            lits.forEach((lit) => {
                if (/[ぁ-んァ-ヶ一-龠]/.test(lit)) offenders.push(`${p}:${i + 1} ${lit.slice(0, 40)}`);
            });
        });
    });
    eq(offenders, [], '直書きが残っている');
});

check('HTML の可視テキストに data-i18n が付いている', async () => {
    const offenders = [];
    PAGES.forEach((p) => {
        // ブランド名（固有名詞）と言語名は翻訳しないので除く
        const body = pageSrc[p].split('<script')[0];
        [...body.matchAll(/<(h1|h2|h3|p|button|a|span|b|legend|summary)\b([^>]*)>([^<]+)</g)].forEach((m) => {
            const attrs = m[2], text = m[3].trim();
            if (!text || !/[ぁ-んァ-ヶ一-龠]/.test(text)) return;
            if (/data-i18n/.test(attrs)) return;
            if (/ロングケープの定理|本文へスキップ/.test(text)) return;  // 固有名詞・skiplink
            offenders.push(`${p}: ${text.slice(0, 30)}`);
        });
    });
    eq(offenders, [], 'data-i18n が付いていない可視テキスト');
});

// ==================================================== 言語切り替え

check('言語を切り替えると文言が実際に変わる', async () => {
    const ja = (I.setLang('ja'), I.t('saveButton'));
    const en = (I.setLang('en'), I.t('saveButton'));
    const ko = (I.setLang('ko'), I.t('saveButton'));
    I.setLang('ja');
    ok(ja !== en && en !== ko && ja !== ko, `3言語で違う: ${ja} / ${en} / ${ko}`);
});

check('未対応の言語コードは既定へ落とす', async () => {
    const before = I.getLang();
    I.setLang('zz');
    eq(I.getLang(), before, '変わらない');
});

// ==================================================== 実行

for (const { name, fn } of pending) {
    try { await fn(); passed++; }
    catch (e) { failures.push({ name, message: e.message }); }
}

const total = passed + failures.length;
if (failures.length === 0) {
    console.log(`✅ i18n テスト成功: ${passed}/${total} 件`);
    process.exit(0);
}
console.error(`❌ i18n テスト失敗: ${failures.length}/${total} 件`);
for (const f of failures) console.error(`   - ${f.name}\n     ${f.message}`);
process.exit(1);
