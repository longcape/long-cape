// algorithm-config.json（正本）から profile/algorithm-config.js の生成ブロックを書き戻す。
//
//   node tools/sync-algorithm-config.mjs         … 生成ブロックを更新する
//   node tools/sync-algorithm-config.mjs --check … 差分があれば異常終了（CI用）
//
// 重みや閾値は algorithm-config.json だけを編集する。人手による二重管理を禁止する。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(REPO_ROOT, 'algorithm-config.json');
const TARGET = path.join(REPO_ROOT, 'profile', 'algorithm-config.js');
const check = process.argv.includes('--check');

const conf = JSON.parse(fs.readFileSync(SRC, 'utf8'));

const problems = [];
if (!conf.config_version) problems.push('config_version がありません');
const wsum = Object.entries(conf.factorWeights || {})
    .filter(([k]) => !k.startsWith('_'))
    .reduce((s, [, v]) => s + v, 0);
if (Math.abs(wsum - 1) > 1e-9) problems.push(`factorWeights の合計が 1 ではありません（${wsum}）`);
for (const k of ['minSensitivityLevels', 'minSessionsPerLevel', 'minTotalSessions']) {
    if (typeof (conf.gates || {})[k] !== 'number') problems.push(`gates.${k} が数値ではありません`);
}
if (typeof (conf.range || {}).rangeCompositeScoreTolerance !== 'number') {
    problems.push('range.rangeCompositeScoreTolerance が数値ではありません');
}
if (!(conf.range || {})._definition) {
    problems.push('range._definition がありません（tolerance の意味を明文化すること）');
}
if (problems.length) {
    console.error('❌ algorithm-config.json の検査に失敗しました');
    problems.forEach((p) => console.error('   - ' + p));
    process.exit(1);
}

const block = 'const ALGORITHM_CONFIG = ' + JSON.stringify(conf, null, 4) + ';';
const BEGIN = '/* ALGO_CONFIG:BEGIN */';
const END = '/* ALGO_CONFIG:END */';

const raw = fs.readFileSync(TARGET, 'utf8');
const usesCRLF = raw.includes('\r\n');
const src = raw.replace(/\r\n/g, '\n');
const b = src.indexOf(BEGIN), e = src.indexOf(END);
if (b < 0 || e < 0 || e < b) {
    console.error('❌ ALGO_CONFIG:BEGIN / END マーカーが見つかりません');
    process.exit(1);
}
const next = src.slice(0, b + BEGIN.length) + '\n' + block + '\n' + src.slice(e);

if (next === src) {
    console.log(`✅ profile/algorithm-config.js は algorithm-config.json と一致しています（config_version ${conf.config_version}）`);
    process.exit(0);
}
if (check) {
    console.error('❌ profile/algorithm-config.js が algorithm-config.json と一致していません。');
    console.error('   `node tools/sync-algorithm-config.mjs` を実行してください。');
    process.exit(1);
}
fs.writeFileSync(TARGET, usesCRLF ? next.replace(/\n/g, '\r\n') : next);
console.log(`✅ profile/algorithm-config.js を同期しました（config_version ${conf.config_version}）`);
