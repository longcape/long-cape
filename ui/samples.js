/**
 * G-3 prototype 用のサンプルデータ生成。
 *
 * **すべて人工データ。** 実ユーザーのファイルは含まない。
 * KovaaK 3.9.8 の実 export で確認した構造（G-1 正本）に合わせてある。
 *
 * Recommendation の UI 検証にも人工データを使う。
 * G-3 では KovaaK の実データを本番 Recommendation へ接続しない。
 */
(function (root) {
    'use strict';

    function csv(o) {
        var kills = o.kills, hits = o.hits, shots = o.shots;
        var rows = [];
        for (var i = 1; i <= kills; i++) {
            var s = 10 + i, h = 5 + i;
            rows.push([i, '23:0' + (i % 6) + ':' + String(10 + i).padStart(2, '0') + '.100',
                'Synthetic Bot', 'Full auto', (0.5 + i * 0.1).toFixed(6) + 's',
                s, h, (h / s).toFixed(6), (i * 20).toFixed(6), (i * 40).toFixed(6),
                '0.500000', 0, i % 2].join(','));
        }

        var footer = [
            ['Kills', kills], ['Deaths', 0], ['Fight Time', (kills * 1.2).toFixed(6)],
            ['Time Remaining', '0.0'], ['Avg TTK', (60 / kills).toFixed(6)],
            ['Damage Done', (hits * 2).toFixed(1)], ['Total Overshots', 3], ['Damage Taken', '0.0'],
            ['Hit Count', hits], ['Miss Count', shots - hits], ['Midairs', 0], ['Midaired', 0],
            ['Directs', 0], ['Directed', 0], ['Reloads', 0], ['Distance Traveled', '0.0'],
            ['MBS Points', '0.0'], ['Score', o.score.toFixed(1)],
            ['Scenario', o.scenario], ['Hash', o.hash],
            ['Game Version', '3.9.8.2026-08-26-12-34-50-0000000000'],
            ['Challenge Start', '23:04:00.000'], ['Pause Count', 0], ['Pause Duration', 0],
            ['Avg Target Scale', o.targetScale], ['Avg Time Dilation', '1.0']
        ].map(function (p) { return p[0] + ':,' + p[1]; }).join('\r\n');

        var settings = [
            ['Input Lag', 0], ['Max FPS (config)', '999.0'], ['Sens Scale', o.sensScale],
            ['Sens Increment', (o.sens * 0.9994279).toFixed(6)],
            ['Horiz Sens', o.sens], ['Vert Sens', o.sens], ['DPI', o.dpi],
            ['FOV', '103.0'], ['FOVScale', o.sensScale], ['Hide Gun', 'false'],
            ['Crosshair', 'dot.png'], ['Crosshair Scale', '1.0'], ['Crosshair Color', '010101FF'],
            ['Resolution', '1920x1080'], ['Avg FPS', '500.000000'], ['Resolution Scale', '100.0']
        ].map(function (p) { return p[0] + ':,' + p[1]; }).join('\r\n');

        // Kill 表は LF、以降は CRLF。実ファイルで観測した混在をそのまま再現する。
        return 'Kill #,Timestamp,Bot,Weapon,TTK,Shots,Hits,Accuracy,Damage Done,Damage Possible,'
            + 'Efficiency,Cheated,OverShots\n' + rows.join('\n') + '\n\r\n'
            + 'Weapon,Shots,Hits,Damage Done,Damage Possible,,Sens Scale,Horiz Sens,Vert Sens,FOV,'
            + 'Hide Gun,Crosshair,Crosshair Scale,Crosshair Color,ADS Sens,ADS Zoom Scale,'
            + 'Avg Target Scale,Avg Time Dilation\r\n'
            + 'Full auto,' + shots + ',' + hits + ',' + (hits * 2).toFixed(1) + ',' + (shots * 2).toFixed(1) + ',\r\n'
            + '\r\n' + footer + '\r\n\r\n' + settings + '\r\n';
    }

    function file(name, o) {
        return { name: name, text: csv(o) };
    }

    var HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    var HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    function base(over) {
        var o = {
            kills: 12, hits: 60, shots: 130, score: 980, scenario: 'VarClick Practice',
            hash: HASH_A, targetScale: '1.0', sensScale: 'Valorant', sens: 0.215, dpi: 400
        };
        Object.keys(over || {}).forEach(function (k) { o[k] = over[k]; });
        return o;
    }

    function files(kind) {
        if (kind === 'adaptive') {
            return [
                file('VarClick Practice - Challenge - 2026.09.04-21.10.00 Stats.csv', base({ score: 980 })),
                file('VarClick Practice - Challenge - 2026.09.04-21.20.00 Stats.csv', base({ score: 1020, kills: 13 })),
                // 難易度が動いたセッション。Avg Target Scale が 1.0 以外。
                file('SmallFlicks Adapt - Challenge - 2026.09.04-21.30.00 Stats.csv',
                    base({ scenario: 'SmallFlicks Adapt', hash: HASH_B, targetScale: '1.367143', score: 9999, kills: 40 }))
            ];
        }
        if (kind === 'broken') {
            return [
                file('VarClick Practice - Challenge - 2026.09.04-21.10.00 Stats.csv', base({})),
                { name: 'my-notes.csv', text: 'date,memo\n2026-09-04,これはKovaaKのファイルではありません\n' },
                { name: 'Broken - Challenge - 2026.09.04-21.40.00 Stats.csv', text: 'Kill #,Timestamp\n1\n\n\n' }
            ];
        }
        return [
            file('VarClick Practice - Challenge - 2026.09.04-21.10.00 Stats.csv', base({ score: 980 })),
            file('VarClick Practice - Challenge - 2026.09.04-21.20.00 Stats.csv', base({ score: 1020, kills: 13 }))
        ];
    }

    // ------------------------------------------------- Recommendation 用の人工データ
    //
    // 実 KovaaK データを本番 Recommendation へ接続しないため、
    // UI 検証にはこの人工セッションを使う。source は manual。
    function syntheticLevels(spec) {
        var out = [], n = 0;
        (spec || [{ cm: 30, runs: 3 }, { cm: 32, runs: 3 }, { cm: 34, runs: 3 }, { cm: 36, runs: 3 }])
            .forEach(function (lv) {
                for (var i = 0; i < lv.runs; i++) {
                    n++;
                    var score = 1000 - 8 * Math.pow(lv.cm - (lv.peak || 34), 2) + (i - 1) * (lv.noise || 6);
                    out.push({
                        externalId: 'demo-' + lv.cm + '-' + i,
                        scenario: 'Long Cape Benchmark',
                        localTimestamp: '2026-08-' + String(10 + (n % 18)).padStart(2, '0') + 'T12:00:00',
                        tzKnown: true,
                        metrics: [{ metricKey: 'manual.benchmark_score', value: Math.round(score * 100) / 100, unit: 'score' }],
                        weapons: [],
                        context: {
                            dpi: 800, durationSec: 60, scenarioKey: 'demo-hash',
                            difficultyVaried: false,
                            sensitivity: { cm360: lv.cm, verified: true, origin: 'user_input' }
                        },
                        unresolved: [],
                        provenance: {
                            source: 'manual', sourceType: 'manual', collectionMethod: 'screen_transcribed',
                            parserVersion: '0.0.0-demo', normalizationVersion: '0.0.0-demo',
                            importedAt: '2026-09-05T00:00:00.000Z', consentId: null
                        }
                    });
                }
            });
        return out;
    }

    root.LC_SAMPLES = {
        csv: csv, file: file, files: files, base: base,
        syntheticLevels: syntheticLevels,
        // 推奨が出せるケース / 出せないケース
        enough: function () { return syntheticLevels(); },
        notEnough: function () { return syntheticLevels([{ cm: 34, runs: 2 }]); },
        withAdaptive: function () {
            var s = syntheticLevels();
            var bad = syntheticLevels([{ cm: 28, runs: 4, peak: 28 }]).map(function (x) {
                x.externalId += '-adaptive';
                x.scenario = 'SmallFlicks Adapt';
                x.metrics[0].value = 99999;
                x.context.difficultyVaried = true;
                x.context.difficultyVariedBasis = 'avg_target_scale=1.367143';
                return x;
            });
            return s.concat(bad);
        }
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
