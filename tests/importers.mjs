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
    otherSens: 'Tile Frenzy - Challenge - 2026.08.12-09.30.00 Stats.csv',
    // 実 KovaaK 3.9.8 の構造を保った匿名・合成データ（現行形式の基準）
    real: 'Synthetic Intro Scenario - Challenge - 2026.09.04-23.05.48 Stats.csv'
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
    ok(d.signals.includes('section_markers_present'), 'セクションマーカーを検出');
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

check('正規化: DPI は自己申告として扱い、確定させない', async () => {
    const r = await app.run([readFixture(F.current)], { importedAt: 'T' });
    const s = r.sessions[0];
    eq(s.context.dpi, 800, '値は取れる');
    eq(s.context.dpiSource, 'file_self_declared', 'ファイル値は自己申告');
    eq(s.context.dpiNeedsConfirmation, true, 'ユーザー確認が必要');

    // 実測で「ファイル400 / 実機800」の食い違いが出たため、確定扱いにしない
    const u = s.unresolved.find((x) => x.field === 'dpi_verified');
    ok(u, 'DPIが未確定として記録される');
    eq(u.reason, 'file_value_is_self_declared', '理由');
});

check('正規化: 旧形式は DPI が無く dpiSource=unknown', async () => {
    const r = await app.run([readFixture(F.legacy)], { importedAt: 'T' });
    eq(r.sessions[0].context.dpi, null, 'DPI');
    eq(r.sessions[0].context.dpiSource, 'unknown', 'DPIの出どころ');
});

check('正規化: 適応型シナリオの値を context に取り込む', async () => {
    const r = await app.run([readFixture(F.oddName)], { importedAt: 'T' });
    const c = r.sessions[0].context;
    eq(c.avgTargetScale, 1.2, 'Avg Target Scale（数値化される）');
    eq(c.avgTimeDilation, 0.9, 'Avg Time Dilation');
});

// ------------------------------- 5. 禁止事項（Horiz Sens / cm360 / 保存）

check('出どころが複数あって食い違う場合は感度を確定しない', async () => {
    const r = await app.run([readFixture(F.current)], { importedAt: 'T' });
    const s = r.sessions[0];

    ok(!s.metrics.some((m) => /horiz|sens/.test(m.metricKey)),
        'Horiz Sens が metric として正規化されていないこと');
    eq(s.context.inGameSens, null, '食い違うときは感度を確定しない');
    eq(s.context.inGameSensSource, 'ambiguous', '出どころが定まらないことを明示する');

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
    const cm = s.unresolved.find((u) => u.field === 'cm360');
    ok(cm, 'cm360 が unresolved に記録されていること');
    ok(/in_game_sens/.test(cm.reason), '感度が未確定であること');
    ok(/dpi/.test(cm.reason), 'DPIも阻害要因であること');
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
    // チェックアウト時の改行コードに依存しないよう、両方の版をここで作る。
    // （fixture の保存形式に依存させると Linux と Windows で結果が変わる）
    const f = readFixture(F.current);
    const lfText = f.text.replace(/\r\n/g, '\n');
    const crlfText = lfText.replace(/\n/g, '\r\n');
    const lf = { name: f.name, text: lfText };
    const crlf = { name: f.name, text: crlfText };

    const a = (await app.run([crlf], { importedAt: 'T' })).sessions[0].provenance;
    const b = (await app.run([lf], { importedAt: 'T' })).sessions[0].provenance;

    // 改行コードだけ違う = バイト列が違う → raw_content_hash は別で正しい
    ok(a.rawContentHash !== b.rawContentHash,
        '改行が違えば raw_content_hash は別になる（バイト列ベースなので正しい挙動）');
    // 同一runの検知は logical_fingerprint の責務であり、まだ実装していない
    eq(a.logicalFingerprint, null);
    eq(a.logicalFingerprintStatus, 'not_implemented_phase_d');
});

