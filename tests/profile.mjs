// Multi-source Aim Profile（Phase E prototype）の自動テスト。
//
//   node tests/profile.mjs
//
// 本番DB・ネットワーク・本番サイトに一切触れない。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'kovaak');

function makeContext() {
    const context = {
        console, Math, JSON, Date, Number, String, Boolean, Array, Object, isFinite, isNaN,
        Promise, Uint8Array, ArrayBuffer, TextEncoder, crypto, Error
    };
    context.globalThis = context;
    vm.createContext(context);
    return context;
}

const ctx = makeContext();
vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'importers', 'kovaak.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'profile', 'metric-registry.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'profile', 'aim-profile.js'), 'utf8'), ctx);

const kovaak = ctx.LC_IMPORTERS.kovaak;
const P = ctx.LC_PROFILE;

const readFixture = (name) => ({ name, text: fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8') });

const F = {
    s1: 'Tile Frenzy - Challenge - 2026.07.27-15.52.38 Stats.csv',   // DPI 800, sens 0.3150/31.5
    s2: 'Tile Frenzy - Challenge - 2026.08.11-09.30.00 Stats.csv',   // DPI 1600, sens 0.5/50
    s3: 'Tile Frenzy - Challenge - 2026.08.12-09.30.00 Stats.csv',   // DPI 800, sens 0.3150/31.5（s1と同条件）
    multiWeapon: 'Multi Weapon - Challenge - 2026.08.10-14.00.00 Stats.csv',
    legacy: 'Legacy Scenario - Challenge - 2021.03.14-09.10.11 Stats.csv', // DPIなし
    oddName: 'Some - Odd - Name - Challenge - 2026.08.01-10.00.00 Stats.csv' // 未知metric
};

// --------------------------------------------------------------- テスト基盤

let passed = 0;
const failures = [];
const pending = [];
const check = (name, fn) => pending.push({ name, fn });

function eq(actual, expected, label) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${label || ''} 期待 ${b} / 実際 ${a}`);
}
function ok(cond, label) { if (!cond) throw new Error(label || '条件を満たしません'); }

async function sessionsFrom(names) {
    const r = await kovaak.run(names.map(readFixture), { importedAt: '2026-09-04T00:00:00.000Z' });
    return r.sessions;
}

/** 別 source のセッションを合成する（Adapter が KovaaK しか無くても multi-source を検証するため）。 */
function asOtherSource(session, source, sourceType) {
    const clone = JSON.parse(JSON.stringify(session));
    clone.externalId = session.externalId + ':' + source;
    clone.provenance.source = source;
    clone.provenance.sourceType = sourceType;
    clone.metrics = clone.metrics.map((m) => ({
        ...m, metricKey: m.metricKey.replace(/^kovaak\./, source + '.')
    }));
    clone.weapons = (clone.weapons || []).map((w) => ({
        ...w, metrics: w.metrics.map((m) => ({ ...m, metricKey: m.metricKey.replace(/^kovaak\./, source + '.') }))
    }));
    return clone;
}

// ------------------------------------------------------- A. Session Profile

check('A: 1session — Session Profile に必要な項目が渡る', async () => {
    const sessions = await sessionsFrom([F.s1]);
    const sp = P.buildSessionProfile(sessions[0]);

    eq(sp.source, 'kovaak', 'source');
    eq(sp.sourceType, 'aim_trainer', 'source_type');
    eq(sp.scenario, 'Tile Frenzy', 'scenario');
    eq(sp.runTimestamp, '2026-07-27T15:52:38', 'run timestamp');
    eq(sp.fields.durationSec.value, 30, 'duration');
    eq(sp.fields.dpi.value, 800, 'DPI');
    eq(sp.fields.fov.value, '103.0', 'FOV');
    eq(sp.fields.score.value, 1042.5, 'score');
    eq(sp.fields.kills.value, 3, 'kills');
    eq(sp.fields.weapons.value.length, 1, 'weapon list');
});

check('A: Horiz Sens を確定値へ変換しない', async () => {
    const sessions = await sessionsFrom([F.s1]);
    const sp = P.buildSessionProfile(sessions[0]);

    ok(sp.fields.in_game_sens, 'in_game_sens が field として存在');
    eq(sp.fields.in_game_sens.kind, P.VALUE_KIND.UNRESOLVED, 'unresolved のまま');
    eq(sp.fields.in_game_sens.value, null, '値を確定していない');
    eq(sp.fields.in_game_sens.candidates.length, 2, '候補を保持');
    ok(sp.fields.cm360 && sp.fields.cm360.kind === P.VALUE_KIND.UNRESOLVED, 'cm360 も未確定');
});

check('A: accuracy を source が持たなければ derived にせず unresolved にする', async () => {
    const sessions = await sessionsFrom([F.s1]);
    const sp = P.buildSessionProfile(sessions[0]);
    eq(sp.fields.accuracy.kind, P.VALUE_KIND.UNRESOLVED, 'accuracy の扱い');
    ok(/Derived/.test(sp.fields.accuracy.note), '理由が書かれていること');
});

check('A: 複数weapon が Session Profile に全件渡る', async () => {
    const sessions = await sessionsFrom([F.multiWeapon]);
    const sp = P.buildSessionProfile(sessions[0]);
    eq(sp.fields.weapons.value.map((w) => w.weapon), ['rifle', 'pistol', 'smg'], '武器全件');
    ok(/Derived/.test(sp.fields.weapons.note), '集約がDerivedの責務であると明示');
});

check('A: DPIなし（旧形式）でも壊れず、未確定として扱う', async () => {
    const sessions = await sessionsFrom([F.legacy]);
    const sp = P.buildSessionProfile(sessions[0]);
    eq(sp.fields.dpi.value, null, 'DPIなし');
    ok(/unknown/.test(sp.fields.dpi.note), 'dpiSource が unknown と記録される');
});

// ------------------------------------------------------------ B. Evidence

check('B: Evidence に必須項目が揃う', async () => {
    const sessions = await sessionsFrom([F.s1]);
    const ev = P.buildEvidence(sessions);
    ok(ev.length > 0, 'evidence が生成される');

    const e = ev[0];
    for (const k of ['source', 'sourceType', 'sessionId', 'metricKey', 'value',
        'metricVersion', 'parserVersion', 'normalizationVersion', 'observedAt',
        'reliability', 'reliabilityStatus', 'recommendationEligible', 'recommendationWeight']) {
        ok(k in e, `${k} が存在すること`);
    }
    eq(e.source, 'kovaak');
    eq(e.sourceType, 'aim_trainer');
    // G-2 で kovaak.score / kills / accuracy だけが rated になった。
    // それ以外は引き続き unrated。source が同じというだけで信頼度を配らない。
    if (['kovaak.score', 'kovaak.kills', 'kovaak.accuracy'].indexOf(e.metricKey) >= 0) {
        eq(e.reliabilityStatus, 'rated', e.metricKey + ' は G-2 で rated');
        // 4軸の最小値（conservative_min_v1）。Registry には保存されない派生値。
        ok(typeof e.reliability === 'number', '4軸の min が実効値として解決される');
    } else {
        eq(e.reliabilityStatus, 'unrated', 'rated 化されていない metric は unrated のまま');
        eq(e.reliability, null, '汎用の既定値を与えない');
    }
});

check('B: Profile の数字を evidence から逆引きできる', async () => {
    const sessions = await sessionsFrom([F.s1]);
    const sp = P.buildSessionProfile(sessions[0]);
    const ev = P.buildEvidence(sessions);

    const traced = P.traceMetric(ev, 'kovaak.score');
    eq(traced.length, 1, 'score の evidence が1件');
    eq(traced[0].value, sp.fields.score.value, 'Profile の値と一致');
    eq(traced[0].sessionId, sessions[0].externalId, 'どのセッション由来か分かる');
    ok(traced[0].rawContentHash && traced[0].rawContentHash.length === 64, '元ファイルまで辿れる');
});

check('B: weapon レベルの evidence が武器名付きで残る', async () => {
    const sessions = await sessionsFrom([F.multiWeapon]);
    const ev = P.buildEvidence(sessions);
    const wev = ev.filter((e) => e.scope === 'weapon');
    ok(wev.length >= 6, 'weapon evidence が複数');
    eq([...new Set(wev.map((e) => e.weapon))].sort(), ['pistol', 'rifle', 'smg'], '武器名で区別');
});

check('B: reliability は Registry が定義したものだけ数値を持つ', async () => {
    const sessions = await sessionsFrom([F.s1]);
    const ev = P.buildEvidence(sessions);

    const RATED = ['kovaak.score', 'kovaak.kills', 'kovaak.accuracy'];
    ok(ev.every((e) => e.registered === true), 'Registry に登録はされている');
    ev.forEach((e) => {
        if (RATED.indexOf(e.metricKey) >= 0) {
            eq(e.reliabilityStatus, 'rated', e.metricKey + ' は G-2 で rated');
            ok(typeof e.reliability === 'number', e.metricKey + ' は数値を持つ');
        } else {
            eq(e.reliabilityStatus, 'unrated', e.metricKey + ' は unrated のまま');
            eq(e.reliability, null, e.metricKey + ' は数値を持たない');
        }
    });

    // rated でも Recommendation 投入は別判定。score だけが重みを持つ。
    ev.forEach((e) => {
        if (e.metricKey === 'kovaak.score') {
            ok(e.recommendationWeight > 0, 'score だけが推奨重みを持つ');
        } else {
            eq(e.recommendationWeight, 0, e.metricKey + ' の推奨重みは0');
        }
    });
});

check('B: rated でも recommendation_hold なら推奨に入らない', async () => {
    const sessions = await sessionsFrom([F.s1]);
    const ev = P.buildEvidence(sessions);

    ['kovaak.kills', 'kovaak.accuracy'].forEach((key) => {
        const hit = ev.filter((e) => e.metricKey === key);
        if (hit.length === 0) return;
        eq(hit[0].reliabilityStatus, 'rated', key + ' は rated');
        eq(hit[0].recommendationEligible, false, key + ' は Recommendation 投入を保留');
        eq(hit[0].recommendationWeight, 0, key + ' の重みは0');
    });
});

// -------------------------------------------------------- C. Multi-source

check('C: source混在でも Profile が成立する（KovaaK専用でない）', async () => {
    const base = (await sessionsFrom([F.s1]))[0];
    const mixed = [
        base,
        asOtherSource(base, 'aimlab', 'aim_trainer'),
        asOtherSource(base, 'valorant_range', 'in_game_range'),
        asOtherSource(base, 'manual', 'manual')
    ];
    const prof = P.buildAimProfile(mixed);

    eq(prof.inventory.sourceCount, 4, 'source 数');
    eq(prof.inventory.sourceTypeCount, 3, 'source_type 数');
    eq(prof.inventory.sources.sort(), ['aimlab', 'kovaak', 'manual', 'valorant_range'], 'source 一覧');
    ok(prof.inventory.metricCoverage.some((c) => c.metricKey.startsWith('aimlab.')),
        'KovaaK以外のmetricKeyも扱える');
});

check('C: 未登録 metric でも落ちず、unrated として扱う', async () => {
    const base = (await sessionsFrom([F.s1]))[0];
    const ev = P.buildEvidence([asOtherSource(base, 'brand_new_trainer', 'something_unknown')]);
    ok(ev.length > 0, 'evidence が作られる（情報としては保持する）');
    eq(ev[0].reliabilityStatus, 'unrated', '未登録は unrated');
    eq(ev[0].reliability, null, '推測で数値を与えない');
    eq(ev[0].registered, false, '未登録であることが分かる');
    eq(ev[0].recommendationWeight, 0, '推奨には使わない');
});

// ------------------------------- D. raw/normalized/derived/unresolved 表示

check('D: 各値の由来を区別して表示できる', async () => {
    const sessions = await sessionsFrom([F.s1]);
    const pv = P.buildProfilePreview(sessions);

    ok(pv.valueKindCounts.raw > 0, 'raw がある');
    ok(pv.valueKindCounts.normalized > 0, 'normalized がある');
    ok(pv.valueKindCounts.unresolved > 0, 'unresolved がある');
    eq(pv.valueKindCounts.derived, 0, 'Phase E では derived を作らない');
    eq(pv.isDevelopmentPreview, true, '開発用プレビューであると明示');
});

// ------------------------------------------------------------ E. 集約

check('E: 単純平均で Profile を作らない', async () => {
    const sessions = await sessionsFrom([F.s1, F.s2, F.s3]);
    const prof = P.buildAimProfile(sessions);

    eq(prof.aggregation.performed, false, '集約していない');
    const cov = prof.inventory.metricCoverage.find((c) => c.metricKey === 'kovaak.score');
    ok(cov, 'score の coverage がある');
    ok(!('mean' in cov) && !('average' in cov) && !('value' in cov),
        '平均値や代表値を持たないこと');
    eq(cov.observationCount, 3, '観測件数');
    eq(cov.sessionCount, 3, 'セッション数');
});

check('E: 複数session の在庫情報を出せる', async () => {
    const sessions = await sessionsFrom([F.s1, F.s2, F.s3, F.multiWeapon]);
    const prof = P.buildAimProfile(sessions);
    const inv = prof.inventory;

    eq(inv.sessionCount, 4, 'session count');
    eq(inv.sourceCount, 1, 'source count');
    eq(inv.scenarioCount, 2, 'scenario count（Tile Frenzy と Multi Weapon）');
    ok(inv.metricCoverage.length > 0, 'metric coverage');
    ok(inv.dataFreshness.earliest && inv.dataFreshness.latest, 'data freshness');
    ok(inv.dataFreshness.spanDays > 0, '期間');
    eq(inv.dataFreshness.tzKnownForAll, false, 'タイムゾーン不明を隠さない');
});

check('E: KovaaK のみでは感度水準を unknown とし、推測で数えない', async () => {
    const sessions = await sessionsFrom([F.s1, F.s2]);
    const lv = P.buildAimProfile(sessions).inventory.sensitivityLevels;

    eq(lv.status, 'unknown', 'in_game_sens が未確定なので unknown');
    eq(lv.count, null, '件数を出さない');
    eq(lv.unknownSessionCount, 2, '未検証セッション数');
    ok(/1水準と数えてはいけない/.test(lv.note), '誤認防止の注意書き');
});

check('E: unknown metric も coverage に現れる（捨てない）', async () => {
    const sessions = await sessionsFrom([F.oddName]);
    const prof = P.buildAimProfile(sessions);
    ok(prof.inventory.metricCoverage.length > 0, 'coverage がある');
    // 未知フィールドは Adapter 側で unknownFields に記録済み。Profile は既知metricのみ扱う
    ok(prof.evidence.every((e) => /^kovaak\./.test(e.metricKey)), '未知キーが勝手にmetric化されていない');
});

// ---------------------------------------------------------- F. Confidence

check('F: 感度水準が unknown なら条件被覆を算出せず、不足として説明する', async () => {
    const sessions = await sessionsFrom([F.s1, F.s2]);
    const c = P.buildAimProfile(sessions).confidence;

    eq(c.profileCompleteness.subscores.conditionCoverage, null, '算出しない（推測しない）');
    ok(c.profileCompleteness.unavailableSubscores.includes('conditionCoverage'), '算出不能と明示');
    ok(c.profileCompleteness.gaps.some((g) => /検証済みの感度水準/.test(g)), '不足内容が説明される');
});

check('F: Profile completeness と Recommendation confidence を分離する', async () => {
    const sessions = await sessionsFrom([F.s1]);
    const c = P.buildAimProfile(sessions).confidence;
    eq(c.kind, 'profile_completeness_and_evidence_quality', '種別');
    ok(/別概念/.test(c.note), '別概念であるという注記');
    ok(/表示してはいけない/.test(c.displayGuidance), 'ユーザー表示への注意');
    eq(c.recommendationConfidence.status, 'not_computed', 'Recommendation側は算出しない');
    ok(c.algorithmVersion, 'algorithmVersion を持つ');
});

check('F: データが少なければ gaps に列挙される', async () => {
    const one = await sessionsFrom([F.s1]);
    const c = P.buildAimProfile(one).confidence;
    ok(c.profileCompleteness.gaps.some((g) => /セッションが/.test(g)), 'セッション不足を説明');
    ok(c.profileCompleteness.gaps.length > 0, '不足内容が列挙される');
});

check('F: source_type が1種類なら gaps に出る', async () => {
    const base = (await sessionsFrom([F.s1]))[0];
    const only = P.buildAimProfile([base, base]);
    const mixed = P.buildAimProfile([base, asOtherSource(base, 'valorant_range', 'in_game_range')]);

    ok(only.confidence.profileCompleteness.gaps.some((g) => /データ元が1種類/.test(g)), '単一なら指摘');
    ok(!mixed.confidence.profileCompleteness.gaps.some((g) => /データ元が1種類/.test(g)), '混在なら出ない');
});

check('F: evidence quality が「推奨に使えるか」を分けて示す', async () => {
    const sessions = await sessionsFrom([F.s1]);
    const q = P.buildAimProfile(sessions).confidence.evidenceQuality;

    ok(q.evidenceCount > 0, '情報としては存在する');
    // G-2 で score / kills / accuracy が rated 化された。
    // rated であることと推奨に使えることは別判定なので、両方を確認する。
    ok(q.ratedCount > 0, 'rated が存在する（G-2 で3件が rated 化された）');
    ok(q.ratedCount < q.evidenceCount, 'すべてが rated になったわけではない');
    eq(q.usableForRecommendation, true, 'score が eligible なので推奨に使える');
});

// ---------------------------------------------------------- 禁止事項

check('禁止事項: Profile は保存しないと明示する', async () => {
    const sessions = await sessionsFrom([F.s1]);
    const pv = P.buildProfilePreview(sessions);
    eq(pv.persistence.willSave, false);
    ok(/禁止/.test(pv.persistence.reason));
});

check('禁止事項: 推奨感度を算出しない', async () => {
    const sessions = await sessionsFrom([F.s1, F.s2, F.s3]);
    const prof = P.buildAimProfile(sessions);

    // 「推奨」という語が注記に出るのは構わない。出力フィールドとして
    // 推奨値が存在しないことを確認する。
    const forbiddenKeys = [
        'recommendedSens', 'recommended_sens', 'rangeLow', 'range_high',
        'optimalSens', 'suggestedSens', 'cm360'
    ];
    const collectKeys = (o, acc = new Set()) => {
        if (o && typeof o === 'object') {
            for (const k of Object.keys(o)) { acc.add(k); collectKeys(o[k], acc); }
        }
        return acc;
    };
    const keys = collectKeys(prof);
    for (const k of forbiddenKeys) {
        ok(!keys.has(k), `${k} という出力フィールドが存在しないこと`);
    }

    // confidence は evidence completeness であって推奨の信頼度ではない
    eq(prof.confidence.kind, 'profile_completeness_and_evidence_quality', 'confidence の種別');
});

// -------------------------------------------------------------- 同一Raw重複

check('同一Raw重複: 同じファイルを2回渡しても1セッション', async () => {
    const f = readFixture(F.s1);
    const r = await kovaak.run([f, f], { importedAt: 'T' });
    const prof = P.buildAimProfile(r.sessions);
    eq(prof.inventory.sessionCount, 1, '重複は畳まれている');
});

// -------------------------------------------------------------- 結果出力

for (const { name, fn } of pending) {
    try { await fn(); passed++; }
    catch (e) { failures.push({ name, message: e.message }); }
}

const total = passed + failures.length;
if (failures.length === 0) {
    console.log(`✅ Profile テスト成功: ${passed}/${total} 件`);
    process.exit(0);
}
console.error(`❌ Profile テスト失敗: ${failures.length}/${total} 件`);
for (const f of failures) console.error(`   - ${f.name}\n     ${f.message}`);
process.exit(1);
