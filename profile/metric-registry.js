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
    registryVersion: "1.5.0",
    metrics: [
    {"metric_key":"kovaak.score","source":"kovaak","concept":"performance","category":"session","unit":"score","data_type":"number","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.score.same_scenario","recommendation_eligible":true,"reliability_policy":{"status":"rated","axes":{"measurement":{"value":0.95,"basis":"ゲームが export に直接書き出す値。実 export 4件すべてで欠損なく取得できた。","value_status":"prototype"},"semantic":{"value":0.9,"basis":"シナリオ公式の総合スコア。同一シナリオ内での意味は明確だが、算出式が非公開で内訳を検証できない。","value_status":"prototype"},"comparability":{"value":0.9,"basis":"同一 scenario_identity かつ同一 context_group 内に限る。感度最適化にどこまで有効かは Closed Beta の検証待ちであり、その不確実性はこの軸で表す。","value_status":"prototype"},"provenance_integrity":{"value":0.95,"basis":"実 KovaaK 3.9.x が生成したローカル実ファイルで、schema validation を通過し、未知 field 0、SHA-256 の provenance を保持し、実設定と複数 run で照合済み。したがって「この値が KovaaK export 由来である」ことの確からしさは高い。手で編集されうる余地が残るため 1.0 にはしない。","value_status":"prototype"}},"effective_reliability":{"derived":true,"policy":"conservative_min_v1","formula":"min(axes[*].value)","note":"派生値であり正本ではない。正本は axes。将来 hard gate / geometric mean / calibrated mapping / metric 別 policy へ変更できるよう、policy 名で切り替える。","computed_at":"runtime"},"rating_scope":"metric_source_collection_method_comparison_scope","collection_method":"file_import_kovaak_stats_csv","comparison_scope":"same_scenario","out_of_scope":{"cross_scenario":{"usable":false,"comparability":0.1,"reason":"シナリオごとにスコア尺度が違う。実測で 1892.0 / 149.947754 / 230.0 / 240.0 と桁が異なった。","note":"異シナリオの Raw Score を直接比較してはいけない。統合には正規化が要るが baseline が無いので今は作らない。"}},"rated_at":"2026-09-05","basis":"G-1 の実 export 4件（KovaaK 3.9.8）で値・単位・意味を確認し、G-2 レビューで承認された。","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":true,"3_unit_confirmed":true,"4_normalization_confirmed":true,"5_reliability_policy_set":true}},"normalization_method":"none","description":"KovaaKのシナリオ内スコア。**同一 scenario_identity + 同一 context_group + non-adaptive のスコープ内でのみ比較可**。シナリオ間で比較可能な絶対値ではない。"},
    {"metric_key":"kovaak.kills","source":"kovaak","concept":"performance","category":"session","unit":"count","data_type":"integer","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.kills.same_scenario","recommendation_eligible":false,"reliability_policy":{"status":"rated","axes":{"measurement":{"value":0.95,"basis":"ゲームが export に直接書き出す整数。実 export 4件で取得できた。","value_status":"prototype"},"semantic":{"value":0.95,"basis":"キル数。定義が明確で解釈の余地がない。","value_status":"prototype"},"comparability":{"value":0.85,"basis":"同一シナリオならシナリオ長が定数なのでレート化なしで比較できる。異シナリオでは長さも難易度も違う。","value_status":"prototype"},"provenance_integrity":{"value":0.95,"basis":"実 KovaaK 3.9.x が生成したローカル実ファイルで、schema validation を通過し、未知 field 0、SHA-256 の provenance を保持し、実設定と複数 run で照合済み。したがって「この値が KovaaK export 由来である」ことの確からしさは高い。手で編集されうる余地が残るため 1.0 にはしない。","value_status":"prototype"}},"effective_reliability":{"derived":true,"policy":"conservative_min_v1","formula":"min(axes[*].value)","note":"派生値であり正本ではない。正本は axes。将来 hard gate / geometric mean / calibrated mapping / metric 別 policy へ変更できるよう、policy 名で切り替える。","computed_at":"runtime"},"rating_scope":"metric_source_collection_method_comparison_scope","collection_method":"file_import_kovaak_stats_csv","comparison_scope":"same_scenario","out_of_scope":{"cross_scenario":{"usable":false,"comparability":0.1,"reason":"シナリオ長と難易度が違うためキル数を直接比較できない。"}},"rated_at":"2026-09-05","basis":"G-1 の実 export 4件（KovaaK 3.9.8）で値・単位・意味を確認し、G-2 レビューで承認された。","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":true,"3_unit_confirmed":true,"4_normalization_confirmed":true,"5_reliability_policy_set":true},"recommendation_hold":{"held":true,"reason":"score_correlation_unverified","verification_required":["correlation","incremental_predictive_value","scenario_type","confirmation_performance"],"note":"Score と情報が重複する可能性が高い。上記4点を検証するまで Recommendation へ投入しない。二重計上を防ぐため。"}},"normalization_method":"none","description":"シナリオ内のキル数。**同一 scenario_identity 内でのみ比較可**。rated だが Recommendation 投入は保留。"},
    {"metric_key":"kovaak.deaths","source":"kovaak","concept":"performance","category":"session","unit":"count","data_type":"integer","higher_is_better":false,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.deaths.same_scenario","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"ラン内のデス数。"},
    {"metric_key":"kovaak.fight_time","source":"kovaak","concept":"context","category":"session","unit":"s","data_type":"number","higher_is_better":null,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.fight_time.condition","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false},"usage_prohibition":{"as_session_duration":"prohibited","as_rate_denominator":"prohibited","reason":"equals_sum_of_kill_ttk_not_elapsed_time","evidence":"実 export 4件で Kill 行 TTK の合計と一致した（33.696 / 46.130 / 24.532 / 31.292）。すべて60秒シナリオだが値は 24.5〜46.1 秒とばらついた。","note":"**session duration として使用禁止。** rate metric の分母にしてはいけない。意味を拡大解釈せず KovaaK 固有 field として保持する。"}},"normalization_method":"none","description":"KovaaK フッターの Fight Time。**Kill 行 TTK の合計であり、セッションの経過時間ではない。**session duration や rate metric の分母に使ってはいけない。"},
    {"metric_key":"kovaak.hit_count","source":"kovaak","concept":"performance","category":"session","unit":"count","data_type":"integer","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.hit_count.same_scenario","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"命中数。"},
    {"metric_key":"kovaak.accuracy","source":"kovaak","concept":"precision","category":"session","unit":"ratio","data_type":"number","higher_is_better":true,"layer":"derived","metric_version":"1","comparability_group":"kovaak.accuracy.same_scenario","recommendation_eligible":false,"reliability_policy":{"status":"rated","axes":{"measurement":{"value":0.95,"basis":"元になる Hit Count と Shots はどちらもファイル由来。実 export 4件で Hits+Miss=Shots の整合を確認した。","value_status":"prototype"},"semantic":{"value":0.95,"basis":"hits / shots。定義が明確で解釈の余地がない。","value_status":"prototype"},"comparability":{"value":0.75,"basis":"ratio なのでシナリオ横断でも意味は保たれるが、要求される精度がシナリオごとに違うため初期は同一 scenario_identity 内に限定する。","value_status":"prototype"},"provenance_integrity":{"value":0.95,"basis":"実 KovaaK 3.9.x が生成したローカル実ファイルで、schema validation を通過し、未知 field 0、SHA-256 の provenance を保持し、実設定と複数 run で照合済み。したがって「この値が KovaaK export 由来である」ことの確からしさは高い。手で編集されうる余地が残るため 1.0 にはしない。","value_status":"prototype"}},"effective_reliability":{"derived":true,"policy":"conservative_min_v1","formula":"min(axes[*].value)","note":"派生値であり正本ではない。正本は axes。将来 hard gate / geometric mean / calibrated mapping / metric 別 policy へ変更できるよう、policy 名で切り替える。","computed_at":"runtime"},"rating_scope":"metric_source_collection_method_comparison_scope","collection_method":"file_import_kovaak_stats_csv","comparison_scope":"same_scenario","out_of_scope":{"cross_scenario":{"usable":false,"comparability":0.4,"reason":"尺度の問題は無いが、シナリオごとに要求精度が違う。初期は限定する。"}},"rated_at":"2026-09-05","basis":"G-1 の実 export 4件（KovaaK 3.9.8）で値・単位・意味を確認し、G-2 レビューで承認された。","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":true,"3_unit_confirmed":true,"4_normalization_confirmed":true,"5_reliability_policy_set":true},"recommendation_hold":{"held":true,"reason":"score_correlation_unverified","verification_required":["correlation","incremental_predictive_value","scenario_type","confirmation_performance"],"note":"Score と独立な軸に見えるが未検証。hit_count 経由で Score とも関係しうる。4点の検証まで投入しない。"}},"normalization_method":"ratio_hits_over_shots","derived_from":["kovaak.hit_count","kovaak.weapon.shots"],"granularity":"session","description":"**Long Cape が導出する session-level の命中率**（Hit Count ÷ Shots）。KovaaK のフッターにセッション全体の Accuracy 項目は存在しないため、これは Long Cape 側の導出値である。**kill-level の `kovaak.kill_accuracy` とは粒度が違う別 metric。値が一致しても片方を削除・上書きしない。**"},
    {"metric_key":"kovaak.kill_accuracy","source":"kovaak","concept":"precision","category":"kill","unit":"ratio","data_type":"number","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.kill_accuracy.kill_level","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"session_aggregation_method_undecided","note":"KovaaK 公式の kill-level Accuracy。実 export 4件で Hits/Shots と一致することを確認済み（最大差 4.9e-7）。ただしセッション代表値への集約方法（平均か中央値か）が未定のため unrated。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":true,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","granularity":"kill","description":"**KovaaK 公式の kill-level 命中率**（Kill 行の Accuracy 列、0〜1）。**session-level の `kovaak.accuracy` とは粒度が違う別 metric。値が一致しても片方を削除・上書きしない。**"},
    {"metric_key":"kovaak.avg_ttk","source":"kovaak","concept":"speed","category":"session","unit":"s","data_type":"number","higher_is_better":false,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.avg_ttk.unresolved","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false},"usage_prohibition":{"recommendation":"prohibited","derived_calculation":"prohibited","reason":"collinear_with_kills_and_formula_unconfirmed","evidence":"実 export 4件で Kills × Avg TTK = 59.739 / 59.992 / 59.994 / 59.990 となりシナリオ長にほぼ一致した。TTK 列の平均とは一致しない（1.296 対 2.297666 等）。","note":"**一般的な TTK 概念と同一視しない。** Kills と独立した性能軸として扱う根拠が無いため、Recommendation にも Derived 計算にも使わない。Raw / provenance としては保持する。"}},"normalization_method":"none","description":"KovaaK フッターの Avg TTK。**Kill 行 TTK の平均ではない。** Kills とほぼ共線であり、意味が確定するまで Recommendation にも Derived 計算にも使わない。"},
    {"metric_key":"kovaak.avg_fps","source":"kovaak","concept":"environment","category":"session","unit":"fps","data_type":"number","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.avg_fps.condition","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"平均FPS。環境情報であり技能指標ではない。"},
    {"metric_key":"kovaak.damage_done","source":"kovaak","concept":"performance","category":"session","unit":"damage","data_type":"number","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.damage_done.same_scenario","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"与ダメージ。"},
    {"metric_key":"kovaak.damage_taken","source":"kovaak","concept":"performance","category":"session","unit":"damage","data_type":"number","higher_is_better":false,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.damage_taken.same_scenario","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"被ダメージ。"},
    {"metric_key":"kovaak.midairs","source":"kovaak","concept":"precision","category":"session","unit":"count","data_type":"integer","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.midairs.same_scenario","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"空中撃ち成功数。"},
    {"metric_key":"kovaak.midaired","source":"kovaak","concept":"precision","category":"session","unit":"count","data_type":"integer","higher_is_better":false,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.midaired.same_scenario","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"空中撃ちされた数。"},
    {"metric_key":"kovaak.directs","source":"kovaak","concept":"precision","category":"session","unit":"count","data_type":"integer","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.directs.same_scenario","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"直撃数。"},
    {"metric_key":"kovaak.directed","source":"kovaak","concept":"precision","category":"session","unit":"count","data_type":"integer","higher_is_better":false,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.directed.same_scenario","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"被直撃数。"},
    {"metric_key":"kovaak.distance_traveled","source":"kovaak","concept":"context","category":"session","unit":"unit","data_type":"number","higher_is_better":null,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.distance_traveled.condition","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"移動距離。"},
    {"metric_key":"kovaak.weapon.shots","source":"kovaak","concept":"performance","category":"weapon","unit":"count","data_type":"integer","higher_is_better":null,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.weapon.shots.same_scenario","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"武器ごとの発射数。"},
    {"metric_key":"kovaak.weapon.hits","source":"kovaak","concept":"performance","category":"weapon","unit":"count","data_type":"integer","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.weapon.hits.same_scenario","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"武器ごとの命中数。"},
    {"metric_key":"kovaak.weapon.damage_done","source":"kovaak","concept":"performance","category":"weapon","unit":"damage","data_type":"number","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.weapon.damage_done.same_scenario","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"武器ごとの与ダメージ。"},
    {"metric_key":"kovaak.weapon.damage_possible","source":"kovaak","concept":"context","category":"weapon","unit":"damage","data_type":"number","higher_is_better":null,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.weapon.damage_possible.condition","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"武器ごとの最大可能ダメージ。"},
    {"metric_key":"manual.dpi","source":"manual","concept":"measurement_condition","category":"session","unit":"dpi","data_type":"integer","higher_is_better":null,"layer":"normalized","metric_version":"1","comparability_group":"condition_dpi","recommendation_eligible":false,"reliability_policy":{"status":"rated","value":0.9,"collection_method":"device_setting_readback","rating_scope":"metric_source_collection_method","rated_at":"2026-09-04","basis":"ユーザーがマウス設定を読み取って入力した値。KovaaKのDPI欄と違い、実機の値として申告されたもの。","note":"測定条件であり性能指標ではないため recommendation_eligible は false。条件の同定に使う。"},"normalization_method":"none","description":"ユーザーが明示入力したマウスDPI。**KovaaKファイル内のDPI欄とは別物**として扱う。ファイル側はKovaaKの表示用設定であり実機と食い違いうる（実測で ファイル400 / 実機800 の食い違いを確認）。"},
    {"metric_key":"manual.cm360","source":"manual","concept":"measurement_condition","category":"session","unit":"cm_per_360","data_type":"number","higher_is_better":null,"layer":"normalized","metric_version":"1","comparability_group":"condition_cm360","recommendation_eligible":false,"reliability_policy":{"status":"rated","value":0.9,"collection_method":"explicit_user_input","rating_scope":"metric_source_collection_method","rated_at":"2026-09-04","basis":"本人が意図して設定した値。感度水準の同定に使える事実情報。"},"normalization_method":"none","description":"ユーザーが明示入力した cm/360。感度水準の判定に使ってよい系統。"},
    {"metric_key":"manual.in_game_sens","source":"manual","concept":"measurement_condition","category":"session","unit":"sens","data_type":"number","higher_is_better":null,"layer":"normalized","metric_version":"1","comparability_group":"condition_in_game_sens","recommendation_eligible":false,"reliability_policy":{"status":"rated","value":0.85,"collection_method":"device_setting_readback","rating_scope":"metric_source_collection_method","rated_at":"2026-09-04","basis":"ゲーム設定画面からの読み取り。タイトルごとの単位差に注意が要る。"},"normalization_method":"none","description":"ユーザーが明示入力したゲーム内感度。"},
    {"metric_key":"manual.input_device","source":"manual","concept":"measurement_condition","category":"session","unit":"label","data_type":"string","higher_is_better":null,"layer":"normalized","metric_version":"1","comparability_group":"condition_input_device","recommendation_eligible":false,"reliability_policy":{"status":"rated","value":0.95,"collection_method":"explicit_user_input","rating_scope":"metric_source_collection_method","rated_at":"2026-09-04","basis":"取り違えの余地がほぼ無い。"},"normalization_method":"none","description":"入力デバイス（マウス／PAD等）。PADは別モデルとするため必須の条件。"},
    {"metric_key":"manual.benchmark_score","source":"manual","concept":"performance","category":"session","unit":"score","data_type":"number","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"manual_benchmark_score","recommendation_eligible":true,"reliability_policy":{"status":"rated","value":0.55,"collection_method":"screen_transcribed","rating_scope":"metric_source_collection_method","rated_at":"2026-09-04","basis":"画面表示の書き写し。転記ミスはありうるが記憶依存ではない。","by_collection_method":{"screen_transcribed":0.55,"recalled":0.2}},"normalization_method":"none","description":"画面に表示されたベンチマークスコアをユーザーが書き写したもの。"},
    {"metric_key":"manual.accuracy_transcribed","source":"manual","concept":"accuracy","category":"session","unit":"percent","data_type":"number","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"manual_accuracy","recommendation_eligible":true,"reliability_policy":{"status":"rated","value":0.5,"collection_method":"screen_transcribed","rating_scope":"metric_source_collection_method","rated_at":"2026-09-04","basis":"書き写し。丸めや読み違いが混じりやすい。","by_collection_method":{"screen_transcribed":0.5,"recalled":0.15}},"normalization_method":"percent_0_100","description":"画面表示の命中率をユーザーが書き写したもの。"},
    {"metric_key":"manual.recalled_score","source":"manual","concept":"performance","category":"session","unit":"score","data_type":"number","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"manual_benchmark_score","recommendation_eligible":false,"reliability_policy":{"status":"rated","value":0.2,"collection_method":"recalled","rating_scope":"metric_source_collection_method","rated_at":"2026-09-04","basis":"記憶に頼った申告。良かった回だけ覚えている自己選択バイアスが乗る。","note":"同じ manual でも書き写しとは別扱い。既定では推奨に使わない。"},"normalization_method":"none","description":"記憶に基づくスコア申告。"},
    {"metric_key":"manual.self_rating","source":"manual","concept":"subjective","category":"session","unit":"rating","data_type":"integer","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"manual_self_rating","recommendation_eligible":false,"reliability_policy":{"status":"rated","value":0.15,"collection_method":"subjective_rating","rating_scope":"metric_source_collection_method","rated_at":"2026-09-04","basis":"主観。客観測定値と別管理し、推奨の重みには使わない。"},"normalization_method":"none","description":"本人の主観的なしっくり度。客観測定値とは別に管理する。"},
    {"metric_key":"kovaak.miss_count","source":"kovaak","concept":"performance","category":"session","unit":"count","data_type":"integer","higher_is_better":false,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.miss_count.same_scenario","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"外した回数。実ファイル 3.9.8 のフッターで確認。"},
    {"metric_key":"kovaak.total_overshots","source":"kovaak","concept":"precision","category":"session","unit":"count","data_type":"integer","higher_is_better":false,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.total_overshots.same_scenario","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"撃ちすぎの回数。"},
    {"metric_key":"kovaak.reloads","source":"kovaak","concept":"context","category":"session","unit":"count","data_type":"integer","higher_is_better":null,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.reloads.condition","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"リロード回数。"},
    {"metric_key":"kovaak.mbs_points","source":"kovaak","concept":"performance","category":"session","unit":"score","data_type":"number","higher_is_better":true,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.mbs_points.same_scenario","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"KovaaK 内のポイント。意味未確認。"},
    {"metric_key":"kovaak.time_remaining","source":"kovaak","concept":"context","category":"session","unit":"s","data_type":"number","higher_is_better":null,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.time_remaining.condition","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"シナリオの残り時間。"},
    {"metric_key":"kovaak.pause_count","source":"kovaak","concept":"context","category":"session","unit":"count","data_type":"integer","higher_is_better":null,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.pause.condition","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"一時停止した回数。実測で 2 を確認。"},
    {"metric_key":"kovaak.pause_duration","source":"kovaak","concept":"context","category":"session","unit":"s","data_type":"number","higher_is_better":null,"layer":"normalized","metric_version":"1","comparability_group":"kovaak.pause.condition","recommendation_eligible":false,"reliability_policy":{"status":"unrated","reason":"value_and_unit_confirmed_meaning_pending","note":"実ファイル4件（3.9.8）で値と単位を確認済み。意味・正規化・reliability policy が未確定のため unrated のまま。5項目すべてを満たしたものだけ G-2 で個別に rated へ変える。","value_confirmed_in_real_export":"2026-09-04 / KovaaK 3.9.8 / 実ファイル4件","staged_promotion_checks":{"1_value_confirmed":true,"2_meaning_confirmed":false,"3_unit_confirmed":true,"4_normalization_confirmed":false,"5_reliability_policy_set":false}},"normalization_method":"none","description":"一時停止の合計秒数。実測で 65 を確認。"}
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
        // rated と認めるのは、4軸を持つもの（G-2 以降の正本形式）か、
        // legacy_scalar_reliability に列挙された旧形式のどちらか。
        var hasAxes = !!p.axes;
        var hasLegacyScalar = typeof p.value === 'number';
        if (p.status !== 'rated' || (!hasAxes && !hasLegacyScalar)) {
            return {
                status: 'unrated', value: null, reason: p.reason || 'not_rated',
                collectionMethod: collectionMethod || p.collection_method || null,
                ratingScope: p.rating_scope || null
            };
        }

        // metric × source × collection_method で解決する。
        // source が同じというだけで同じ信頼度を与えない。
        var method = collectionMethod || p.collection_method || null;
        var resolvedBy = 'metric_default';

        // 【G-2】reliability の正本は axes の4軸。
        // 実効値は runtime でここで算出する派生値であり、Registry には保存しない。
        // policy を差し替えれば hard gate / geometric mean / calibrated mapping へ移行できる。
        var effective = hasAxes
            ? effectiveReliability(p.axes, p.effective_reliability)
            : { value: p.value, policy: 'legacy_scalar_v0', axesUsed: null };
        var value = effective.value;

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
            resolvedBy: resolvedBy,
            // 4軸をそのまま返す。呼び出し側が policy を変えて再計算できるようにする。
            axes: p.axes,
            effectivePolicy: effective.policy,
            comparisonScope: p.comparison_scope || null
        };
    }

    var RELIABILITY_AXES = ['measurement', 'semantic', 'comparability', 'provenance_integrity'];

    /**
     * 4軸から実効 reliability を算出する。**派生値であって正本ではない。**
     * 正本は metrics.json の axes。将来 policy を増やして切り替える。
     */
    function effectiveReliability(axes, policyDef) {
        var policy = (policyDef && policyDef.policy) || 'conservative_min_v1';
        if (!axes) return { value: null, policy: policy, reason: 'no_axes' };

        var values = [];
        for (var i = 0; i < RELIABILITY_AXES.length; i++) {
            var a = axes[RELIABILITY_AXES[i]];
            if (!a || typeof a.value !== 'number') {
                return { value: null, policy: policy, reason: 'axis_missing:' + RELIABILITY_AXES[i] };
            }
            values.push(a.value);
        }

        if (policy === 'conservative_min_v1') {
            return { value: Math.min.apply(null, values), policy: policy, axesUsed: RELIABILITY_AXES };
        }
        // 未知の policy を勝手に近似しない
        return { value: null, policy: policy, reason: 'unknown_policy' };
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
