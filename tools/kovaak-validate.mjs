// 実 KovaaK export の検証ツール（G-1）
//
//   node tools/kovaak-validate.mjs [statsDir]
//
// 実ファイルを **読み取り専用** で解析し、G-1 のチェック項目を機械的に照合する。
// ファイルの削除・改変は一切行わない。個人情報が含まれうるため、値の全文表示は
// 最小限にとどめ、構造（列名・型・件数）を中心に出力する。
//
// 目的は Aim 性能の評価ではなく、schema と設定値対応の確定。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const DEFAULT_STATS = 'D:/SteamLibrary/steamapps/common/FPSAimTrainer/FPSAimTrainer/stats';
const statsDir = process.argv[2] || DEFAULT_STATS;

// ------------------------------------------------------------ Adapter 読込

function loadAdapter() {
    const ctx = {
        console, Math, JSON, Date, Number, String, Boolean, Array, Object, isFinite, isNaN,
        Promise, Uint8Array, ArrayBuffer, TextEncoder, crypto, Error
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'importers', 'kovaak.js'), 'utf8'), ctx);
    return ctx.LC_IMPORTERS.kovaak;
}

// ------------------------------------------------------------ 生ファイル解析

function rawReport(file, buf) {
    const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    const crlf = (text.match(/\r\n/g) || []).length;
    const lfOnly = (text.match(/(?<!\r)\n/g) || []).length;

    // 非ASCII（個人名などが混ざる可能性の把握。中身は出さない）
    const nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;

    const blocks = text.replace(/\r\n/g, '\n').split(/\n\s*\n/).filter((b) => b.trim());
    const lines = (b) => b.split('\n').filter((l) => l.trim());

    let kill = null, weapon = null;
    const kv = [];
    for (const b of blocks) {
        const head = lines(b)[0] || '';
        if (head.startsWith('Kill #,')) kill = b;
        else if (head.startsWith('Weapon,')) weapon = b;
        else kv.push(b);
    }

    const footer = {};
    for (const b of kv) {
        for (const l of lines(b)) {
            const cells = l.split(',');
            const k = (cells[0] || '').trim();
            if (k.endsWith(':')) footer[k.slice(0, -1)] = cells.slice(1).join(',').trim();
        }
    }

    return {
        bytes: buf.length, hasBom, crlf, lfOnly, nonAscii,
        blockCount: blocks.length,
        killHeaders: kill ? lines(kill)[0].split(',').map((s) => s.trim()) : [],
        killRowCount: kill ? lines(kill).length - 1 : 0,
        killFirstRow: kill && lines(kill)[1] ? lines(kill)[1].split(',').map((s) => s.trim()) : [],
        weaponHeaders: weapon ? lines(weapon)[0].split(',').map((s) => s.trim()) : [],
        weaponRows: weapon ? lines(weapon).slice(1).map((l) => l.split(',').map((s) => s.trim())) : [],
        footer
    };
}

function weaponFieldValues(rep, name) {
    const idxs = [];
    rep.weaponHeaders.forEach((h, i) => { if (h.toLowerCase() === name.toLowerCase()) idxs.push(i); });
    return rep.weaponRows.map((r) => idxs.map((i) => r[i])).flat();
}

// ------------------------------------------------------------------ 実行

if (!fs.existsSync(statsDir)) {
    console.error(`❌ stats フォルダが見つかりません: ${statsDir}`);
    process.exit(1);
}

const files = fs.readdirSync(statsDir).filter((f) => f.toLowerCase().endsWith('.csv')).sort();

console.log('='.repeat(78));
console.log('KovaaK 実 export 検証（G-1）  読み取り専用');
console.log('='.repeat(78));
console.log(`stats フォルダ : ${statsDir}`);
console.log(`CSV 件数       : ${files.length}`);

// stats フォルダ内の CSV 以外（秒単位データの保存先候補）
const others = fs.readdirSync(statsDir).filter((f) => !f.toLowerCase().endsWith('.csv'));
console.log(`CSV以外        : ${others.length ? others.join(', ') : '(なし)'}`);

if (files.length === 0) {
    console.log('\n⚠️ CSV がありません。');
    console.log('   ゲーム内で Statistics Export を Always にし、Challenge を1回実行してください。');
    process.exit(0);
}

const app = loadAdapter();

