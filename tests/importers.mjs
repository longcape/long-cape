// KovaaK Adapter（Phase D read-only prototype）の自動テスト。
//
//   node tests/importers.mjs
//
// Adapter はブラウザで <script> 読み込みする前提の IIFE なので、
// 既存の tests/lib/sandbox.mjs と同じ考え方で vm 上に評価して取り出す。
//
// このテストは本番DB・ネットワーク・本番サイトに一切触れない。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'kovaak');

// ------------------------------------------------------------ 読み込み

function loadAdapter() {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'importers', 'kovaak.js'), 'utf8');
    const context = {
        console, Math, JSON, Date, Number, String, Boolean, Array, Object, isFinite, isNaN,
        Promise, Uint8Array, ArrayBuffer, TextEncoder, crypto, Error
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(src, context, { filename: 'importers/kovaak.js' });
    const a = context.LC_IMPORTERS && context.LC_IMPORTERS.kovaak;
    if (!a) throw new Error('LC_IMPORTERS.kovaak を取得できませんでした');
    return a;
}

function readFixture(name) {
    return { name, text: fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8') };
}

const F = {
    current: 'Tile Frenzy - Challenge - 2026.07.27-15.52.38 Stats.csv',
    legacy: 'Legacy Scenario - Challenge - 2021.03.14-09.10.11 Stats.csv',
    oddName: 'Some - Odd - Name - Challenge - 2026.08.01-10.00.00 Stats.csv',
    broken: 'Broken Rows - Challenge - 2026.08.02-11.00.00 Stats.csv',
    noScore: 'No Score - Challenge - 2026.08.03-12.00.00 Stats.csv',
    notKovaak: 'not-a-kovaak-file.csv',
    multiWeapon: 'Multi Weapon - Challenge - 2026.08.10-14.00.00 Stats.csv',
    sameSens: 'Tile Frenzy - Challenge - 2026.08.11-09.30.00 Stats.csv',
    otherSens: 'Tile Frenzy - Challenge - 2026.08.12-09.30.00 Stats.csv'
};

// ------------------------------------------------------------ テスト基盤

let passed = 0;
const failures = [];

const pending = [];
function check(name, fn) {
    pending.push({ name, fn });
}
async function runAll() {
    for (const { name, fn } of pending) {
        try {
            await fn();
            passed++;
        } catch (e) {
            failures.push({ name, message: e.message });
        }
    }
}

function eq(actual, expected, label) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${label || ''} 期待 ${b} / 実際 ${a}`);
}

function ok(cond, label) {
    if (!cond) throw new Error(label || '条件を満たしません');
}

const app = loadAdapter();
const metricOf = (s, key) => (s.metrics.find((m) => m.metricKey === key) || {}).value;

// ------------------------------------------------------- 1. ファイル名解析

check('ファイル名: 通常のシナリオ名', async () => {
    const r = app.parseFileName(F.current);
    ok(r.ok, 'パースできること');
    eq(r.scenario, 'Tile Frenzy', 'シナリオ名');
    eq(r.localTimestamp, '2026-07-27T15:52:38', '日時');
    eq(r.tzKnown, false, 'タイムゾーンは不明として扱う');
});

check('ファイル名: シナリオ名に " - " を含んでも右から分割できる', async () => {
    const r = app.parseFileName(F.oddName);
    ok(r.ok, 'パースできること');
    eq(r.scenario, 'Some - Odd - Name', 'シナリオ名が途中で切れないこと');
});

check('ファイル名: KovaaK以外は拒否', async () => {
    eq(app.parseFileName(F.notKovaak).ok, false);
    eq(app.parseFileName('foo.txt').ok, false);
});

// ------------------------------------------------------- 2. format detection

check('検出: 現行形式を current と判定', async () => {
    const d = app.detectFormat(readFixture(F.current));
    eq(d.format, app.FORMATS.CURRENT, 'format');
    ok(d.signals.includes('kill_header_has_accuracy'), 'Accuracy列を検出');
    ok(d.signals.includes('footer_has_dpi'), 'DPIフッターを検出');
    ok(d.signals.includes('timestamp_elapsed_seconds'), '経過秒を検出');
});

check('検出: 旧形式を legacy と判定', async () => {
    const d = app.detectFormat(readFixture(F.legacy));
    eq(d.format, app.FORMATS.LEGACY, 'format');
    ok(d.signals.includes('legacy_markers_present'), 'legacyマーカーを検出');
    ok(d.signals.includes('timestamp_clock'), '時刻表記を検出');
});

check('検出: KovaaK以外は unsupported_format（推測解析しない）', async () => {
    const d = app.detectFormat(readFixture(F.notKovaak));
    eq(d.format, app.FORMATS.UNSUPPORTED, 'format');
    eq(d.confidence, 0, 'confidence');
});

check('検出: 空ファイルは unsupported_format', async () => {
    const d = app.detectFormat({ name: F.current, text: '' });
    eq(d.format, app.FORMATS.UNSUPPORTED);
});

// ------------------------------------------------------------- 3. 改行コード

check('改行コード: CRLF と LF で結果が変わらない', async () => {
    const crlf = readFixture(F.current);
    const lf = { name: crlf.name, text: crlf.text.replace(/\r\n/g, '\n') };
    const a = await app.run([crlf], { importedAt: 'T' });
    const b = await app.run([lf], { importedAt: 'T' });
    eq(a.sessions[0].metrics, b.sessions[0].metrics, 'metrics が一致');
    eq(a.sessions[0].context, b.sessions[0].context, 'context が一致');
});

check('BOM付きファイルを解析できる', async () => {
    const r = await app.run([readFixture(F.oddName)], { importedAt: 'T' });
    eq(r.stats.sessionsParsed, 1, 'BOMがあっても1件解析される');
});

// -------------------------------------------------------- 4. normalization

check('正規化: 現行形式の session 指標', async () => {
    const r = await app.run([readFixture(F.current)], { importedAt: 'T' });
    const s = r.sessions[0];
    eq(metricOf(s, 'kovaak.score'), 1042.5, 'score');
    eq(metricOf(s, 'kovaak.kills'), 3, 'kills');
    eq(metricOf(s, 'kovaak.fight_time'), 30, 'fight_time');
    eq(metricOf(s, 'kovaak.hit_count'), 7, 'hit_count');
    ok(!s.metrics.some((m) => m.metricKey.startsWith('kovaak.weapon.')),
        '武器由来の指標が session レベルに混ざっていないこと');
});

check('正規化: DPI をファイルから取得し dpiSource=file にする', async () => {
    const r = await app.run([readFixture(F.current)], { importedAt: 'T' });
    eq(r.sessions[0].context.dpi, 800, 'DPI');
    eq(r.sessions[0].context.dpiSource, 'file', 'DPIの出どころ');
});

check('正規化: 旧形式は DPI が無く dpiSource=unknown', async () => {
    const r = await app.run([readFixture(F.legacy)], { importedAt: 'T' });
    eq(r.sessions[0].context.dpi, null, 'DPI');
    eq(r.sessions[0].context.dpiSource, 'unknown', 'DPIの出どころ');
});

check('正規化: 適応型シナリオの値を context に取り込む', async () => {
    const r = await app.run([readFixture(F.oddName)], { importedAt: 'T' });
    const c = r.sessions[0].context;
    eq(c.avgTargetScale, '1.2', 'Avg Target Scale');
    eq(c.avgTimeDilation, '0.9', 'Avg Time Dilation');
});

// ------------------------------- 5. 禁止事項（Horiz Sens / cm360 / 保存）

check('禁止事項: Horiz Sens を正規化せず candidates として残す', async () => {
    const r = await app.run([readFixture(F.current)], { importedAt: 'T' });
    const s = r.sessions[0];

    ok(!s.metrics.some((m) => /horiz|sens/.test(m.metricKey)),
        'Horiz Sens が metric として正規化されていないこと');
    ok(s.context.in_game_sens === undefined && s.context.inGameSens === undefined,
        'in_game_sens が確定されていないこと');

    const u = s.unresolved.find((x) => x.field === 'in_game_sens');
    ok(u, 'in_game_sens が unresolved に記録されていること');
    eq(u.reason, 'horiz_sens_multiple_sources', '複数ソースであることを記録');
    eq(u.candidates.length, 2, '候補が2つ（武器行とフッター）');
    eq(u.candidates.map((c) => c.origin), ['weapon_row', 'footer'], '候補の出どころ');
    // 約100倍差が保持されていること（どちらかに寄せていない）
    ok(Math.abs(u.candidates[1].value / u.candidates[0].value - 100) < 1,
        '2値の比が約100倍のまま保持されていること');
});

check('禁止事項: cm/360 を自動確定しない', async () => {
    const r = await app.run([readFixture(F.current)], { importedAt: 'T' });
    const s = r.sessions[0];
    ok(s.context.cm360 === undefined, 'cm360 が算出されていないこと');
    ok(s.unresolved.some((u) => u.field === 'cm360'), 'cm360 が unresolved に記録されていること');
});

check('禁止事項: Derived 指標を算出しない（accuracy 等）', async () => {
    const r = await app.run([readFixture(F.current)], { importedAt: 'T' });
    const keys = r.sessions[0].metrics.map((m) => m.metricKey);
    ok(!keys.some((k) => k.startsWith('lc.')), 'lc.* の Derived 指標が無いこと');
    ok(!keys.includes('kovaak.accuracy'), 'session レベルの accuracy を作っていないこと');
});

check('禁止事項: プレビューが「保存しない」と明示する', async () => {
    const r = await app.run([readFixture(F.current)], { importedAt: 'T' });
    const p = app.buildPreview(r);
    eq(p.persistence.willSave, false, 'willSave');
    ok(/禁止/.test(p.persistence.reason), '理由が記録されていること');
});

check('禁止事項: adapter が production-ready を名乗らない', async () => {
    eq(app.productionReady, false);
    ok(typeof app.notProductionReadyReason === 'string' && app.notProductionReadyReason.length > 0);
});

// ---------------------------------------------------------- 6. provenance

check('provenance: 原本を保存しなくても来歴を残す', async () => {
    const r = await app.run([readFixture(F.current)], { importedAt: '2026-09-04T00:00:00.000Z' });
    const p = r.sessions[0].provenance;
    for (const k of ['source', 'sourceType', 'sourceIdentifier', 'rawContentHash',
        'parserVersion', 'normalizationVersion', 'importedAt', 'consentId']) {
        ok(k in p, `${k} が存在すること`);
    }
    eq(p.source, 'kovaak');
    eq(p.sourceType, 'aim_trainer');
    eq(p.importedAt, '2026-09-04T00:00:00.000Z');
    eq(p.consentId, null, 'プロトタイプでは同意が無い');
    eq(p.rawStored, false, '原本を保存しない');
    eq(p.rawContentHashAlgo, 'sha-256', 'SHA-256 であること');
    ok(/^[0-9a-f]{64}$/.test(p.rawContentHash), 'SHA-256 の16進64文字であること');
    eq(p.logicalFingerprint, null, 'logical_fingerprint は未実装');
    eq(p.logicalFingerprintStatus, 'not_implemented_phase_d', '未実装であると明示');
});

check('provenance: parserVersion と normalizationVersion が分離されている', async () => {
    ok('parserVersion' in app && 'normalizationVersion' in app);
    const r = await app.run([readFixture(F.current)], { importedAt: 'T' });
    const p = r.sessions[0].provenance;
    ok('parserVersion' in p && 'normalizationVersion' in p, '両方が記録されること');
});

// ------------------------------------------------------- 7. 重複検知

check('重複検知: 同一内容のファイルはバッチ内で1件に畳む', async () => {
    const f = readFixture(F.current);
    const r = await app.run([f, f], { importedAt: 'T' });
    eq(r.stats.sessionsParsed, 1, '解析されたセッション数');
    eq(r.stats.duplicatesInBatch, 1, '重複件数');
    ok(r.warnings.some((w) => w.code === 'duplicate_in_batch'), '重複を警告すること');
});

check('重複検知: externalId が内容から決定論的に決まる', async () => {
    const f = readFixture(F.current);
    const a = (await app.run([f], { importedAt: 'A' })).sessions[0].externalId;
    const b = (await app.run([f], { importedAt: 'B' })).sessions[0].externalId;
    eq(a, b, '取込時刻が違っても同じIDになること');

    const other = (await app.run([readFixture(F.legacy)], { importedAt: 'A' })).sessions[0].externalId;
    ok(a !== other, '別ファイルは別IDになること');
});

// ------------------------------------------------- 8. 未知フィールド / 異常系

check('未知フィールド: 捨てずに記録し、取込は継続する', async () => {
    const r = await app.run([readFixture(F.oddName)], { importedAt: 'T' });
    eq(r.stats.sessionsParsed, 1, '取込は継続する');
    const keys = r.unknownFields.map((u) => u.key);
    ok(keys.includes('Fancy New Column'), '未知の武器行列を記録');
    ok(keys.includes('brand new footer key'), '未知のフッターキーを記録');
    ok(!r.sessions[0].metrics.some((m) => /fancy|brand/i.test(m.metricKey)),
        '未知フィールドを勝手に指標化しないこと');
});

check('異常系: 壊れた行は警告して残りを処理する', async () => {
    const r = await app.run([readFixture(F.broken)], { importedAt: 'T' });
    eq(r.stats.sessionsParsed, 1, '1件は解析される');
    ok(r.warnings.some((w) => w.code === 'kill_row_column_mismatch'), '列数不一致を警告');
    ok(r.warnings.some((w) => w.code === 'kill_count_mismatch'), 'Kills宣言値との不一致を警告');
});

check('異常系: Score が無いファイルは errors で弾く', async () => {
    const r = await app.run([readFixture(F.noScore)], { importedAt: 'T' });
    eq(r.stats.sessionsParsed, 0, '取り込まれないこと');
    eq(r.stats.filesRejected, 1, '拒否件数');
    ok(r.warnings.some((w) => w.code === 'score_missing'), 'Score欠落を報告');
});

check('異常系: 未対応形式は解析せず停止する', async () => {
    const r = await app.run([readFixture(F.notKovaak)], { importedAt: 'T' });
    eq(r.stats.sessionsParsed, 0);
    eq(r.stats.filesRejected, 1);
    ok(r.warnings.some((w) => w.code === 'unsupported_format'), 'unsupported_format を報告');
    ok(r.rejected[0].reasons.length > 0, '理由が残ること');
});

check('異常系: 例外を投げない（壊れた入力を投入しても）', async () => {
    const junk = [
        { name: F.current, text: 'Kill #,\n\n\n' },
        { name: 'x Stats.csv', text: 'Kill #,Timestamp\n1,abc\n' },
        { name: F.current, text: 'Kill #,Timestamp,Accuracy\n1,1.0,50\n\nDPI:,x\nScore:,y\n' },
        { name: '', text: '' }
    ];
    const r = await app.run(junk, { importedAt: 'T' }); // ここで throw したらテスト失敗
    ok(typeof r.stats.filesReceived === 'number', '結果が返ること');
    eq(r.stats.filesReceived, 4);
});

// ------------------------------------------------- 8.5 複数Weapon / ハッシュ

check('複数Weapon: 全件を weapon レベルで保持し、Adapterが代表を選ばない', async () => {
    const r = await app.run([readFixture(F.multiWeapon)], { importedAt: 'T' });
    const s = r.sessions[0];

    eq(s.weapons.length, 3, '武器3件すべてを保持');
    eq(s.weapons.map((w) => w.weapon), ['rifle', 'pistol', 'smg'], '武器名と順序');

    // 代表選択も合算もしていないこと
    ok(!s.metrics.some((m) => m.metricKey.startsWith('kovaak.weapon.')),
        'weapon 指標が session レベルへ昇格していないこと');
    const rifle = s.weapons.find((w) => w.weapon === 'rifle');
    const smg = s.weapons.find((w) => w.weapon === 'smg');
    eq((rifle.metrics.find((m) => m.metricKey === 'kovaak.weapon.shots') || {}).value, 6, 'rifle shots');
    eq((smg.metrics.find((m) => m.metricKey === 'kovaak.weapon.hits') || {}).value, 1, 'smg hits');

    // 合算値（6+4+2=12）がどこにも作られていないこと
    const all = JSON.stringify(s);
    ok(!/12/.test(JSON.stringify(s.metrics)), 'shots の合算値が session 指標に無いこと');

    ok(r.warnings.some((w) => w.code === 'multiple_weapons_present'), '複数武器を通知');
});

check('複数Weapon: プレビューで武器を確認できる', async () => {
    const r = await app.run([readFixture(F.multiWeapon)], { importedAt: 'T' });
    const p = app.buildPreview(r);
    ok(p.weapons, 'プレビューに weapons がある');
    eq(p.weapons.distinctWeapons.sort(), ['pistol', 'rifle', 'smg'], '武器一覧');
    eq(p.weapons.maxPerSession, 3, '1セッションあたり最大武器数');
});

check('ハッシュ: raw_content_hash は SHA-256 で、内容が1バイト違えば変わる', async () => {
    const f = readFixture(F.current);
    const a = (await app.run([f], { importedAt: 'T' })).sessions[0].provenance;
    const g = { name: f.name, text: f.text.replace('Score:,1042.500000', 'Score:,1042.500001') };
    const b = (await app.run([g], { importedAt: 'T' })).sessions[0].provenance;

    ok(/^[0-9a-f]{64}$/.test(a.rawContentHash), 'SHA-256 形式');
    ok(a.rawContentHash !== b.rawContentHash, '内容が違えばハッシュが変わる');
    eq(a.rawContentHashAlgo, 'sha-256');
});

check('ハッシュ: raw_content_hash と logical_fingerprint を混同しない', async () => {
    const f = readFixture(F.current);
    const lf = { name: f.name, text: f.text.replace(/\r\n/g, '\n') };
    const a = (await app.run([f], { importedAt: 'T' })).sessions[0].provenance;
    const b = (await app.run([lf], { importedAt: 'T' })).sessions[0].provenance;

    // 改行コードだけ違う = バイト列が違う → raw_content_hash は別で正しい
    ok(a.rawContentHash !== b.rawContentHash,
        '改行が違えば raw_content_hash は別になる（バイト列ベースなので正しい挙動）');
    // 同一runの検知は logical_fingerprint の責務であり、まだ実装していない
    eq(a.logicalFingerprint, null);
    eq(a.logicalFingerprintStatus, 'not_implemented_phase_d');
});

// ------------------------------------------------------------- 9. preview

check('プレビュー: バッチ全体の要約を返す', async () => {
    const r = await app.run([
        readFixture(F.current), readFixture(F.legacy),
        readFixture(F.noScore), readFixture(F.notKovaak)
    ], { importedAt: 'T' });
    const p = app.buildPreview(r);

    eq(p.summary.filesReceived, 4, '受領数');
    eq(p.summary.sessionsParsed, 2, '解析成功数（current + legacy）');
    eq(p.summary.filesRejected, 2, '拒否数（Score欠落 + 非対応）');
    ok(p.summary.errorCount >= 2, 'エラー件数');
    eq(p.formats[app.FORMATS.CURRENT], 1, 'current の件数');
    eq(p.formats[app.FORMATS.LEGACY], 1, 'legacy の件数');
    eq(p.dpi.fromFile, 1, 'DPIがファイルから取れた件数');
    eq(p.dpi.needsUserInput, 1, 'DPI入力が必要な件数');
    eq(p.period.tzKnown, false, 'タイムゾーンは不明のまま');
    ok(p.unresolvedFields.in_game_sens >= 1, 'in_game_sens が未確定として集計される');
});

// ------------------------------------------------------------- 結果出力

await runAll();

const total = passed + failures.length;
if (failures.length === 0) {
    console.log(`✅ Importer テスト成功: ${passed}/${total} 件`);
    process.exit(0);
}
console.error(`❌ Importer テスト失敗: ${failures.length}/${total} 件`);
for (const f of failures) console.error(`   - ${f.name}\n     ${f.message}`);
process.exit(1);
