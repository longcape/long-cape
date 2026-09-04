// metrics.json（正本）から profile/metric-registry.js の生成ブロックを書き戻す。
//
//   node tools/sync-metrics.mjs         … 生成ブロックを更新する
//   node tools/sync-metrics.mjs --check … 差分があれば異常終了（CI用）
//
// metric を追加・変更するときは metrics.json だけを編集し、このコマンドを実行する。
// profile/metric-registry.js の METRICS:BEGIN〜END は手で編集しないこと。
// 人手による二重管理を禁止するための仕組み。
//
// tools/sync-games.mjs と同じ思想・同じ改行コード対策を採る。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const METRICS_JSON = path.join(REPO_ROOT, 'metrics.json');
const TARGET = path.join(REPO_ROOT, 'profile', 'metric-registry.js');

const check = process.argv.includes('--check');

const registry = JSON.parse(fs.readFileSync(METRICS_JSON, 'utf8'));
const metrics = registry.metrics || [];

if (metrics.length === 0) {
    console.error('❌ metrics.json に metrics がありません');
    process.exit(1);
}

// ---------------------------------------------------------------- 妥当性検査

const REQUIRED = [
    'metric_key', 'source', 'concept', 'category', 'unit', 'data_type',
    'higher_is_better', 'layer', 'metric_version', 'comparability_group',
    'recommendation_eligible', 'reliability_policy', 'normalization_method', 'description'
];

const problems = [];
const seen = new Set();

for (const m of metrics) {
    for (const f of REQUIRED) {
        if (!(f in m)) problems.push(`${m.metric_key || '(no key)'}: 必須項目 ${f} がありません`);
    }
    const key = `${m.metric_key}@${m.metric_version}`;
    if (seen.has(key)) problems.push(`${key}: metric_key と metric_version の組が重複しています`);
    seen.add(key);

    // 名前空間の規約: <source>.<name>
    if (m.metric_key && m.source && m.metric_key.indexOf(m.source + '.') !== 0) {
        problems.push(`${m.metric_key}: metric_key は "<source>." で始まる必要があります（source=${m.source}）`);
    }

    const rp = m.reliability_policy || {};
    if (rp.status !== 'rated' && rp.status !== 'unrated') {
        problems.push(`${m.metric_key}: reliability_policy.status は rated か unrated`);
    }
    if (rp.status === 'rated' && typeof rp.value !== 'number') {
        problems.push(`${m.metric_key}: rated なら reliability_policy.value に数値が必要`);
    }
    if (rp.status === 'unrated' && 'value' in rp) {
        problems.push(`${m.metric_key}: unrated に value を持たせてはいけません（汎用の既定値を置かない方針）`);
    }
    // 未評価のものを推奨へ入れない
    if (m.recommendation_eligible === true && rp.status !== 'rated') {
        problems.push(`${m.metric_key}: recommendation_eligible が true なら reliability_policy は rated である必要があります`);
    }
}

if (problems.length > 0) {
    console.error('❌ metrics.json の検査に失敗しました');
    for (const p of problems) console.error('   - ' + p);
    process.exit(1);
}

// ------------------------------------------------------------------ 生成

function line(m) {
    return '    ' + JSON.stringify(m) + ',';
}

const block = 'const METRIC_REGISTRY = {\n'
    + '    registryVersion: ' + JSON.stringify(registry.registry_version || '0') + ',\n'
    + '    metrics: [\n'
    + metrics.map(line).join('\n').replace(/,$/, '') + '\n'
    + '    ]\n'
    + '};';

const BEGIN = '/* METRICS:BEGIN */';
const END = '/* METRICS:END */';

// 改行コードは環境依存。内部は LF で扱い、書き戻すときに元へ戻す。
const raw = fs.readFileSync(TARGET, 'utf8');
const usesCRLF = raw.includes('\r\n');
const src = raw.replace(/\r\n/g, '\n');

const b = src.indexOf(BEGIN);
const e = src.indexOf(END);
if (b < 0 || e < 0 || e < b) {
    console.error(`❌ ${path.basename(TARGET)} に METRICS:BEGIN / END マーカーが見つかりません`);
    process.exit(1);
}

const next = src.slice(0, b + BEGIN.length) + '\n' + block + '\n' + src.slice(e);

if (next === src) {
    console.log(`✅ profile/metric-registry.js は metrics.json と一致しています（${metrics.length} metric）`);
    process.exit(0);
}

if (check) {
    console.error('❌ profile/metric-registry.js が metrics.json と一致していません。');
    console.error('   `node tools/sync-metrics.mjs` を実行して生成ブロックを更新してください。');
    process.exit(1);
}

fs.writeFileSync(TARGET, usesCRLF ? next.replace(/\n/g, '\r\n') : next);
console.log(`✅ profile/metric-registry.js を metrics.json と同期しました（${metrics.length} metric）`);
