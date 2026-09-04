// metrics.json（正本）から DB 用の Metric Registry seed SQL を生成する。
//
//   node tools/sync-metric-registry-sql.mjs         … 生成する
//   node tools/sync-metric-registry-sql.mjs --check … 差分があれば異常終了（CI / drift detection）
//
// 【方針】DB 側の aim_metric_registry は生成物であり、人が編集してはいけない。
// Git の metrics.json だけを編集し、このコマンドで seed を作り直す。
// 二重編集を防ぐため、--check を CI に入れてある。
//
// 生成される SQL は冪等（delete していない metric は残さない）。
// insert ... on conflict do update ＋ 消えた metric の delete で、常に metrics.json と一致させる。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const METRICS_JSON = path.join(REPO_ROOT, 'metrics.json');
const TARGET = path.join(REPO_ROOT, 'supabase', 'migrations', '0002_aim_metric_registry_seed.sql');

const check = process.argv.includes('--check');

const registry = JSON.parse(fs.readFileSync(METRICS_JSON, 'utf8'));
const groups = new Map((registry.comparability_groups || []).map((g) => [g.id, g]));

function lit(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return "'" + String(v).replace(/'/g, "''") + "'";
}

const rows = registry.metrics.map((m) => {
    const g = groups.get(m.comparability_group);
    if (!g) throw new Error(`${m.metric_key}: comparability_group が定義されていません`);
    const pol = m.reliability_policy || {};
    return '    (' + [
        lit(m.metric_key), lit(m.metric_version), lit(m.unit), lit(m.layer), lit(m.concept),
        lit(m.comparability_group), lit(g.rule), lit(pol.status),
        lit(m.recommendation_eligible === true),
        lit(!!(pol.recommendation_hold && pol.recommendation_hold.held)),
        lit(!!pol.usage_prohibition),
        lit(registry.registry_version)
    ].join(', ') + ')';
});

const keys = registry.metrics
    .map((m) => `('${m.metric_key}', '${m.metric_version}')`).join(', ');

const sql = `-- 0002_aim_metric_registry_seed.sql
--
-- **自動生成。手で編集しないこと。**
--   生成元: metrics.json （registry_version ${registry.registry_version} / ${registry.metrics.length} metric）
--   生成:   node tools/sync-metric-registry-sql.mjs
--   検証:   node tools/sync-metric-registry-sql.mjs --check
--
-- 正本は Git の metrics.json であり、この表ではない。
-- 差分は CI の drift detection が検出する。

insert into public.aim_metric_registry
    (metric_key, metric_version, unit, layer, concept,
     comparability_group, comparability_rule, rating_status,
     recommendation_eligible, recommendation_hold, usage_prohibited, registry_version)
values
${rows.join(',\n')}
on conflict (metric_key, metric_version) do update set
    unit                    = excluded.unit,
    layer                   = excluded.layer,
    concept                 = excluded.concept,
    comparability_group     = excluded.comparability_group,
    comparability_rule      = excluded.comparability_rule,
    rating_status           = excluded.rating_status,
    recommendation_eligible = excluded.recommendation_eligible,
    recommendation_hold     = excluded.recommendation_hold,
    usage_prohibited        = excluded.usage_prohibited,
    registry_version        = excluded.registry_version,
    synced_at               = now();

-- metrics.json から消えた metric を DB からも消す。
-- ただし **参照されている metric は外部キーで守られるので消えない**（消せない場合はエラーになり、
-- 「使われている metric を registry から外そうとした」ことに気づける）。
delete from public.aim_metric_registry r
where (r.metric_key, r.metric_version) not in (${keys});
`;

// 生成物の改行コードは既存ファイルに合わせる（Windows と CI で --check が割れないようにする）
function normalize(s) { return s.replace(/\r\n/g, '\n'); }

const next = normalize(sql);
const prev = fs.existsSync(TARGET) ? normalize(fs.readFileSync(TARGET, 'utf8')) : null;

if (check) {
    if (prev === null) {
        console.error('❌ ' + path.relative(REPO_ROOT, TARGET) + ' がありません。生成してください。');
        process.exit(1);
    }
    if (prev !== next) {
        console.error('❌ Metric Registry の seed が metrics.json と一致しません（drift 検出）。');
        console.error('   node tools/sync-metric-registry-sql.mjs を実行してください。');
        process.exit(1);
    }
    console.log(`✅ Metric Registry seed は metrics.json と一致しています（${registry.metrics.length} metric）`);
    process.exit(0);
}

const eol = prev !== null && fs.readFileSync(TARGET, 'utf8').includes('\r\n') ? '\r\n' : '\n';
fs.writeFileSync(TARGET, eol === '\r\n' ? next.replace(/\n/g, '\r\n') : next);
console.log(`✅ ${path.relative(REPO_ROOT, TARGET)} を生成しました（${registry.metrics.length} metric）`);