// ================= 実 KovaaK 3.9.8 の構造（2026-09-04 実測に基づく）

check('実構造: 3.9.8 を current と判定し、ゲーム版を signal に載せる', async () => {
    const d = app.detectFormat(readFixture(F.real));
    eq(d.format, app.FORMATS.CURRENT, 'format');
    ok(d.signals.includes('footer_has_dpi'), 'DPI で世代を判別する');
    ok(d.signals.includes('footer_has_sens_increment'), 'Sens Increment を検出');
    ok(d.signals.includes('footer_has_resolution'), 'Resolution を検出');
    // 3.9.8 は Kill/Weapon/Summary/Settings の4ブロック構成を保っている
    ok(d.signals.includes('section_markers_present'), 'セクションマーカーも同時に持つ');
    ok(d.signals.includes('timestamp_clock'), 'Timestamp は時刻表記');
    ok(d.signals.some((x) => x.startsWith('game_version:3.9.8')), 'ゲーム版を記録');
});

check('実構造: Timestamp が時刻表記でも世代判別を誤らない', async () => {
    // かつては「経過秒＝現行」と誤って想定していた。実ファイルは時刻表記。
    const d = app.detectFormat(readFixture(F.real));
    ok(!d.signals.includes('timestamp_elapsed_seconds'), '経過秒ではない');
    eq(d.format, app.FORMATS.CURRENT, 'それでも current と判定する');
});

check('実構造: 設定値をフッターから取得する', async () => {
    const r = await app.run([readFixture(F.real)], { importedAt: 'T' });
    const c = r.sessions[0].context;
    eq(c.dpi, 400, 'ファイルに書かれている値');
    eq(c.dpiSource, 'file_self_declared', '自己申告として扱う');
    eq(c.fov, '103.0', 'FOV');
    eq(c.sensScale, 'Valorant', 'Sens Scale は名前であって数値ではない');
    eq(c.fovScale, 'Valorant', 'FOVScale');
    eq(c.resolution, '1920x1080', 'Resolution');
    eq(c.sensIncrement, 0.214877, 'Sens Increment（数値化される）');
});

check('実構造: 武器行のヘッダのみの列で警告を出さない', async () => {
    const r = await app.run([readFixture(F.real)], { importedAt: 'T' });
    eq(r.warnings.filter((w) => w.code === 'value_not_numeric').length, 0,
        '設定名だけが並ぶ列を欠損として警告しない');
    eq(r.unknownFields.length, 0, '未知フィールドが出ない');
    const w = r.sessions[0].weapons[0];
    eq(w.weapon, 'Full auto', '武器名');
    eq(w.metrics.length, 4, '武器統計は4件');
});

check('実構造: 新しいフッター項目を取り込む', async () => {
    const r = await app.run([readFixture(F.real)], { importedAt: 'T' });
    const s = r.sessions[0];
    eq(metricOf(s, 'kovaak.miss_count'), 30, 'Miss Count');
    eq(metricOf(s, 'kovaak.total_overshots'), 3, 'Total Overshots');
    eq(metricOf(s, 'kovaak.reloads'), 0, 'Reloads');
    eq(metricOf(s, 'kovaak.pause_count'), 0, 'Pause Count');
    eq(metricOf(s, 'kovaak.time_remaining'), 0, 'Time Remaining');
});

check('実構造: ファイル名の日時は終了時刻で、開始時刻はフッターにある', async () => {
    const r = await app.run([readFixture(F.real)], { importedAt: 'T' });
    const s = r.sessions[0];
    eq(s.localTimestamp, '2026-09-04T23:05:48', 'ファイル名の日時');
    eq(s.context.challengeStartClock, '23:04:00.000', 'Challenge Start');
    eq(s.context.filenameTimestampMeaning, 'challenge_end', 'ファイル名は終了時刻');
});

