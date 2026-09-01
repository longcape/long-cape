// games.json から index.html の生成ブロックを書き戻す。
//
//   node tools/sync-games.mjs         … index.html を更新する
//   node tools/sync-games.mjs --check … 差分があれば異常終了（CI 用）
//
// タイトルの追加・変更は games.json だけを編集し、このコマンドを実行する。
// index.html 内の GAMES:BEGIN〜END と GAME_OPTIONS:BEGIN〜END は手で編集しないこと。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAMES_JSON = path.join(REPO_ROOT, 'games.json');
const INDEX_HTML = path.join(REPO_ROOT, 'index.html');

const check = process.argv.includes('--check');
const { games } = JSON.parse(fs.readFileSync(GAMES_JSON, 'utf8'));

if (!Array.isArray(games) || games.length === 0) {
    console.error('❌ games.json の games が空です');
    process.exit(1);
}

/** 埋め込み用の 1 行表現。キー順を固定して差分を安定させる。 */
function gameLine(g) {
    const curve = g.curve.type === 'atan'
        ? `{ "type": "atan", "base": ${g.curve.base}, "coef": ${g.curve.coef} }`
        : `{ "type": "constant", "value": ${g.curve.value} }`;
    return '    {'
        + ` "key": ${JSON.stringify(g.key)},`
        + ` "name": ${JSON.stringify(g.name)},`
        + ` "formLabel": ${JSON.stringify(g.formLabel)},`
        + ` "scale": ${g.scale},`
        + ` "curve": ${curve},`
        + ` "sensTransform": ${JSON.stringify(g.sensTransform)},`
        + ` "display": { "integer": ${g.display.integer}, "suffix": ${JSON.stringify(g.display.suffix)} },`
        + ` "inputRange": [${g.inputRange[0]}, ${g.inputRange[1]}] }`;
}

const gamesBlock = 'const GAMES = [\n'
    + games.map(gameLine).join(',\n')
    + '\n];';

/** HTML の <option> 群。診断フォームは長い日本語ラベル、感度メモは短い表示名を使う。 */
function optionsBlock(variant) {
    const indent = ' '.repeat(16);
    return games.map((g, i) => {
        const label = variant === 'diagnosis' ? g.formLabel : g.name;
        const selected = variant === 'diagnosis' && i === 0 ? ' selected' : '';
        return `${indent}<option value="${g.key}"${selected}>${label}</option>`;
    }).join('\n');
}

function replaceBlock(src, beginRe, endMarker, body, what, endIndent = '') {
    const m = src.match(beginRe);
    if (!m) throw new Error(`${what} の開始マーカーが index.html に見つかりません`);
    const start = m.index + m[0].length;
    const end = src.indexOf(endMarker, start);
    if (end === -1) throw new Error(`${what} の終了マーカーが index.html に見つかりません`);
    return src.slice(0, start) + '\n' + body + '\n' + endIndent + src.slice(end);
}

// 改行コードは環境依存（Windows の git は CRLF でチェックアウトすることがある）。
// 内部では LF に正規化して比較・生成し、書き戻すときに元の形式へ戻す。
// これをしないと Windows 環境で --check が常に失敗する。
const raw = fs.readFileSync(INDEX_HTML, 'utf8');
const usesCRLF = raw.includes('\r\n');
let html = raw.replace(/\r\n/g, '\n');
const before = html;

html = replaceBlock(html, /\/\* GAMES:BEGIN \*\//, '/* GAMES:END */', gamesBlock, 'GAMES');
html = replaceBlock(
    html,
    /<!-- GAME_OPTIONS:BEGIN diagnosis[^>]*-->/,
    '<!-- GAME_OPTIONS:END -->',
    optionsBlock('diagnosis'),
    'GAME_OPTIONS(diagnosis)',
    ' '.repeat(16),
);
html = replaceBlock(
    html,
    /<!-- GAME_OPTIONS:BEGIN memo[^>]*-->/,
    '<!-- GAME_OPTIONS:END -->',
    optionsBlock('memo'),
    'GAME_OPTIONS(memo)',
    ' '.repeat(16),
);

if (html === before) {
    console.log('✅ index.html は games.json と一致しています（変更なし）');
    process.exit(0);
}

if (check) {
    console.error('❌ index.html が games.json と一致していません。');
    console.error('   `node tools/sync-games.mjs` を実行して生成ブロックを更新してください。');
    process.exit(1);
}

fs.writeFileSync(INDEX_HTML, usesCRLF ? html.replace(/\n/g, '\r\n') : html);
console.log(`✅ index.html を games.json と同期しました（${games.length} タイトル）`);
console.log('   感度計算が変わっていないことを node tests/regression.mjs で確認してください。');
