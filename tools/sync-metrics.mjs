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
// planned_metrics の書き出し先。**production Registry とは別ファイルにする。**
const TARGET_PLANNED = path.join(REPO_ROOT, 'profile', 'sensitivity-recommendation.js');

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

// ------------------------------------------------ planned_metrics の検査
//
// 実戦Aim解析用の「将来の候補」。**まだ実測していないので Registry に入れない。**
// ここでの本質的な不変条件は次の3つ。
//   1. production の metrics と key が衝突しない
//   2. maturity が planned / experimental / unvalidated のいずれか
//      （production_rated をここに書けない）
//   3. recommendation_eligible を true にできない
// 3 を機械で禁じているので、「文書には未検証と書いてあるのに推奨に使われる」が起こらない。

const PLANNED_MATURITY = ['planned', 'experimental', 'unvalidated'];
const PLANNED_REQUIRED = [
    'metric_key', 'source', 'concept', 'category', 'unit', 'data_type',
    'higher_is_better', 'role', 'maturity', 'target_layer',
    'recommendation_eligible', 'description', 'status_reason', 'measurement_requirements'
];
const PLANNED_ROLES = ['performance', 'context_dimension'];

const planned = (registry.planned_metrics || {}).metrics || [];
const producedKeys = new Set(metrics.map((m) => m.metric_key));
const plannedSeen = new Set();

for (const p of planned) {
    const key = p.metric_key || '(no key)';
    for (const f of PLANNED_REQUIRED) {
        if (!(f in p)) problems.push(`planned ${key}: 必須項目 ${f} がありません`);
    }
    if (plannedSeen.has(p.metric_key)) problems.push(`planned ${key}: metric_key が重複しています`);
    plannedSeen.add(p.metric_key);

    // 1. Registry と衝突しない
    if (producedKeys.has(p.metric_key)) {
        problems.push(`planned ${key}: production の metrics と metric_key が衝突しています。`
            + `production-rated へ上げるなら planned_metrics から取り除いてください`);
    }
    if (p.metric_key && p.source && p.metric_key.indexOf(p.source + '.') !== 0) {
        problems.push(`planned ${key}: metric_key は "<source>." で始まる必要があります（source=${p.source}）`);
    }

    // 2. production_rated をここに書けない
    if (PLANNED_MATURITY.indexOf(p.maturity) < 0) {
        problems.push(`planned ${key}: maturity は ${PLANNED_MATURITY.join(' / ')} のいずれか`
            + `（production_rated は metrics 側でのみ表現します）現在: ${p.maturity}`);
    }

    // 3. 推奨を駆動できない
    if (p.recommendation_eligible !== false) {
        problems.push(`planned ${key}: recommendation_eligible は false 固定です。`
            + `未実測の metric が推奨を駆動してはいけません`);
    }
    // 4軸 reliability を持たせない（rated と誤認させない）
    if (p.reliability_policy) {
        problems.push(`planned ${key}: reliability_policy を持たせてはいけません。`
            + `rated 化は metrics 側へ移してから行います`);
    }
    if (PLANNED_ROLES.indexOf(p.role) < 0) {
        problems.push(`planned ${key}: role は ${PLANNED_ROLES.join(' / ')} のいずれか（現在: ${p.role}）`);
    }
    // 条件の軸に優劣を付けない（flick角や左右方向に「高いほど良い」は無い）
    if (p.role === 'context_dimension' && p.higher_is_better !== null) {
        problems.push(`planned ${key}: role が context_dimension なら higher_is_better は null です。`
            + `条件の軸に優劣を付けないでください`);
    }
    if (p.role === 'performance' && typeof p.higher_is_better !== 'boolean') {
        problems.push(`planned ${key}: role が performance なら higher_is_better は真偽値です`);
    }
    if (!Array.isArray(p.measurement_requirements) || p.measurement_requirements.length === 0) {
        problems.push(`planned ${key}: measurement_requirements に「何が揃えば測れるか」を書いてください`);
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

// planned_metrics は **別ファイル・別ブロック**へ生成する。
// production の Registry（profile/metric-registry.js）へは絶対に混ぜない。
// 混ぜないことが「未実測の metric が推奨を駆動しない」ことの担保になる。
const plannedBlock = 'var PLANNED_METRICS = {\n'
    + '        plannedVersion: ' + JSON.stringify((registry.planned_metrics || {}).planned_version || '0') + ',\n'
    + '        metrics: [\n'
    + planned.map((p) => '            ' + JSON.stringify(p) + ',').join('\n').replace(/,$/, '') + '\n'
    + '        ]\n'
    + '    };';

/**
 * 生成ブロックを対象ファイルへ書き戻す。差分があれば --check で異常終了する。
 * 改行コードは環境依存なので、内部は LF で扱い書き戻すときに元へ戻す。
 */
function syncBlock(target, marker, body, label) {
    const BEGIN = `/* ${marker}:BEGIN */`;
    const END = `/* ${marker}:END */`;

    const raw = fs.readFileSync(target, 'utf8');
    const usesCRLF = raw.includes('\r\n');
    const src = raw.replace(/\r\n/g, '\n');

    const b = src.indexOf(BEGIN);
    const e = src.indexOf(END);
    if (b < 0 || e < 0 || e < b) {
        console.error(`❌ ${path.basename(target)} に ${marker}:BEGIN / END マーカーが見つかりません`);
        process.exit(1);
    }

    const next = src.slice(0, b + BEGIN.length) + '\n' + body + '\n' + src.slice(e);
    const rel = path.relative(REPO_ROOT, target).replace(/\\/g, '/');

    if (next === src) {
        console.log(`✅ ${rel} は metrics.json と一致しています（${label}）`);
        return;
    }
    if (check) {
        console.error(`❌ ${rel} が metrics.json と一致していません。`);
        console.error('   `node tools/sync-metrics.mjs` を実行して生成ブロックを更新してください。');
        process.exit(1);
    }
    fs.writeFileSync(target, usesCRLF ? next.replace(/\n/g, '\r\n') : next);
    console.log(`✅ ${rel} を metrics.json と同期しました（${label}）`);
}

syncBlock(TARGET, 'METRICS', block, `${metrics.length} metric`);
syncBlock(TARGET_PLANNED, 'PLANNED_METRICS', plannedBlock, `${planned.length} planned metric`);