for (const f of files) {
    const full = path.join(statsDir, f);
    const buf = fs.readFileSync(full);
    const rep = rawReport(f, buf);

    console.log('\n' + '─'.repeat(78));
    console.log(`■ ${f}`);
    console.log('─'.repeat(78));

    // --- ファイル名規則
    const fn = app.parseFileName(f);
    console.log(`ファイル名解析 : ${fn.ok ? 'OK' : 'NG(' + fn.reason + ')'}`
        + (fn.ok ? `  scenario="${fn.scenario}"  ts=${fn.localTimestamp}` : ''));

    // --- encoding / 改行
    console.log(`encoding       : ${rep.hasBom ? 'UTF-8 BOM付き' : 'BOM無し'}  非ASCII文字数=${rep.nonAscii}`);
    console.log(`改行           : CRLF=${rep.crlf}  LF単独=${rep.lfOnly}  → ${rep.crlf && !rep.lfOnly ? 'CRLF' : (rep.lfOnly && !rep.crlf ? 'LF' : '混在')}`);
    console.log(`ブロック数     : ${rep.blockCount}`);

    // --- Kill セクション
    console.log(`\nKill 列 (${rep.killHeaders.length}) : ${rep.killHeaders.join(', ')}`);
    console.log(`Kill 行数      : ${rep.killRowCount}`);
    if (rep.killFirstRow.length) {
        const pairs = rep.killHeaders.map((h, i) => `${h}=${rep.killFirstRow[i]}`);
        console.log(`Kill 先頭行    : ${pairs.join('  ')}`);
    }

    // --- Weapon セクション
    console.log(`\nWeapon 列 (${rep.weaponHeaders.length}) : ${rep.weaponHeaders.map((h) => h === '' ? '(空)' : h).join(', ')}`);
    console.log(`Weapon 行数    : ${rep.weaponRows.length}`);
    rep.weaponRows.forEach((r, i) => {
        console.log(`  行${i}: ${rep.weaponHeaders.map((h, j) => `${h || '(空)'}=${r[j]}`).join('  ')}`);
    });

    // --- フッター
    console.log(`\nフッター (${Object.keys(rep.footer).length} キー):`);
    for (const [k, v] of Object.entries(rep.footer)) console.log(`  ${k.padEnd(22)} = ${v}`);

    // --- ★ 最重要: Horiz Sens の照合
    console.log('\n★ Horiz Sens の照合（最重要）');
    const wHoriz = weaponFieldValues(rep, 'Horiz Sens');
    const fHoriz = rep.footer['Horiz Sens'];
    const sensScale = weaponFieldValues(rep, 'Sens Scale');
    console.log(`  Weapon行 Horiz Sens : ${wHoriz.length ? wHoriz.join(', ') : '(無し)'}`);
    console.log(`  Footer   Horiz Sens : ${fHoriz === undefined ? '(無し)' : fHoriz}`);
    console.log(`  Sens Scale          : ${sensScale.length ? sensScale.join(', ') : '(無し)'}`);
    if (wHoriz.length && fHoriz !== undefined) {
        const a = Number(wHoriz[0]), b = Number(fHoriz);
        if (isFinite(a) && isFinite(b) && a !== 0) {
            console.log(`  比 (Footer / Weapon) : ${Math.round((b / a) * 10000) / 10000}`);
        }
    }
    console.log('  → 画面に表示されていた設定値と突き合わせて、どちらが in-game 感度か確定すること');

    // --- Importer 投入
    console.log('\n■ Phase D importer への投入');
    const detection = app.detectFormat({ name: f, text: buf.toString('utf8') });
    console.log(`  detectFormat : ${detection.format}  confidence=${detection.confidence}`);
    console.log(`  signals      : ${detection.signals.join(', ')}`);
    if (detection.reasons.length) console.log(`  reasons      : ${detection.reasons.join(' / ')}`);

    const res = await app.run([{ name: f, text: buf.toString('utf8') }], { importedAt: new Date().toISOString() });
    console.log(`  sessions     : ${res.stats.sessionsParsed} / rejected: ${res.stats.filesRejected}`);
    if (res.sessions[0]) {
        const s = res.sessions[0];
        console.log(`  SHA-256      : ${s.provenance.rawContentHash}`);
        console.log(`  metrics      : ${s.metrics.map((m) => m.metricKey + '=' + m.value).join('  ')}`);
        console.log(`  weapons      : ${s.weapons.map((w) => w.weapon + '(' + w.metrics.length + ')').join(', ') || '(なし)'}`);
        console.log(`  context      : dpi=${s.context.dpi} (${s.context.dpiSource})  fov=${s.context.fov}  sensScale=${s.context.sensScale}`);
        console.log(`  unresolved   : ${s.unresolved.map((u) => u.field + '(' + u.reason + ')').join(', ')}`);
    }
    if (res.warnings.length) {
        console.log('  warnings     :');
        res.warnings.forEach((w) => console.log(`    [${w.level}] ${w.code}: ${w.message}`));
    } else {
        console.log('  warnings     : (なし)');
    }
    if (res.unknownFields.length) {
        console.log('  未知フィールド:');
        res.unknownFields.forEach((u) => console.log(`    ${u.section}.${u.key}`));
    } else {
        console.log('  未知フィールド: (なし)');
    }
}

// ------------------------------------------------------------ 横断サマリ

if (files.length > 1) {
    console.log('\n' + '='.repeat(78));
    console.log('■ 複数ファイル横断サマリ（Horiz Sens の変化を見る）');
    console.log('='.repeat(78));
    console.log('ファイル'.padEnd(52), 'Weapon'.padEnd(12), 'Footer'.padEnd(12), '比');
    for (const f of files) {
        const rep = rawReport(f, fs.readFileSync(path.join(statsDir, f)));
        const w = weaponFieldValues(rep, 'Horiz Sens')[0];
        const ft = rep.footer['Horiz Sens'];
        const ratio = (Number(w) && Number(ft)) ? Math.round((Number(ft) / Number(w)) * 10000) / 10000 : '';
        console.log(f.slice(0, 50).padEnd(52), String(w ?? '').padEnd(12), String(ft ?? '').padEnd(12), ratio);
    }
}

console.log('\n完了。ファイルの削除・改変は行っていません。');
