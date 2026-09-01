// 感度計算の回帰テスト。
//
//   node tests/regression.mjs          … ベースラインと突き合わせる（差分があれば異常終了）
//   node tests/regression.mjs --update … ベースラインを現在の実装で作り直す
//
// ベースライン `tests/baseline.csv` は「現在の index.html が出す答え」を固定したもの。
// 機能を追加しても、この出力が 1 行も変わらないことが「ベースを崩していない」証拠になる。
// 係数や計算式を意図的に変えたときだけ --update で更新し、差分を必ずレビューする。

import fs from 'node:fs';
import path from 'node:path';
import { loadApp, REPO_ROOT } from './lib/sandbox.mjs';
import { CASES, CSV_HEADER, GAME_KEYS, caseToCsv } from './lib/grid.mjs';

const BASELINE = path.join(REPO_ROOT, 'tests', 'baseline.csv');
const update = process.argv.includes('--update');

// games.json にあるタイトルがテスト対象から漏れていないか確認する。
// タイトルを足したのに baseline を作り直していない、という事故を防ぐ。
const registryKeys = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'games.json'), 'utf8'),
).games.map((g) => g.key);
const uncovered = registryKeys.filter((k) => !GAME_KEYS.includes(k));
if (uncovered.length > 0) {
    console.error(`❌ games.json のタイトルが回帰テストに含まれていません: ${uncovered.join(', ')}`);
    console.error('   tests/lib/grid.mjs の GAME_KEYS へ追記し、--update でベースラインを作り直してください。');
    process.exit(1);
}

const app = loadApp();

const lines = [CSV_HEADER];
for (const c of CASES) {
    lines.push(caseToCsv(c, app.diagnose(c)));
}
const current = lines.join('\n') + '\n';

if (update) {
    fs.writeFileSync(BASELINE, current);
    console.log(`✅ ベースラインを更新しました（${CASES.length} パターン）: tests/baseline.csv`);
    console.log('   差分を必ず git diff で確認してからコミットしてください。');
    process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
    console.error('❌ tests/baseline.csv がありません。初回は --update で作成してください。');
    process.exit(1);
}

// 改行コードは環境依存（Windows の git は CRLF でチェックアウトすることがある）。
// baseline.csv は常に LF で書き出し、比較時は読み込み側を LF へ正規化する。
// これをしないと Windows 環境で全行が差分扱いになり、テストが使えない。
const expected = fs.readFileSync(BASELINE, 'utf8').replace(/\r\n/g, '\n');
if (expected === current) {
    console.log(`✅ 回帰テスト成功: ${CASES.length} パターンすべて一致（感度計算に変化なし）`);
    process.exit(0);
}

// 差分を人が読める形で出す
const exp = expected.split('\n');
const got = current.split('\n');
const diffs = [];
for (let i = 0; i < Math.max(exp.length, got.length); i++) {
    if (exp[i] !== got[i]) diffs.push({ line: i + 1, expected: exp[i] ?? '(なし)', actual: got[i] ?? '(なし)' });
}

console.error(`❌ 回帰テスト失敗: ${diffs.length} 行が baseline と異なります`);
console.error(`   ヘッダ: ${CSV_HEADER}`);
for (const d of diffs.slice(0, 20)) {
    console.error(`   L${d.line}\n     期待: ${d.expected}\n     実際: ${d.actual}`);
}
if (diffs.length > 20) console.error(`   ... 他 ${diffs.length - 20} 行`);
console.error('\n   意図した変更なら: node tests/regression.mjs --update');
process.exit(1);
