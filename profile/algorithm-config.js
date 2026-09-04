/**
 * Algorithm Config — 再推定の重みと閾値
 * =====================================
 *
 * 正本はリポジトリ直下の algorithm-config.json。ここは静的サイト用の埋め込みコピーで、
 * `node tools/sync-algorithm-config.mjs` が自動生成する。手で編集しないこと。
 *
 * 【algorithm_version と config_version の分離】
 *   algorithm_version … 計算の手順そのものの版（コード側 semver）
 *   config_version    … 重み・閾値の版（このファイル）
 *   重みを変えただけなら algorithm_version は動かず config_version だけが変わる。
 *   Recommendation はこの2つを別々に記録するため、「なぜ推奨が変わったか」を
 *   アルゴリズム変更と設定変更に切り分けて説明できる。
 */
(function (root) {
    'use strict';

/* ALGO_CONFIG:BEGIN */
const ALGORITHM_CONFIG = {
    "_readme": [
        "再推定アルゴリズムの設定の正本。コードへ固定しないための外出し。",
        "algorithm_version（コード側の semver）と config_version（このファイル）は別物。",
        "重みや閾値だけを変えた場合は algorithm_version は動かず config_version だけが変わる。",
        "変更したら node tools/sync-algorithm-config.mjs を実行し、CI の --check を通すこと。",
        "ここにある値はすべて prototype 値であり、本番確定値ではない。"
    ],
    "config_version": "1.0.0",
    "factorWeights": {
        "_note": "利用できない factor は重みごと除外して再正規化する。0点として罰しない。",
        "performance": 0.45,
        "stability": 0.25,
        "repeatability": 0.2,
        "recency": 0.1
    },
    "gates": {
        "_note": "推奨を出す最低条件。source や測定プロトコルによって将来変更できるよう設定値化している。",
        "minSensitivityLevels": 3,
        "minSessionsPerLevel": 2,
        "minTotalSessions": 6
    },
    "range": {
        "_definition": "rangeCompositeScoreTolerance は『合成スコアの絶対差』である。合成スコアは0〜1へ正規化済みなので、0.05 は合成スコアで0.05ポイント分の差を意味する。感度(cm)の5%でも、生スコアの5%でも、パーセンテージでもない。",
        "rangeCompositeScoreTolerance": 0.05
    },
    "normalization": {
        "_note": "変動係数(CV)を0〜1へ写すときの上限。CVがこの値以上なら安定性スコア0とする。",
        "stabilityCvCeiling": 0.3,
        "repeatabilityCvCeiling": 0.3
    },
    "recency": {
        "halfLifeDays": 30
    },
    "edgeOptimum": {
        "_note": "最良点が測定範囲の端にある場合、真の最適が範囲外にある可能性がある。confidence を下げ、範囲外の測定を促す。",
        "confidencePenalty": 0.7,
        "suggestOutwardStep": true
    },
    "nextBestTest": {
        "_note": "次にどの感度を何回試すべきかの提案。現時点では設計と最小実装のみで production 機能ではない。",
        "enabled": true,
        "defaultRecommendedSessions": 3,
        "closeContestCompositeGap": 0.05
    }
};
/* ALGO_CONFIG:END */

    root.LC_ALGO_CONFIG = ALGORITHM_CONFIG;
})(typeof globalThis !== 'undefined' ? globalThis : this);