check('実構造: 改行コードが混在していても解析できる', async () => {
    const raw = fs.readFileSync(path.join(FIXTURE_DIR, F.real), 'utf8');
    const CR = String.fromCharCode(13), LF = String.fromCharCode(10);
    let crlf = 0, lfOnly = 0;
    for (let i = 0; i < raw.length; i++) {
        if (raw[i] !== LF) continue;
        if (i > 0 && raw[i - 1] === CR) crlf++; else lfOnly++;
    }
    ok(crlf > 0 && lfOnly > 0, 'fixture 自体が混在していること（実ファイルと同じ）');

    const r = await app.run([readFixture(F.real)], { importedAt: 'T' });
    eq(r.stats.sessionsParsed, 1, '混在でも解析できる');
});

check('実構造: TTK の s 接尾辞を数値化できる', async () => {
    // Kill 行の TTK は "7.649000s" のような表記
    eq(app.detectFormat(readFixture(F.real)).format, app.FORMATS.CURRENT);
    const r = await app.run([readFixture(F.real)], { importedAt: 'T' });
    eq(r.warnings.length, 0, '警告なしで通る');
});

check('実構造: Horiz Sens は1箇所しか無く、G-1 で確定した', async () => {
    const r = await app.run([readFixture(F.real)], { importedAt: 'T' });
    const s0 = r.sessions[0];
    ok(!s0.unresolved.some((x) => x.field === 'in_game_sens'),
        'G-1 の実機照合により未確定ではなくなる');
    eq(s0.context.inGameSens, 0.215, 'フッターの Horiz Sens をそのまま採用');
    eq(s0.context.inGameSensSource, 'footer_horiz_sens', '出どころを明示');
    ok(/0\.215,0\.4/.test(s0.context.inGameSensBasis), '照合に使った実測値が根拠に残る');
    eq(s0.context.inGameSensAxesDiffer, false, '縦横が同じ');
    ok(!s0.metrics.some((m) => /horiz|sens/.test(m.metricKey)),
        '感度そのものは metric 化しない');
});

check('実構造: ファイルのDPIと実機DPIが違いうることを前提にする', async () => {
    // 実測（2026-09-04）: ファイル 400 / 実機 800。cm/360 が2倍ずれる。
    const r = await app.run([readFixture(F.real)], { importedAt: 'T' });
    const s = r.sessions[0];
    eq(s.context.dpi, 400, 'ファイルの値');
    eq(s.context.dpiNeedsConfirmation, true, '確認が必要');
    const cm = s.unresolved.find((u) => u.field === 'cm360');
    ok(/dpi_unverified/.test(cm.reason), 'DPI未確認が cm/360 の阻害要因になる');
    ok(/2倍/.test(cm.note), '誤差の大きさが説明されている');
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
    eq(p.dpi.selfDeclaredInFile, 1, 'ファイルにDPIがあった件数');
    eq(p.dpi.missing, 1, 'DPIが無かった件数');
    eq(p.dpi.needsUserConfirmation, 2, '解析できた全件で確認が必要');
    eq(p.period.tzKnown, false, 'タイムゾーンは不明のまま');
    ok(p.unresolvedFields.in_game_sens >= 1, 'in_game_sens が未確定として集計される');
});

// --------------------------- 10. G-1（実 KovaaK 3.9.8 照合）で判明したこと

check('G-1: Sens Increment は感度の出どころにしない', async () => {
    const r = await app.run([readFixture(F.real)], { importedAt: 'T' });
    const c = r.sessions[0].context;
    eq(c.sensIncrementUsage, 'recorded_only_meaning_unconfirmed', '記録のみで使わない');
    // 実測2点で比が一定（0.9994279）だった。丸め前の値ではない。
    ok(Math.abs(c.sensIncrementRatio - 0.9994279) < 1e-6,
        `Horiz Sens との比が実測どおり: ${c.sensIncrementRatio}`);
    eq(c.inGameSens, 0.215, '感度として採用されるのは Horiz Sens のほう');
});

