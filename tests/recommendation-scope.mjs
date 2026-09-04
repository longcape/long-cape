// Recommendation の意味（scope）を守るテスト。
//
//   node tests/recommendation-scope.mjs
//
// 守りたいこと:
//   * KovaaK evidence からの推奨は **Aim テスト上の推奨**であり、
//     ゲーム内で最適だと実証したものではない
//   * `kovaak.score` を「ゲーム内の強さ」へ変換しない
//   * Profile の3層のうち、いま作ってよいのは 1（Mechanical Aim）だけ
//   * 将来 mechanical_optimum / game_optimum / transfer_gap /
//     integrated_recommendation を足せる余地があること
//   * ただし **架空の game performance 値や transfer 係数は作らない**

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PAGES = ['import.html', 'profile.html'];

function load() {
    const ctx = {
        console, Math, JSON, Date, Number, String, Boolean, Array, Object, isFinite, isNaN,
        Promise, Uint8Array, ArrayBuffer, TextEncoder, crypto, Error
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of ['importers/kovaak.js', 'profile/metric-registry.js', 'profile/algorithm-config.js',
        'profile/aim-profile.js', 'profile/re-estimation.js', 'profile/recommendation-scope.js',
        'ui/i18n.js', 'ui/ui-logic.js', 'ui/samples.js', 'ui/storage.js']) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    }
    return ctx;
}

const ctx = load();
const SC = ctx.LC_REC_SCOPE, U = ctx.LC_UI, P = ctx.LC_PROFILE,
    R = ctx.LC_REESTIMATE, S = ctx.LC_SAMPLES, I = ctx.LC_I18N, M = ctx.LC_METRICS;

let passed = 0;
const failures = [];
const pending = [];
const check = (name, fn) => pending.push({ name, fn });
function eq(a, b, l) {
    const x = JSON.stringify(a), y = JSON.stringify(b);
    if (x !== y) throw new Error(`${l || ''} 期待 ${y} / 実際 ${x}`);
}
function ok(c, l) { if (!c) throw new Error(l || '条件を満たしません'); }

const sessions = S.enough();
const evidence = P.buildEvidence(sessions);
const reest = R.reestimate({
    sessions, evidence, levelResolver: P.verifiedSensitivityLevel, now: '2026-09-05T00:00:00'
});
const view = U.buildRecommendationView(reest, { blocked: [] }, { evidence });

// ==================================================== scope が必ず付く

check('推奨には必ず scope が付く（出せるときも出せないときも）', async () => {
    eq(view.status, 'available', '推奨が出る');
    ok(view.scope, '推奨ありに scope がある');

    const withheldDpi = U.buildRecommendationView(reest,
        { blocked: ['recommendation'] }, { evidence });
    ok(withheldDpi.scope, 'DPI 未確認でも scope がある');

    const withheldEv = U.buildRecommendationView(
        R.reestimate({ sessions: S.notEnough(), evidence: P.buildEvidence(S.notEnough()),
            levelResolver: P.verifiedSensitivityLevel, now: '2026-09-05T00:00:00' }),
        { blocked: [] }, { evidence: P.buildEvidence(S.notEnough()) });
    ok(withheldEv.scope, '証拠不足でも scope がある');
});

check('scope は「Aim テスト上の推奨」と言い切る', async () => {
    eq(view.scope.appliesTo, 'aim_test', 'ゲーム内ではない');
    eq(view.scope.basedOn, 'mechanical_aim_performance', '機械的なエイム性能にもとづく');
    eq(view.scope.layer, SC.LAYER.MECHANICAL, '第1層');
    eq(view.scope.provenInGame, false, '**ゲーム内で実証したとは言わない**');
});

check('禁止事項が contract に書かれている', async () => {
    ['present_as_proven_in_game_optimum', 'convert_to_game_skill_or_rank',
     'estimate_match_performance', 'invent_transfer_coefficient'].forEach((p) => {
        ok(view.scope.prohibited.indexOf(p) >= 0, p + ' が禁止として明記されている');
    });
});

