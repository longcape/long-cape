# -*- coding: utf-8 -*-
"""index.html（JS）と sensitivity_model.py（Python）の一致を検証する。

この 2 つは同一の関数形を共有しなければならず、片方だけ変わると学習が破綻する。
`tests/baseline.csv`（JS 側の出力を固定したもの）を正解データとして、
Python 側の forward_sens が同じ値を返すかを突き合わせる。

加えて、逆算（invert_to_subtotal）の往復精度も確認する。

    python tests/cross_check.py

前提: 先に `node tests/regression.mjs --update` などで baseline.csv が
      最新の JS 実装から生成されていること。
"""

import csv
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sensitivity_model import (  # noqa: E402
    DEFAULT_SCALE,
    GAMES,
    forward_sens,
    forward_sens_detail,
    invert_to_subtotal,
    is_log_transform,
    js_round,
)

HERE = os.path.dirname(os.path.abspath(__file__))
BASELINE = os.path.join(HERE, "baseline.csv")

# index.html の dynamicConfig フォールバック値と一致させること。
# （app_config が未取得のときにフロントが使う既定値）
BASE_EDPI = 230.0
HEIGHT_FACTOR = 0.005
NEURO = {"1": 0.25, "2": 0.10, "3": 0.00, "4": -0.08, "5": -0.16}
ARM = {"slim": -0.04, "normal": 0.00, "heavy": 0.05}
WEIGHT = {"ultra": -0.04, "standard": 0.00, "mid": 0.025, "heavy": 0.06, "ultraheavy": 0.10}
PIVOT = {"wrist": 0.40, "arm": 0.00, "shoulder": -0.12}


def sub_total(height, dexterity, arm, weight, pivot):
    """index.html の subTotal と同じ式。"""
    body = (170.0 - height) * HEIGHT_FACTOR
    return BASE_EDPI * (1 + body + NEURO[dexterity] + ARM[arm] + WEIGHT[weight] + PIVOT[pivot])


def to_stored_string(value, game):
    """index.html の sensToNumericString と同じ丸め・文字列化。"""
    if is_log_transform(game):
        return str(js_round(value))
    rounded = js_round(value * 1000) / 1000
    # JS の String(Number) は整数なら小数点以下を出さない
    return str(int(rounded)) if rounded == int(rounded) else str(rounded)


def main():
    if not os.path.exists(BASELINE):
        print("❌ tests/baseline.csv がありません。先に node tests/regression.mjs --update を実行してください。")
        return 1

    mismatches = []
    checked = 0
    with open(BASELINE, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            game = row["game"]
            dpi = float(row["dpi"]) if row["dpi"] else 800.0
            # index.html は 0 以下・空欄の DPI を 800 にフォールバックする
            if dpi <= 0:
                dpi = 800.0

            st = sub_total(
                float(row["height"]), row["dexterity"], row["arm"], row["weight"], row["pivot"]
            )
            got = forward_sens(st, dpi, game, DEFAULT_SCALE[game], 1.0)
            expected = row["final_sens"]
            actual = to_stored_string(got, game)

            checked += 1
            if actual != expected:
                mismatches.append((row, expected, actual))

    if mismatches:
        print(f"❌ JS と Python の計算結果が {len(mismatches)} 件一致しません（検査 {checked} 件）")
        for row, expected, actual in mismatches[:15]:
            print(
                f"   {row['game']} h={row['height']} dex={row['dexterity']} "
                f"arm={row['arm']} w={row['weight']} p={row['pivot']} dpi={row['dpi']}"
                f" → JS={expected} / Python={actual}"
            )
        if len(mismatches) > 15:
            print(f"   ... 他 {len(mismatches) - 15} 件")
        return 1

    print(f"✅ JS と Python の計算結果が一致: {checked} 件")

    # 逆算の往復精度（forward → invert が元の subTotal に戻るか）
    #
    # PUBG のように感度が 1〜100 の整数に制限されるタイトルでは、範囲外の subTotal が
    # 端へクランプされる。クランプされた点は情報が落ちており原理的に元へ戻せないため、
    # 精度判定からは除外し、件数だけ報告する（モデルの不具合ではない）。
    worst = 0.0
    worst_where = None
    worst_clamped = 0.0
    clamped_count = 0
    checked_rt = 0

    for game in GAMES:
        for st in (120.0, 178.25, 230.0, 300.0, 420.0):
            for dpi in (400.0, 800.0, 1600.0):
                sens, clamped = forward_sens_detail(st, dpi, game, DEFAULT_SCALE[game], 1.0)
                if sens <= 0:
                    continue
                back = invert_to_subtotal(sens, dpi, game, DEFAULT_SCALE[game], 1.0)
                err = abs(back - st) / st
                if clamped:
                    clamped_count += 1
                    worst_clamped = max(worst_clamped, err)
                    continue
                checked_rt += 1
                if err > worst:
                    worst, worst_where = err, (game, st, dpi)

    print(
        f"✅ 逆算の往復誤差 最大 {worst * 100:.3f}%"
        f"（{worst_where[0]} subTotal={worst_where[1]} dpi={worst_where[2]} / 検査 {checked_rt} 点）"
    )
    if clamped_count:
        print(
            f"ℹ️ 表現範囲外でクランプされた {clamped_count} 点は精度判定から除外"
            f"（その中の最大往復誤差 {worst_clamped * 100:.1f}%。仕様上の想定内）"
        )

    # 感度を整数で表現するタイトルは 1 段階あたり約 2.8% 動くため、往復誤差は
    # 原理的に最大 ±1.4% 程度出る。実測 1.3% に対し、余裕をみて 5% を上限とする。
    if worst > 0.05:
        print("❌ 往復誤差が 5% を超えています。invert_to_subtotal を確認してください。")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
