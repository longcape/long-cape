/**
 * Metric Registry — Phase E.5
 * ===========================
 *
 * 正本はリポジトリ直下の metrics.json。ここは静的サイト用の埋め込みコピーで、
 * `node tools/sync-metrics.mjs` が自動生成する。手で編集しないこと。
 * ズレは `node tools/sync-metrics.mjs --check`（CIで実行）が検出する。
 *
 * 【設計の要点】
 *   - metric_key は <source>.<name> の名前空間付き。名前が似ているだけの別物を
 *     同一視しないための構造的な担保。
 *   - concept が同じでも自動的に比較可能とはみなさない。直接比較してよいのは
 *     comparability_group が明示的に一致するものだけ。
 *   - reliability に汎用の既定値を置かない。明示的に定義されたものだけが数値を持ち、
 *     それ以外は unrated。unrated は「情報としては使えるが推奨計算では重み0」。
 *   - recommendation_eligible が false の metric は Profile に載せてよいが
 *     Recommendation には使わない。observed だからといって自動投入しない。
 */
(function (root) {
    'use strict';

/* METRICS:BEGIN */
const METRIC_REGISTRY = {
    registryVersion: "1.1.0",
    metrics: [
    {"metric_key":"kovaak.score","source":"kovaak","concept":"performance","category":"session","unit":"score","data_type":"number","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"kovaak_score","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"real_export_not_validated","note":"実KovaaKファイルでの照合が未了。検証まで本番Recommendationの重みは0として扱う。"},"normalization_method":"none","description":"KovaaKのシナリオ内スコア。シナリオ間で比較可能な絶対値ではない。"},
    {"metric_key":"kovaak.kills","source":"kovaak","concept":"performance","category":"session","unit":"count","data_type":"integer","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"kovaak_kills","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"real_export_not_validated","note":"実KovaaKファイルでの照合が未了。検証まで本番Recommendationの重みは0として扱う。"},"normalization_method":"none","description":"ラン内のキル数。"},
    {"metric_key":"kovaak.deaths","source":"kovaak","concept":"performance","category":"session","unit":"count","data_type":"integer","higher_is_better":false,"layer":"normalized","metric_version":"1","comparability_group":"kovaak_deaths","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"real_export_not_validated","note":"実KovaaKファイルでの照合が未了。検証まで本番Recommendationの重みは0として扱う。"},"normalization_method":"none","description":"ラン内のデス数。"},
    {"metric_key":"kovaak.fight_time","source":"kovaak","concept":"context","category":"session","unit":"s","data_type":"number","higher_is_better":null,"layer":"normalized","metric_version":"1","comparability_group":"kovaak_fight_time","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"real_export_not_validated","note":"実KovaaKファイルでの照合が未了。検証まで本番Recommendationの重みは0として扱う。"},"normalization_method":"none","description":"交戦時間。長さの指標であり良し悪しではない。"},
    {"metric_key":"kovaak.hit_count","source":"kovaak","concept":"performance","category":"session","unit":"count","data_type":"integer","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"kovaak_hit_count","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"real_export_not_validated","note":"実KovaaKファイルでの照合が未了。検証まで本番Recommendationの重みは0として扱う。"},"normalization_method":"none","description":"命中数。"},
    {"metric_key":"kovaak.avg_ttk","source":"kovaak","concept":"speed","category":"session","unit":"ms","data_type":"number","higher_is_better":false,"layer":"normalized","metric_version":"1","comparability_group":"kovaak_avg_ttk","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"real_export_not_validated","note":"実KovaaKファイルでの照合が未了。検証まで本番Recommendationの重みは0として扱う。"},"normalization_method":"none","description":"平均Time To Kill。小さいほど速い。"},
    {"metric_key":"kovaak.avg_fps","source":"kovaak","concept":"environment","category":"session","unit":"fps","data_type":"number","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"kovaak_avg_fps","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"real_export_not_validated","note":"実KovaaKファイルでの照合が未了。検証まで本番Recommendationの重みは0として扱う。"},"normalization_method":"none","description":"平均FPS。環境情報であり技能指標ではない。"},
    {"metric_key":"kovaak.damage_done","source":"kovaak","concept":"performance","category":"session","unit":"damage","data_type":"number","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"kovaak_damage_done","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"real_export_not_validated","note":"実KovaaKファイルでの照合が未了。検証まで本番Recommendationの重みは0として扱う。"},"normalization_method":"none","description":"与ダメージ。"},
    {"metric_key":"kovaak.damage_taken","source":"kovaak","concept":"performance","category":"session","unit":"damage","data_type":"number","higher_is_better":false,"layer":"normalized","metric_version":"1","comparability_group":"kovaak_damage_taken","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"real_export_not_validated","note":"実KovaaKファイルでの照合が未了。検証まで本番Recommendationの重みは0として扱う。"},"normalization_method":"none","description":"被ダメージ。"},
    {"metric_key":"kovaak.midairs","source":"kovaak","concept":"precision","category":"session","unit":"count","data_type":"integer","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"kovaak_midairs","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"real_export_not_validated","note":"実KovaaKファイルでの照合が未了。検証まで本番Recommendationの重みは0として扱う。"},"normalization_method":"none","description":"空中撃ち成功数。"},
    {"metric_key":"kovaak.midaired","source":"kovaak","concept":"precision","category":"session","unit":"count","data_type":"integer","higher_is_better":false,"layer":"normalized","metric_version":"1","comparability_group":"kovaak_midaired","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"real_export_not_validated","note":"実KovaaKファイルでの照合が未了。検証まで本番Recommendationの重みは0として扱う。"},"normalization_method":"none","description":"空中撃ちされた数。"},
    {"metric_key":"kovaak.directs","source":"kovaak","concept":"precision","category":"session","unit":"count","data_type":"integer","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"kovaak_directs","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"real_export_not_validated","note":"実KovaaKファイルでの照合が未了。検証まで本番Recommendationの重みは0として扱う。"},"normalization_method":"none","description":"直撃数。"},
    {"metric_key":"kovaak.directed","source":"kovaak","concept":"precision","category":"session","unit":"count","data_type":"integer","higher_is_better":false,"layer":"normalized","metric_version":"1","comparability_group":"kovaak_directed","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"real_export_not_validated","note":"実KovaaKファイルでの照合が未了。検証まで本番Recommendationの重みは0として扱う。"},"normalization_method":"none","description":"被直撃数。"},
    {"metric_key":"kovaak.distance_traveled","source":"kovaak","concept":"context","category":"session","unit":"unit","data_type":"number","higher_is_better":null,"layer":"normalized","metric_version":"1","comparability_group":"kovaak_distance_traveled","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"real_export_not_validated","note":"実KovaaKファイルでの照合が未了。検証まで本番Recommendationの重みは0として扱う。"},"normalization_method":"none","description":"移動距離。"},
    {"metric_key":"kovaak.weapon.shots","source":"kovaak","concept":"performance","category":"weapon","unit":"count","data_type":"integer","higher_is_better":null,"layer":"normalized","metric_version":"1","comparability_group":"kovaak_weapon_shots","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"real_export_not_validated","note":"実KovaaKファイルでの照合が未了。検証まで本番Recommendationの重みは0として扱う。"},"normalization_method":"none","description":"武器ごとの発射数。"},
    {"metric_key":"kovaak.weapon.hits","source":"kovaak","concept":"performance","category":"weapon","unit":"count","data_type":"integer","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"kovaak_weapon_hits","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"real_export_not_validated","note":"実KovaaKファイルでの照合が未了。検証まで本番Recommendationの重みは0として扱う。"},"normalization_method":"none","description":"武器ごとの命中数。"},
    {"metric_key":"kovaak.weapon.damage_done","source":"kovaak","concept":"performance","category":"weapon","unit":"damage","data_type":"number","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"kovaak_weapon_damage_done","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"real_export_not_validated","note":"実KovaaKファイルでの照合が未了。検証まで本番Recommendationの重みは0として扱う。"},"normalization_method":"none","description":"武器ごとの与ダメージ。"},
    {"metric_key":"kovaak.weapon.damage_possible","source":"kovaak","concept":"context","category":"weapon","unit":"damage","data_type":"number","higher_is_better":null,"layer":"normalized","metric_version":"1","comparability_group":"kovaak_weapon_damage_possible","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"real_export_not_validated","note":"実KovaaKファイルでの照合が未了。検証まで本番Recommendationの重みは0として扱う。"},"normalization_method":"none","description":"武器ごとの最大可能ダメージ。"},
    {"metric_key":"manual.dpi","source":"manual","concept":"measurement_condition","category":"session","unit":"dpi","data_type":"integer","higher_is_better":null,"layer":"normalized","metric_version":"1","comparability_group":"condition_dpi","recommendation_eligible":false,"reliability_policy":{"status":"rated","value":0.9,"collection_method":"device_setting_readback","rating_scope":"metric_source_collection_method","rated_at":"2026-09-04","basis":"マウス設定の読み取り。取り違えは起こりうるが記憶依存ではない。","note":"測定条件であり性能指標ではないため recommendation_eligible は false。条件の同定に使う。"},"normalization_method":"none","description":"ユーザーが明示入力したマウスDPI。測定条件であって性能指標ではない。"},
    {"metric_key":"manual.cm360","source":"manual","concept":"measurement_condition","category":"session","unit":"cm_per_360","data_type":"number","higher_is_better":null,"layer":"normalized","metric_version":"1","comparability_group":"condition_cm360","recommendation_eligible":false,"reliability_policy":{"status":"rated","value":0.9,"collection_method":"explicit_user_input","rating_scope":"metric_source_collection_method","rated_at":"2026-09-04","basis":"本人が意図して設定した値。感度水準の同定に使える事実情報。"},"normalization_method":"none","description":"ユーザーが明示入力した cm/360。感度水準の判定に使ってよい系統。"},
    {"metric_key":"manual.in_game_sens","source":"manual","concept":"measurement_condition","category":"session","unit":"sens","data_type":"number","higher_is_better":null,"layer":"normalized","metric_version":"1","comparability_group":"condition_in_game_sens","recommendation_eligible":false,"reliability_policy":{"status":"rated","value":0.85,"collection_method":"device_setting_readback","rating_scope":"metric_source_collection_method","rated_at":"2026-09-04","basis":"ゲーム設定画面からの読み取り。タイトルごとの単位差に注意が要る。"},"normalization_method":"none","description":"ユーザーが明示入力したゲーム内感度。"},
    {"metric_key":"manual.input_device","source":"manual","concept":"measurement_condition","category":"session","unit":"label","data_type":"string","higher_is_better":null,"layer":"normalized","metric_version":"1","comparability_group":"condition_input_device","recommendation_eligible":false,"reliability_policy":{"status":"rated","value":0.95,"collection_method":"explicit_user_input","rating_scope":"metric_source_collection_method","rated_at":"2026-09-04","basis":"取り違えの余地がほぼ無い。"},"normalization_method":"none","description":"入力デバイス（マウス／PAD等）。PADは別モデルとするため必須の条件。"},
    {"metric_key":"manual.benchmark_score","source":"manual","concept":"performance","category":"session","unit":"score","data_type":"number","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"manual_benchmark_score","recommendation_eligible":true,"reliability_policy":{"status":"rated","value":0.55,"collection_method":"screen_transcribed","rating_scope":"metric_source_collection_method","rated_at":"2026-09-04","basis":"画面表示の書き写し。転記ミスはありうるが記憶依存ではない。","by_collection_method":{"screen_transcribed":0.55,"recalled":0.2}},"normalization_method":"none","description":"画面に表示されたベンチマークスコアをユーザーが書き写したもの。"},
    {"metric_key":"manual.accuracy_transcribed","source":"manual","concept":"accuracy","category":"session","unit":"percent","data_type":"number","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"manual_accuracy","recommendation_eligible":true,"reliability_policy":{"status":"rated","value":0.5,"collection_method":"screen_transcribed","rating_scope":"metric_source_collection_method","rated_at":"2026-09-04","basis":"書き写し。丸めや読み違いが混じりやすい。","by_collection_method":{"screen_transcribed":0.5,"recalled":0.15}},"normalization_method":"percent_0_100","description":"画面表示の命中率をユーザーが書き写したもの。"},
    {"metric_key":"manual.recalled_score","source":"manual","concept":"performance","category":"session","unit":"score","data_type":"number","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"manual_benchmark_score","recommendation_eligible":false,"reliability_policy":{"status":"rated","value":0.2,"collection_method":"recalled","rating_scope":"metric_source_collection_method","rated_at":"2026-09-04","basis":"記憶に頼った申告。良かった回だけ覚えている自己選択バイアスが乗る。","note":"同じ manual でも書き写しとは別扱い。既定では推奨に使わない。"},"normalization_method":"none","description":"記憶に基づくスコア申告。"},
    {"metric_key":"manual.self_rating","source":"manual","concept":"subjective","category":"session","unit":"rating","data_type":"integer","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"manual_self_rating","recommendation_eligible":false,"reliability_policy":{"status":"rated","value":0.15,"collection_method":"subjective_rating","rating_scope":"metric_source_collection_method","rated_at":"2026-09-04","basis":"主観。客観測定値と別管理し、推奨の重みには使わない。"},"normalization_method":"none","description":"本人の主観的なしっくり度。客観測定値とは別に管理する。"}
    ]
};
/* METRICS:END */

    var byKey = {};
    (METRIC_REGISTRY.metrics || []).forEach(function (m) {
        byKey[m.metric_key] = m;
    });

    /** 未登録キーは null を返す。呼び出し側で「未登録」として扱う。 */
    function get(metricKey) {
        return byKey[metricKey] || null;
    }

    /**
     * 直接比較してよいか。
     * concept や名前の類似では判定しない。comparability_group の一致のみ。
     */
    function isComparable(keyA, keyB) {
        var a = get(keyA), b = get(keyB);
        if (!a || !b) return false;
        if (!a.comparability_group || !b.comparability_group) return false;
        if (a.metric_version !== b.metric_version) return false;
        return a.comparability_group === b.comparability_group;
    }

    /**
     * reliability の解決。
     * **汎用の既定値を返さない。** 未登録・未評価は unrated を返す。
     * @returns {{status:'rated'|'unrated', value:number|null, reason:string|null}}
     */
    function resolveReliability(metricKey, collectionMethod) {
        var m = get(metricKey);
        if (!m) {
            return {
                status: 'unrated', value: null, reason: 'metric_not_registered',
                collectionMethod: collectionMethod || null, ratingScope: null
            };
        }
        var p = m.reliability_policy || {};
        if (p.status !== 'rated' || typeof p.value !== 'number') {
            return {
                status: 'unrated', value: null, reason: p.reason || 'not_rated',
                collectionMethod: collectionMethod || p.collection_method || null,
                ratingScope: p.rating_scope || null
            };
        }

        // metric × source × collection_method で解決する。
        // source が同じというだけで同じ信頼度を与えない。
        var method = collectionMethod || p.collection_method || null;
        var value = p.value;
        var resolvedBy = 'metric_default';

        if (collectionMethod && p.by_collection_method
            && typeof p.by_collection_method[collectionMethod] === 'number') {
            value = p.by_collection_method[collectionMethod];
            resolvedBy = 'collection_method';
        } else if (collectionMethod && p.collection_method && collectionMethod !== p.collection_method) {
            // 登録されていない収集方法。推測で既定値を当てはめない。
            return {
                status: 'unrated', value: null,
                reason: 'collection_method_not_rated:' + collectionMethod,
                collectionMethod: collectionMethod, ratingScope: p.rating_scope || null
            };
        }

        return {
            status: 'rated', value: value, reason: p.basis || null,
            collectionMethod: method, ratingScope: p.rating_scope || null,
            resolvedBy: resolvedBy
        };
    }

    /** Recommendation に使ってよいか。未登録は false。 */
    function isRecommendationEligible(metricKey, collectionMethod) {
        var m = get(metricKey);
        if (!m) return false;
        if (m.recommendation_eligible !== true) return false;
        // rated でなければ eligible にしない（二重の安全策）
        return resolveReliability(metricKey, collectionMethod).status === 'rated';
    }

    /**
     * 推奨計算に使う重み。
     * **unrated は 0。** 「情報が存在する」ことと「推奨計算に信用して使える」ことを分ける。
     */
    function recommendationWeight(metricKey, collectionMethod) {
        if (!isRecommendationEligible(metricKey, collectionMethod)) return 0;
        var r = resolveReliability(metricKey, collectionMethod);
        return r.status === 'rated' ? r.value : 0;
    }

    root.LC_METRICS = {
        registryVersion: METRIC_REGISTRY.registryVersion,
        all: METRIC_REGISTRY.metrics,
        get: get,
        isComparable: isComparable,
        resolveReliability: resolveReliability,
        isRecommendationEligible: isRecommendationEligible,
        recommendationWeight: recommendationWeight
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