check('G-1: Hash をシナリオの識別子として使う', async () => {
    const r = await app.run([readFixture(F.real)], { importedAt: 'T' });
    const c = r.sessions[0].context;
    eq(c.scenarioKey, c.sourceHash, 'Hash をそのまま鍵にする');
    eq(c.scenarioKeySource, 'footer_hash', '出どころを明示');
    ok(c.scenarioKey && c.scenarioKey !== c.scenarioFromFooter,
        '表示名ではなく Hash を使う');
});

check('G-1: 難易度が動いたセッションは比較対象から外す', async () => {
    const base = readFixture(F.real);
    const varied = { name: base.name, text: base.text.replace('Avg Target Scale:,1.0', 'Avg Target Scale:,1.367143') };
    const r = await app.run([varied], { importedAt: 'T' });
    const s0 = r.sessions[0];
    eq(s0.context.difficultyVaried, true, '変動したと判定');
    ok(/1\.367143/.test(s0.context.difficultyVariedBasis), '根拠に実測値が残る');
    const u = s0.unresolved.find((x) => x.field === 'session_comparability');
    ok(u, '比較可能性が未確定として記録される');
    eq(u.reason, 'difficulty_varied_within_session', '理由');
});

check('G-1: 難易度が一定なら比較対象に残す', async () => {
    const r = await app.run([readFixture(F.real)], { importedAt: 'T' });
    const s0 = r.sessions[0];
    eq(s0.context.difficultyVaried, false, '一定と判定');
    ok(!s0.unresolved.some((x) => x.field === 'session_comparability'),
        '比較可能性は阻害されない');
});

check('G-1: シナリオ名から適応型を推測しない', async () => {
    const base = readFixture(F.real);
    // 名前に Adapt を含めても、Avg Target Scale が 1.0 なら変動とは断定しない
    const renamed = {
        name: 'SmallFlicks Valorant Adapt - Challenge - 2026.09.04-23.31.46 Stats.csv',
        text: base.text
    };
    const r = await app.run([renamed], { importedAt: 'T' });
    eq(r.sessions[0].context.difficultyVaried, false, '名前では判定しない');
});

check('G-1: cm/360 を阻むのは実機DPIだけになった', async () => {
    const r = await app.run([readFixture(F.real)], { importedAt: 'T' });
    const cm = r.sessions[0].unresolved.find((x) => x.field === 'cm360');
    ok(cm, 'cm/360 はなお自動確定しない');
    ok(!/in_game_sens/.test(cm.reason), '感度はもう阻害要因ではない');
    ok(/dpi_unverified/.test(cm.reason), '残る阻害要因は実機DPIの確認');
});

check('G-1: DPIが無ければ感度が確定していても cm/360 は出さない', async () => {
    const base = readFixture(F.real);
    const noDpi = { name: base.name, text: base.text.replace(/DPI:,\d+/, 'DPI:,') };
    const r = await app.run([noDpi], { importedAt: 'T' });
    const s0 = r.sessions[0];
    eq(s0.context.inGameSens, 0.215, '感度は確定している');
    const cm = s0.unresolved.find((x) => x.field === 'cm360');
    ok(/dpi_missing/.test(cm.reason), 'DPI欠落を理由として記録');
});

check('G-1: 縦横で感度が違う場合を検出する', async () => {
    const base = readFixture(F.real);
    const asym = { name: base.name, text: base.text.replace('Vert Sens:,0.215', 'Vert Sens:,0.3') };
    const r = await app.run([asym], { importedAt: 'T' });
    const c = r.sessions[0].context;
    eq(c.inGameSens, 0.215, '横を代表値にする');
    eq(c.inGameSensVert, 0.3, '縦も保持する');
    eq(c.inGameSensAxesDiffer, true, '差があることを記録');
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