// ==================================================== 3層の分離

check('いま作ってよいのは第1層だけ', async () => {
    const layers = view.scope.layers.layers;
    eq(layers.length, 3, '3層ある');
    eq(layers[0].id, 'mechanical_aim', '1層目');
    eq(layers[0].available, true, '1層目は作れる');
    eq(layers[1].id, 'game_specific_performance', '2層目');
    eq(layers[1].available, false, '**2層目は作らない**');
    eq(layers[1].reason, 'no_in_game_evidence', '理由が付く');
    eq(layers[2].id, 'integrated', '3層目');
    eq(layers[2].available, false, '**3層目は作らない**');
    ok(layers[2].reason, '理由が付く');
});

check('ゲーム内 evidence が現れたら2層目が使えるようになる（構造の確認）', async () => {
    // 実データではなく、source_type だけを持つ最小の evidence で構造を確かめる。
    // **値を作っているわけではない。**
    const withGame = evidence.concat([{ metricKey: 'x', sourceType: 'in_game_match' }]);
    const layers = SC.assessLayers(withGame).layers;
    eq(layers[1].available, true, '2層目が使えるようになる');
    eq(layers[1].evidenceCount, 1, '件数が数えられる');
    // それでも3層目は統合方法が未確定なので作らない
    eq(layers[2].available, false, '3層目はまだ作らない');
    eq(layers[2].reason, 'integration_model_not_defined', '理由が変わる');
});

check('KovaaK と手入力は第1層に分類される', async () => {
    eq(SC.layerOfSourceType('aim_trainer'), 'mechanical_aim', 'Aim トレーナー');
    eq(SC.layerOfSourceType('manual'), 'mechanical_aim', '手入力');
    eq(SC.layerOfSourceType('in_game_match'), 'game_specific_performance', '実ゲーム');
    eq(SC.layerOfSourceType('unknown_source'), null, '未知は分類しない');
});

// ==================================================== 将来の拡張点

check('将来の項目を足せる余地がある', async () => {
    const ext = view.scope.layers.extensionPoints;
    ['mechanical_optimum', 'game_optimum', 'transfer_gap', 'integrated_recommendation']
        .forEach((k) => {
            ok(ext[k], k + ' の場所がある');
            eq(ext[k].available, false, k + ' はまだ値を持たない');
            ok(ext[k].reason, k + ' に理由が付く');
        });
});

check('架空の値や係数を作っていない', async () => {
    const ext = view.scope.layers.extensionPoints;
    Object.keys(ext).forEach((k) => {
        ok(!('value' in ext[k]), k + ' に値が無い');
        ok(!('coefficient' in ext[k]), k + ' に係数が無い');
    });
});

// ==================================================== 禁止された値が出ていない

check('推奨の出力にゲーム内の強さを表す値が混ざっていない', async () => {
    const a = SC.auditRecommendation(view);
    eq(a.clean, true, '禁止キー: ' + a.offendingKeys.join(', '));

    const b = SC.auditRecommendation(reest);
    eq(b.clean, true, 'エンジン出力にも無い: ' + b.offendingKeys.join(', '));

    const prof = U.buildProfileView(P.buildAimProfile(sessions), sessions, reest);
    const c = SC.auditRecommendation(prof);
    eq(c.clean, true, 'Profile 出力にも無い: ' + c.offendingKeys.join(', '));
});

check('Registry にゲーム内成績の metric が存在しない', async () => {
    // ドット・アンダースコア区切りの語ごとに完全一致で見る。
    // 部分一致だと reloads が elo に当たってしまう。
    const BAD_WORDS = ['rank', 'mmr', 'elo', 'match', 'kd', 'kda', 'skill',
                       'winrate', 'placement'];
    const forbidden = M.all.filter((m) =>
        m.metric_key.split(/[._]/).some((w) => BAD_WORDS.includes(w.toLowerCase())));
    eq(forbidden.map((m) => m.metric_key), [], 'そういう metric を登録していない');
    // source は aim_trainer か manual だけ
    const sources = [...new Set(M.all.map((m) => m.source))].sort();
    eq(sources, ['kovaak', 'manual'], '実ゲーム由来の source が無い');
});

