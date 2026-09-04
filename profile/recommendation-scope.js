/**
 * Recommendation の意味の定義（scope contract）。
 *
 * 【最も重要な決まり】
 *   KovaaK の evidence から出している推奨は、**Aim テスト上での感度の推奨**である。
 *   「ゲーム内で最適だと実証された感度」ではない。
 *   `kovaak.score` を「ゲーム内の強さ」を表す指標として扱ってはいけない。
 *
 * Profile を3層に分ける。現時点で実測できるのは 1 だけ。
 *
 *   1. Mechanical Aim Profile
 *      Aim トレーナー等での機械的なエイム性能。**いま出せるのはここだけ。**
 *
 *   2. Game-specific Performance Profile
 *      実ゲームでの成績にもとづくもの。ゲーム内 evidence が存在しないので **生成しない**。
 *
 *   3. Final / Integrated Recommendation
 *      1 と 2 を統合したもの。2 が無い以上 **生成しない**。
 *
 * 将来 `mechanical_optimum` / `game_optimum` / `transfer_gap` /
 * `integrated_recommendation` を表現できるよう場所だけ用意してあるが、
 * **架空の game performance 値や transfer 係数は作らない。**
 * 値が無いことは `available: false` と理由で表す。
 */
(function (root) {
    'use strict';

    var LAYER = {
        MECHANICAL: 'mechanical_aim',
        GAME: 'game_specific_performance',
        INTEGRATED: 'integrated'
    };

    /** どの evidence がどの層に属するか。source_type で決める。 */
    function layerOfSourceType(sourceType) {
        if (sourceType === 'aim_trainer' || sourceType === 'manual') return LAYER.MECHANICAL;
        if (sourceType === 'in_game_match' || sourceType === 'in_game_stats') return LAYER.GAME;
        return null;
    }

    /**
     * いま出せる層を判定する。
     * ゲーム内 evidence が1件も無ければ、2層目と3層目は作らない。
     */
    function assessLayers(evidence) {
        var counts = { mechanical_aim: 0, game_specific_performance: 0, unknown: 0 };
        (evidence || []).forEach(function (e) {
            var l = layerOfSourceType(e.sourceType);
            if (l === LAYER.MECHANICAL) counts.mechanical_aim++;
            else if (l === LAYER.GAME) counts.game_specific_performance++;
            else counts.unknown++;
        });

        var hasGame = counts.game_specific_performance > 0;

        return {
            kind: 'profile_layers',
            layers: [
                {
                    id: LAYER.MECHANICAL,
                    order: 1,
                    available: counts.mechanical_aim > 0,
                    evidenceCount: counts.mechanical_aim,
                    measures: 'aim_test_performance',
                    note: 'Aim テストでの機械的なエイム性能。いま実測できるのはここだけ。'
                },
                {
                    id: LAYER.GAME,
                    order: 2,
                    available: hasGame,
                    evidenceCount: counts.game_specific_performance,
                    measures: 'in_game_performance',
                    reason: hasGame ? null : 'no_in_game_evidence',
                    note: hasGame ? null
                        : '実ゲームの evidence が無いため生成しない。推測で作らない。'
                },
                {
                    id: LAYER.INTEGRATED,
                    order: 3,
                    available: false,   // 2 が無い限り作らない
                    evidenceCount: 0,
                    measures: 'integrated',
                    reason: hasGame ? 'integration_model_not_defined' : 'requires_game_specific_layer',
                    note: '1 と 2 を統合したもの。2 が無い、または統合の方法が未確定のため生成しない。'
                }
            ],

            // 将来の拡張点。**いまはすべて値を持たない。**
            // 場所だけ用意しておくことで、後から足しても contract が壊れない。
            extensionPoints: {
                mechanical_optimum: { available: false, reason: 'expressed_as_recommended_cm360_for_now' },
                game_optimum: { available: false, reason: 'no_in_game_evidence' },
                transfer_gap: { available: false, reason: 'requires_both_layers' },
                integrated_recommendation: { available: false, reason: 'requires_both_layers' }
            }
        };
    }

    /**
     * 推奨に付ける scope。**推奨と必ず一緒に返す。**
     * これが付いていない推奨を画面に出してはいけない。
     */
    function scopeOf(evidence) {
        var layers = assessLayers(evidence);
        var game = layers.layers[1];

        return {
            kind: 'recommendation_scope',
            appliesTo: 'aim_test',                    // ← ゲーム内ではない
            basedOn: 'mechanical_aim_performance',
            layer: LAYER.MECHANICAL,
            provenInGame: false,                      // **常に false。実証していない**
            gameEvidenceCount: game.evidenceCount,
            // 画面に必ず出す注意書きの識別子。文言は i18n が持つ。
            disclaimerKey: 'recScopeDisclaimer',
            titleKey: 'recScopeTitle',
            // 禁止事項を contract として明示する
            prohibited: [
                'present_as_proven_in_game_optimum',
                'convert_to_game_skill_or_rank',
                'estimate_match_performance',
                'invent_transfer_coefficient'
            ],
            layers: layers
        };
    }

    /**
     * 禁止事項に違反していないかを機械的に確かめる。
     * 推奨の出力に「ゲーム内での強さ」を意味する値が混ざっていないか見る。
     */
    var FORBIDDEN_KEYS = [
        'game_skill', 'gameSkill', 'rank', 'estimated_rank', 'mmr', 'elo',
        'match_performance', 'matchPerformance', 'kd', 'kda',
        'game_optimum_cm360', 'transfer_coefficient', 'transferCoefficient',
        'valorant_score', 'apex_score', 'predicted_rank'
    ];

    function auditRecommendation(payload) {
        var found = [];
        (function walk(v, at) {
            if (v === null || typeof v !== 'object') return;
            if (Array.isArray(v)) { v.forEach(function (x, i) { walk(x, at + '[' + i + ']'); }); return; }
            Object.keys(v).forEach(function (k) {
                if (FORBIDDEN_KEYS.indexOf(k) >= 0) found.push(at + '.' + k);
                walk(v[k], at + '.' + k);
            });
        })(payload, '$');
        return { clean: found.length === 0, offendingKeys: found };
    }

    root.LC_REC_SCOPE = {
        LAYER: LAYER,
        FORBIDDEN_KEYS: FORBIDDEN_KEYS,
        layerOfSourceType: layerOfSourceType,
        assessLayers: assessLayers,
        scopeOf: scopeOf,
        auditRecommendation: auditRecommendation
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
