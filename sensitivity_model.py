"""感度計算モデルの純粋関数群（Supabase に依存しない部分）。

index.html の calculateEDPI() / gameCurve() と **同一の関数形** を保つこと。
片方だけ変更すると学習が破綻するため、変更時は必ず両方を直し、
`node tests/regression.mjs` と `python tests/cross_check.py` を通すこと。

ゲームタイトルの定義はリポジトリ直下の games.json が正本。
このモジュールと index.html はどちらもそこから同じ値を読む。
"""

import json
import math
import os

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
GAMES_JSON_PATH = os.path.join(_HERE, "games.json")


def load_games(path=GAMES_JSON_PATH):
    """games.json を読み込み、key -> 定義 の辞書として返す。"""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    games = data.get("games") or []
    if not games:
        raise ValueError(f"{path} に games が定義されていません")
    return {g["key"]: g for g in games}


GAME_DEFS = load_games()

# index.html と共有する定義（games.json が正本）
GAMES = list(GAME_DEFS.keys())
DEFAULT_SCALE = {k: float(g["scale"]) for k, g in GAME_DEFS.items()}

# ダイナミクスカーブの共通パラメータ（実測ベースでFIX済み・変更禁止）
CURVE_CENTER = 178.25
CURVE_SPREAD = 50.0

# PUBG 系の対数変換パラメータ（index.html と共有）
PUBG_BASE_SENS = 0.30
PUBG_OFFSET = 50.0
PUBG_GAIN = 25.0
PUBG_RANGE = (1, 100)


def js_round(x):
    """JavaScript の Math.round と同じ丸め。

    Python 組み込みの round() は偶数丸め（round(0.5) == 0）なので、
    そのまま使うと index.html と 1 ずれる場合がある。JS は常に「.5 は切り上げ」。
    """
    return math.floor(float(x) + 0.5)


def game_curve(sub_total, game):
    """index.html の gameCurve() と同一のカーブ。"""
    curve = GAME_DEFS[game]["curve"] if game in GAME_DEFS else {"type": "constant", "value": 1.0}
    if curve["type"] == "atan":
        dev = (sub_total - CURVE_CENTER) / CURVE_SPREAD
        a = np.arctan(dev) / (np.pi / 2)
        return curve["base"] + curve["coef"] * a
    return curve["value"]


def is_log_transform(game):
    """PUBG のように対数スケールで感度を表現するタイトルか。"""
    return GAME_DEFS.get(game, {}).get("sensTransform") == "pubgLog"


def forward_sens_detail(sub_total, dpi, game, scale, trim):
    """subTotal から in-game 感度を求め、(感度, クランプされたか) を返す。

    index.html の calculateEDPI() と同じ順序で計算し、丸め（finalEDPI の round、
    PUBG の round/clamp）まで含めて再現する。

    PUBG のように表現範囲が 1〜100 の整数に限られるタイトルでは、範囲外の
    subTotal が端へ丸め込まれる。その点は原理的に逆算で元へ戻せないため、
    呼び出し側が区別できるようクランプの有無を返す。
    """
    final_edpi = js_round(sub_total * game_curve(sub_total, game) * trim)
    base_sens = final_edpi / dpi
    if is_log_transform(game):
        ratio = base_sens / PUBG_BASE_SENS
        raw = js_round(PUBG_OFFSET + PUBG_GAIN * np.log2(ratio))
        lo, hi = PUBG_RANGE
        return float(min(max(raw, lo), hi)), bool(raw < lo or raw > hi)
    return float(base_sens * scale), False


def forward_sens(sub_total, dpi, game, scale, trim):
    """subTotal から in-game 感度を求める。index.html の calculateEDPI() と同じ。"""
    return forward_sens_detail(sub_total, dpi, game, scale, trim)[0]


def invert_to_subtotal(sens, dpi, game, scale, trim):
    """観測された in-game 感度から、身体由来の基準 eDPI（subTotal）を逆算する。

    game_curve が sub_total に依存するため、不動点反復で解く（数回で十分収束する）。
    """
    if is_log_transform(game):
        # index.html: sens = clamp(round(50 + 25*log2(baseSens/0.30)))
        base_sens = PUBG_BASE_SENS * (2.0 ** ((sens - PUBG_OFFSET) / PUBG_GAIN))
        target_edpi = base_sens * dpi
    else:
        target_edpi = sens * dpi / scale

    sub = target_edpi  # 初期値（game_curve=1 と仮定）
    for _ in range(40):
        denom = game_curve(sub, game) * trim
        if denom <= 0:
            return np.nan
        nxt = target_edpi / denom
        if abs(nxt - sub) < 1e-6:
            sub = nxt
            break
        sub = nxt
    return sub