// ==================================================== 説明文

check('注意書きが3言語すべてにある', async () => {
    ['recScopeTitle', 'recScopeDisclaimer', 'recScopeLayers', 'recScopeNotProven'].forEach((k) => {
        I.LANGS.forEach((l) => {
            const s = I.dict[l][k];
            ok(s && s.length > 0, `${l}.${k} がある`);
        });
    });
});

check('注意書きに必要な要素が入っている', async () => {
    const checks = {
        ja: [/Aimテスト/, /武器/, /移動/, /交戦距離/, /判断/, /異なる場合があります/],
        en: [/aim test/i, /weapon/i, /movement/i, /engagement distance/i, /decision/i, /may differ/i],
        ko: [/에임 테스트/, /무기/, /이동/, /교전 거리/, /판단/, /달라질 수 있습니다/]
    };
    Object.keys(checks).forEach((l) => {
        const s = I.dict[l].recScopeDisclaimer;
        checks[l].forEach((re) => ok(re.test(s), `${l} の注意書きに ${re} が無い: ${s}`));
    });
});

check('画面が scope の注意書きを出している', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'profile.html'), 'utf8');
    ok(/scopeNote\(rec\)/.test(src), '推奨の描画で scopeNote を呼んでいる');
    ok(/recScopeDisclaimer/.test(src), '注意書きの鍵を使っている');
    // 推奨あり・推奨なしの両方で出す
    const calls = (src.match(/\+ scopeNote\(rec\)/g) || []).length;
    ok(calls >= 2, '推奨ありと推奨なしの両方で出している（' + calls + '箇所）');
});

// ==================================================== 表現の禁止

check('ゲーム内最適を実証したと読める表現を使っていない', async () => {
    const offenders = [];
    const BAD = {
        ja: [/ゲーム内(で)?最適(だと)?(実証|証明)/, /VALORANT.*最適感度/, /ランク.*予測/],
        en: [/proven .*optimal in[- ]game/i, /predicted rank/i, /your rank will/i],
        ko: [/게임 내.*최적.*(실증|증명)/, /랭크.*예측/]
    };
    // 「〜ではありません」「not」等の否定を伴う文は、むしろ正しい表現なので除く。
    const DENIAL = {
        ja: /(ではありません|ではない|していません|しません|ものではありません)/,
        en: /(not|never|no)/i,
        ko: /(아닙니다|않습니다|없습니다)/
    };
    I.LANGS.forEach((l) => {
        Object.keys(I.dict[l]).forEach((k) => {
            const text = I.dict[l][k];
            if (DENIAL[l] && DENIAL[l].test(text)) return;   // 否定文は対象外
            (BAD[l] || []).forEach((re) => {
                if (re.test(text)) offenders.push();
            });
        });
    });
    eq(offenders, [], '該当する文言');
});

check('画面のどこにもゲーム内成績への変換が無い', async () => {
    const offenders = [];
    PAGES.forEach((p) => {
        const src = fs.readFileSync(path.join(ROOT, p), 'utf8');
        SC.FORBIDDEN_KEYS.forEach((k) => {
            if (new RegExp('\\b' + k + '\\b').test(src)) offenders.push(`${p}: ${k}`);
        });
    });
    eq(offenders, [], '禁止された概念が画面に無い');
});

// ==================================================== 実行

for (const { name, fn } of pending) {
    try { await fn(); passed++; }
    catch (e) { failures.push({ name, message: e.message }); }
}

const total = passed + failures.length;
if (failures.length === 0) {
    console.log(`✅ Recommendation scope テスト成功: ${passed}/${total} 件`);
    process.exit(0);
}
console.error(`❌ Recommendation scope テスト失敗: ${failures.length}/${total} 件`);
for (const f of failures) console.error(`   - ${f.name}\n     ${f.message}`);
process.exit(1);
