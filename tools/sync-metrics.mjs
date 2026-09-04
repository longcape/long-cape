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

// reliability の正本となる4軸。順序も含めてここが定義。
const RELIABILITY_AXES = ['measurement', 'semantic', 'comparability', 'provenance_integrity'];
// effective_reliability の算出方式。将来 calibration 結果で差し替えられるよう名前で持つ。
const EFFECTIVE_POLICIES = ['conservative_min_v1'];

// comparability_group は「ここに定義された静的 identifier」だけを許す。
// これが本質的な不変条件で、Hash の形式に依存しない。
const COMPARABILITY_RULES = ['same_scenario', 'cross_scenario', 'condition', 'kill_level', 'unresolved'];
const declaredGroups = new Map();

// G-2 より前に rated 化された metric だけが単一スカラーの reliability_policy.value を許される。
// 新規 metric がこの形式を使うことは禁止。増やせないよう明示列挙にしている。
const legacyScalar = new Set((registry.legacy_scalar_reliability || {}).metric_keys || []);

const problems = [];
const seen = new Set();

for (const g of registry.comparability_groups || []) {
    if (!g || typeof g.id !== 'string' || g.id === '') {
        problems.push('comparability_groups に id の無い項目があります');
        continue;
    }
    if (declaredGroups.has(g.id)) problems.push(`comparability_groups: id が重複しています: ${g.id}`);
    if (COMPARABILITY_RULES.indexOf(g.rule) < 0) {
        problems.push(`comparability_groups[${g.id}]: rule が未知です: ${g.rule}`);
    }
    declaredGroups.set(g.id, g);
}
if (declaredGroups.size === 0) {
    problems.push('comparability_groups が空です。comparability_group の静的定義が必要です');
}

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

    // --- reliability の正本は4軸。単一スカラーを正本にしない（G-2）
    const isLegacy = legacyScalar.has(m.metric_key);
    if (rp.status === 'rated' && !isLegacy) {
        const ax = rp.axes;
        if (!ax || typeof ax !== 'object') {
            problems.push(`${m.metric_key}: rated なら reliability_policy.axes が必要です（4軸が正本）`);
        } else {
            for (const a of RELIABILITY_AXES) {
                const v = ax[a];
                if (!v || typeof v.value !== 'number') {
                    problems.push(`${m.metric_key}: axes.${a}.value に数値が必要です`);
                } else if (v.value < 0 || v.value > 1) {
                    problems.push(`${m.metric_key}: axes.${a}.value は 0〜1 の範囲`);
                }
                if (!v || typeof v.basis !== 'string' || v.basis.trim() === '') {
                    problems.push(`${m.metric_key}: axes.${a}.basis に根拠を書いてください（汎用の既定値を置かない方針）`);
                }
            }
            for (const k of Object.keys(ax)) {
                if (RELIABILITY_AXES.indexOf(k) < 0) {
                    problems.push(`${m.metric_key}: axes に未知の軸 ${k} があります`);
                }
            }
        }
        const er = rp.effective_reliability;
        if (!er || er.derived !== true) {
            problems.push(`${m.metric_key}: effective_reliability.derived は true（派生値であることを明示）`);
        } else if (EFFECTIVE_POLICIES.indexOf(er.policy) < 0) {
            problems.push(`${m.metric_key}: effective_reliability.policy が未知です: ${er.policy}`);
        }
    }
    // Registry に単一スカラーの reliability を正本として置かせない
    if (isLegacy && typeof rp.value !== 'number') {
        problems.push(`${m.metric_key}: legacy_scalar_reliability に列挙されていますが value がありません`);
    }
    if ('value' in rp && !isLegacy) {
        problems.push(`${m.metric_key}: reliability_policy.value を正本にしてはいけません。`
            + `正本は axes の4軸で、実効値は runtime が effective_reliability.policy に従って算出します`);
    }
    if (rp.status === 'unrated' && rp.axes) {
        problems.push(`${m.metric_key}: unrated に axes を持たせてはいけません`);
    }
    // 未評価のものを推奨へ入れない
    if (m.recommendation_eligible === true && rp.status !== 'rated') {
        problems.push(`${m.metric_key}: recommendation_eligible が true なら reliability_policy は rated である必要があります`);
    }

    // --- comparability_group は Registry に定義された静的 identifier でなければならない（G-2 本質条件）
    const grp = m.comparability_group;
    if (!declaredGroups.has(grp)) {
        problems.push(`${m.metric_key}: comparability_group "${grp}" が comparability_groups に定義されていません。`
            + `session 由来の動的値を入れてはいけません`);
    } else if (m.recommendation_eligible === true) {
        const rule = declaredGroups.get(grp).rule;
        if (rule !== 'same_scenario' && rule !== 'cross_scenario') {
            problems.push(`${m.metric_key}: recommendation_eligible が true なら comparability rule は `
                + `same_scenario か cross_scenario である必要があります（現在 ${rule}）`);
        }
    }
    // 補助チェック。これ「だけ」に依存しない
    if (typeof grp === 'string') {
        if (grp.indexOf('@') >= 0) {
            problems.push(`${m.metric_key}: comparability_group に "@" を含めないでください（補助チェック）`);
        }
        if (/[0-9a-f]{16,}/i.test(grp)) {
            problems.push(`${m.metric_key}: comparability_group に長い16進値が含まれています。`
                + `session 由来の識別子の混入が疑われます（補助チェック）`);
        }
    }

    // --- 使用禁止が明記された metric を推奨へ入れない
    if (m.recommendation_eligible === true && rp.usage_prohibition
        && rp.usage_prohibition.recommendation === 'prohibited') {
        problems.push(`${m.metric_key}: usage_prohibition.recommendation が prohibited なのに eligible になっています`);
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
