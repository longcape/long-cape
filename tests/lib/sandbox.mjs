// index.html の本体スクリプトを、Node 上の最小 DOM スタブで読み込むためのローダ。
//
// 目的は「index.html を一切変更せずに、本番と同じコードパスで感度計算を再現する」こと。
// 計算ロジックを別ファイルへ切り出す（＝既存構成を崩す）代わりに、
// document / localStorage / navigator だけを差し替えて実物を動かしている。
//
// UI の構造を大きく変えたときはこのスタブ側の調整が必要になる。
// その場合でも、調整するのはこのファイルだけで index.html には手を入れない。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/** index.html から「最後の <script>（本体スクリプト）」の中身だけを取り出す。 */
export function extractMainScript(html) {
    // 属性付き script（ld+json / 外部 src / 折りたたみ用の小さな script）は対象外にする。
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    if (blocks.length === 0) throw new Error('index.html に <script> ブロックが見つかりません');
    // 本体は最も長いブロック（約 800 行）。将来 script が増えても壊れないよう長さで選ぶ。
    return blocks.reduce((a, b) => (b.length > a.length ? b : a));
}

/** 参照されたぶんだけ生える、ゆるい DOM 要素スタブ。 */
function createElement(id) {
    return {
        id,
        value: '',
        innerText: '',
        innerHTML: '',
        textContent: '',
        href: '',
        disabled: false,
        checked: false,
        style: {},
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        appendChild() {},
        removeChild() {},
        setAttribute() {},
        getAttribute: () => null,
        addEventListener() {},
        focus() {},
        click() {},
    };
}

/**
 * index.html の本体スクリプトを評価し、計算に必要な関数・状態を取り出す。
 * @param {string} [htmlPath] 対象の index.html（既定はリポジトリ直下）
 */
export function loadApp(htmlPath = path.join(REPO_ROOT, 'index.html')) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const source = extractMainScript(html);

    const elements = new Map();
    const getElementById = (id) => {
        if (!elements.has(id)) elements.set(id, createElement(id));
        return elements.get(id);
    };

    const store = new Map();
    const localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => void store.set(k, String(v)),
        removeItem: (k) => void store.delete(k),
        clear: () => void store.clear(),
    };

    const documentStub = {
        getElementById,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => createElement('created'),
        addEventListener() {},
        documentElement: createElement('html'),
        body: createElement('body'),
    };

    const context = {
        console,
        Math,
        JSON,
        Date,
        parseFloat,
        parseInt,
        isFinite,
        isNaN,
        String,
        Number,
        Boolean,
        Array,
        Object,
        Error,
        encodeURIComponent,
        decodeURIComponent,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        document: documentStub,
        localStorage,
        // 'serviceWorker' in navigator を false にして、末尾の解除処理を素通りさせる
        navigator: { language: 'ja' },
        location: { href: 'https://longcapenotieri.jp/', search: '', hash: '' },
        fetch: () => Promise.reject(new Error('network disabled in tests')),
        alert() {},
        confirm: () => false,
    };
    context.window = context;
    context.globalThis = context;
    context.window.addEventListener = () => {};

    vm.createContext(context);

    // 本体スクリプトの末尾で、let/const のトップレベル束縛を明示的に公開する。
    // （vm ではレキシカル束縛がグローバルオブジェクトのプロパティにならないため）
    const exportTail = `
    ;globalThis.__app = {
        calculateEDPI,
        getSensDisplayString,
        formatSens,
        sensToNumericString,
        dynamicConfig,
        SENS_INPUT_RANGE,
        get currentDiagResult() { return currentDiagResult; },
    };`;

    vm.runInContext(source + exportTail, context, { filename: 'index.html:<script>' });

    const app = context.__app;
    if (!app || typeof app.calculateEDPI !== 'function') {
        throw new Error('index.html から calculateEDPI を取得できませんでした');
    }

    /**
     * 診断フォームへ値を入れて calculateEDPI() を実行し、結果を返す。
     * 本番と同じ関数をそのまま呼ぶため、計算式の変更は必ずここに現れる。
     */
    function diagnose({ game, height, dexterity, armThickness, mouseWeight, aimPart, dpi }) {
        getElementById('game').value = game;
        getElementById('height').value = String(height);
        getElementById('neuro').value = String(dexterity);
        getElementById('armThickness').value = armThickness;
        getElementById('weight').value = mouseWeight;
        getElementById('pivot').value = aimPart;
        getElementById('currentDpi').value = dpi === null || dpi === undefined ? '' : String(dpi);
        // 学習用データの収集を走らせない（空なら collectLearningSample は即 return）
        getElementById('currentSens').value = '';

        app.calculateEDPI();

        const r = app.currentDiagResult;
        return {
            game: r.game,
            dpi: r.dpi,
            // DB へ保存される値そのもの
            finalSens: r.finalSens,
            // 画面に表示される文字列（単位付き）
            display: getElementById('resultValue').innerText,
        };
    }

    return { ...app, diagnose, getElementById, elements };
}
