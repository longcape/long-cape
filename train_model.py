# -*- coding: utf-8 -*-
"""
ロングケープの定理 — 係数自動学習ジョブ

calc_logs に蓄積された「ユーザーが実際に使っている感度」を教師データとして、
index.html の計算式と同じ関数形のモデルを当てはめ、app_config の係数を更新する。

設計方針
--------
1. 教師データは「ユーザー本人が申告した実使用感度」のみ。
   診断結果の保存ログ（本ツールの出力そのもの）を学習に混ぜると自己強化ループになるため除外する。
2. 学習するモデルの形は index.html の calculateEDPI() と完全に一致させる。
       subTotal = base_edpi * (1 + height_factor*(170-height)
                                 + neuro + arm + weight + pivot)
       finalEDPI = subTotal * gameCurve(subTotal) * game_trim
       inGameSens = finalEDPI / dpi * scale[game]
   観測された inGameSens を上式で逆算して subTotal（＝身体由来の基準 eDPI）に戻し、
   その subTotal を目的変数として線形モデルを当てはめる。
3. 基準カテゴリ（普通・標準・肘）の係数は 0 に固定する（app_config の意味論と一致させるため）。
4. 1 回の更新幅は ±10%（ただし 0 や負値でも正しく効くよう絶対最小ステップを併用）。
   加えて各係数に物理的にありえない値に飛ばないための絶対クランプを掛ける。
"""

import os
import sys

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from supabase import create_client

# --- 1. Supabase 接続 -------------------------------------------------------
SUPABASE_URL = "https://gmhayutirvdaesneulgr.supabase.co"
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
if not SUPABASE_KEY:
    print("❌ SUPABASE_SERVICE_ROLE_KEY が設定されていません。")
    sys.exit(1)

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

GAMES = ["valo", "apex", "ow", "fn", "delta", "cod", "pubg"]

# index.html と共有する単位変換スケール（ゲームエンジン固有の定数）
DEFAULT_SCALE = {
    "valo": 1.00,
    "apex": 3.18,
    "ow": 10.60,
    "fn": 12.60,
    "delta": 7.80,
    "cod": 10.60,
    "pubg": 1.00,  # PUBG は対数スケールのため個別処理
}

# 診断結果の保存ログ（＝本ツールの出力）に付くメモ。学習からは必ず除外する。
DIAG_OUTPUT_MEMOS = {"long cape theory", "ロングケープの定理"}
# 診断フォームの「現在の感度」から自動収集したログのメモ。
# 過去のバージョンでは "自動収集データ" という文言だったため、両方を受け付ける。
AUTO_COLLECT_MEMOS = {"自動学習収集データ", "自動収集データ"}

# カテゴリ列 -> (app_config のキー接頭辞, 基準カテゴリ)
CATEGORICALS = {
    "dexterity": ("neuro", "3"),
    "play_style": ("arm", "normal"),
    "mouse_weight": ("weight", "standard"),
    "aim_part": ("pivot", "arm"),
}
ALLOWED_LEVELS = {
    "dexterity": {"1", "2", "3", "4", "5"},
    "play_style": {"slim", "normal", "heavy"},
    "mouse_weight": {"ultra", "standard", "mid", "heavy", "ultraheavy"},
    "aim_part": {"wrist", "arm", "shoulder"},
}

# 学習を開始できる最小件数
MIN_TOTAL_FOR_ANY = 10      # これ未満なら何もしない
MIN_TOTAL_FOR_FULL = 50     # これ以上でフェーズ2（全係数学習）
MIN_ROWS_PER_LEVEL = 5      # 1 カテゴリ水準あたりの最小件数
MIN_ROWS_PER_GAME = 20      # タイトル別補正を動かす最小件数
TRIM_SHRINK_K = 40          # 件数が少ないうちは trim を 1.0 側へ縮小させる強さ

# 絶対クランプ（学習が暴走しても現実的な範囲から出さない）
ABS_BOUNDS = {
    "base_edpi": (120.0, 450.0),
    "height_factor": (0.0, 0.02),
}
FACTOR_BOUNDS = (-0.60, 0.90)
TRIM_BOUNDS = (0.70, 1.30)
EDPI_SANITY = (60.0, 800.0)  # VALORANT 基準に換算した eDPI の許容レンジ


# --- 2. 補助関数 ------------------------------------------------------------
def fetch_all(table, page_size=1000):
    """Supabase のデフォルト上限（1000件）を超えて全件取得する。"""
    rows, offset = [], 0
    while True:
        res = (
            supabase.table(table)
            .select("*")
            .order("created_at", desc=False)
            .range(offset, offset + page_size - 1)
            .execute()
        )
        chunk = res.data or []
        rows.extend(chunk)
        if len(chunk) < page_size:
            return rows
        offset += page_size


def to_number(series):
    """'0.215' / '6.50%' / ' 1.2 ' などの混在を数値化する。"""
    return pd.to_numeric(
        series.astype(str).str.replace("%", "", regex=False).str.strip(),
        errors="coerce",
    )


def game_curve(sub_total, game):
    """index.html の gameFactor と同一のカーブ。"""
    dev = (sub_total - 178.25) / 50.0
    a = np.arctan(dev) / (np.pi / 2)
    if game == "apex":
        return 1.48 - 0.25 * a
    if game == "ow":
        return 1.35 + 0.45 * a
    if game == "fn":
        return 1.30 + 0.40 * a
    if game in ("delta", "cod"):
        return 1.08
    if game == "pubg":
        return 0.90
    return 1.00


def invert_to_subtotal(sens, dpi, game, scale, trim):
    """観測された in-game 感度から、身体由来の基準 eDPI（subTotal）を逆算する。

    gameCurve が subTotal に依存するため、不動点反復で解く（数回で十分収束する）。
    """
    if game == "pubg":
        # index.html: sens = clamp(round(50 + 25*log2(baseSens/0.30)))
        base_sens = 0.30 * (2.0 ** ((sens - 50.0) / 25.0))
        target_edpi = base_sens * dpi
    else:
        target_edpi = sens * dpi / scale

    sub = target_edpi  # 初期値（gameCurve=1 と仮定）
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


def apply_rate_limit(current_val, target_val, max_change_rate=0.10, min_step=0.01):
    """1 回の更新幅を制限する。

    旧実装は current_val が負のとき下限・上限が反転して常に下限へ張り付き、
    current_val が 0 のとき幅も 0 になり永久に更新できないバグがあった。
    絶対値ベースの許容幅＋絶対最小ステップで両方を解消する。
    """
    if not np.isfinite(target_val):
        return current_val
    span = max(abs(current_val) * max_change_rate, min_step)
    lo, hi = current_val - span, current_val + span
    return round(float(min(max(target_val, lo), hi)), 4)


def clamp(value, bounds):
    lo, hi = bounds
    return float(min(max(value, lo), hi))


# --- 3. データ取得とクレンジング -------------------------------------------
raw_data = fetch_all("calc_logs")
if not raw_data:
    print("⚠️ calc_logs が空です。学習を見送ります。")
    sys.exit(0)

df = pd.DataFrame(raw_data)
print(f"📥 取得件数: {len(df)} 件")

for col in ["memo", "rating", "game", "user_id", "created_at",
            "dpi", "final_sens", "height",
            "dexterity", "play_style", "mouse_weight", "aim_part", "is_custom"]:
    if col not in df.columns:
        df[col] = None

df["memo_norm"] = df["memo"].astype(str).str.strip().str.lower()
df["is_custom"] = df["is_custom"].fillna(False).astype(bool)

# 3-A. 教師データの選別 ------------------------------------------------------
# 「ユーザー本人の実使用感度」だけを残す。
#   - 感度メモ（is_custom = true）
#   - 診断フォームの「現在の感度」自動収集ログ
# 診断結果そのものの保存ログ（本ツールの出力）は自己強化ループになるため除外。
is_auto_collect = df["memo_norm"].isin({m.lower() for m in AUTO_COLLECT_MEMOS})
is_diag_output = df["memo_norm"].isin(DIAG_OUTPUT_MEMOS)
df = df[(df["is_custom"] & ~is_diag_output) | is_auto_collect].copy()
print(f"🎯 教師データ候補（実使用感度のみ）: {len(df)} 件")

# 3-B. 品質フィルター --------------------------------------------------------
df = df[df["rating"].fillna("good") != "bad"]

ng_keywords = [
    "微妙", "ダメ", "だめ", "合わない", "あわない", "ぶれる", "ブレる",
    "イマイチ", "いまいち", "やめた", "ボツ", "しっくりこない", "無理",
    "bad", "not good", "worst", "fail", "discard", "테스트중", "별로",
    "疎通テスト", "テストデータ", "動作確認", "test data",
]
ng_pattern = "|".join(ng_keywords)
df = df[~df["memo_norm"].str.contains(ng_pattern, na=False)]

# 3-C. 数値化とレンジ判定 ----------------------------------------------------
df["dpi"] = to_number(df["dpi"])
df["final_sens"] = to_number(df["final_sens"])
df["height"] = to_number(df["height"])

df = df[df["game"].isin(GAMES)]
df = df[df["dpi"].between(100, 12800)]
df = df[df["final_sens"].between(0.01, 100.0)]

# 3-D. 重複排除 --------------------------------------------------------------
# 同じ人が何度も計算・保存した試行錯誤ログは、最終到達値だけを 1 件採用する。
df["created_at"] = pd.to_datetime(df["created_at"], errors="coerce", utc=True)
df = df.sort_values("created_at")

logged_in = df[df["user_id"].notna()].groupby(["user_id", "game"], as_index=False).last()
# 未ログイン（ゲスト）ログは user_id が無いので、内容が完全に同じものを畳む
guest = df[df["user_id"].isna()].drop_duplicates(
    subset=["game", "dpi", "final_sens", "height",
            "dexterity", "play_style", "mouse_weight", "aim_part"],
    keep="last",
)
df = pd.concat([logged_in, guest], ignore_index=True)
print(f"🧹 重複排除後: {len(df)} 件")

# 3-E. タイトル別 IQR 外れ値カット ------------------------------------------
kept = []
for game_name in GAMES:
    g = df[df["game"] == game_name].copy()
    if g.empty:
        continue
    if len(g) >= 5:
        q1, q3 = g["final_sens"].quantile(0.25), g["final_sens"].quantile(0.75)
        iqr = q3 - q1
        g = g[g["final_sens"].between(q1 - 1.5 * iqr, q3 + 1.5 * iqr)]
    kept.append(g)

if not kept:
    print("⚠️ 有効な集計データが得られませんでした。")
    sys.exit(0)

df = pd.concat(kept, ignore_index=True)

# --- 4. 現行係数の取得 ------------------------------------------------------
config_res = supabase.table("app_config").select("*").execute()
current_config = {}
for item in (config_res.data or []):
    try:
        current_config[item["key"]] = float(item["value"])
    except (TypeError, ValueError):
        continue

scale = {g: current_config.get(f"scale_{g}", DEFAULT_SCALE[g]) for g in GAMES}
trim = {g: current_config.get(f"game_{g}_trim", 1.0) for g in GAMES}

# --- 5. 観測感度 -> 基準 eDPI（subTotal）へ逆算 -----------------------------
df["subtotal"] = [
    invert_to_subtotal(row.final_sens, row.dpi, row.game, scale[row.game], trim[row.game])
    for row in df.itertuples()
]
df = df[df["subtotal"].between(*EDPI_SANITY)]

total_samples = len(df)
print(f"📊 クレンジング済み 有効データ数: {total_samples} 件")

if total_samples < MIN_TOTAL_FOR_ANY:
    print(f"⚠️ 学習データが不十分です（最低 {MIN_TOTAL_FOR_ANY} 件必要）。今回の学習は見送ります。")
    sys.exit(0)

updates = {}

# --- 6. フェーズ1：全体基準値のみ学習 --------------------------------------
if total_samples < MIN_TOTAL_FOR_FULL:
    print(f"ℹ️ {MIN_TOTAL_FOR_FULL} 件未満のため【フェーズ1：全体基準値学習】を実行します。")
    current_base = current_config.get("base_edpi", 230.0)
    target_base = clamp(float(df["subtotal"].median()), ABS_BOUNDS["base_edpi"])
    updates["base_edpi"] = apply_rate_limit(current_base, target_base, 0.10, min_step=1.0)

# --- 7. フェーズ2：身体パラメータ別の係数を同時学習 ------------------------
else:
    print(f"🚀 {MIN_TOTAL_FOR_FULL} 件以上を検知。【フェーズ2：全係数の同時学習】を実行します。")

    fit = df.dropna(subset=["height"]).copy()
    for col, levels in ALLOWED_LEVELS.items():
        fit[col] = fit[col].astype(str)
        fit = fit[fit[col].isin(levels)]

    print(f"   身体パラメータが揃った学習可能データ: {len(fit)} 件")

    if len(fit) < MIN_TOTAL_FOR_FULL:
        print("   → 身体パラメータ付きデータが不足。基準値のみ更新します。")
        current_base = current_config.get("base_edpi", 230.0)
        target_base = clamp(float(df["subtotal"].median()), ABS_BOUNDS["base_edpi"])
        updates["base_edpi"] = apply_rate_limit(current_base, target_base, 0.10, min_step=1.0)
    else:
        # 件数の少ない水準は基準カテゴリに寄せて、係数が数件で暴れないようにする
        level_counts = {}
        for col, (_prefix, ref) in CATEGORICALS.items():
            counts = fit[col].value_counts()
            level_counts[col] = counts
            rare = [lv for lv in counts.index if counts[lv] < MIN_ROWS_PER_LEVEL and lv != ref]
            if rare:
                print(f"   ⚠️ {col}: 件数不足の水準 {rare} は今回学習対象外")

        # 基準カテゴリを落としたダミー化（＝基準カテゴリの係数を 0 に固定）
        design = pd.DataFrame(index=fit.index)
        design["height_dev"] = 170.0 - fit["height"]

        learnable_keys = {}
        for col, (prefix, ref) in CATEGORICALS.items():
            for level in sorted(ALLOWED_LEVELS[col]):
                if level == ref:
                    continue
                n = int(level_counts[col].get(level, 0))
                if n < MIN_ROWS_PER_LEVEL:
                    continue
                colname = f"{col}__{level}"
                design[colname] = (fit[col] == level).astype(float)
                learnable_keys[colname] = f"{prefix}_{level}_factor"

        y = fit["subtotal"].astype(float)
        model = Ridge(alpha=2.0, fit_intercept=True)
        model.fit(design.values, y.values)

        base_raw = float(model.intercept_)
        target_base = clamp(base_raw, ABS_BOUNDS["base_edpi"])
        current_base = current_config.get("base_edpi", 230.0)
        updates["base_edpi"] = apply_rate_limit(current_base, target_base, 0.10, min_step=1.0)

        # 係数は「基準 eDPI に対する比率」に直して app_config の意味論に合わせる
        denom = base_raw if base_raw > 50 else 230.0
        coefs = dict(zip(design.columns, model.coef_))

        height_target = clamp(coefs.get("height_dev", 0.0) / denom, ABS_BOUNDS["height_factor"])
        updates["height_factor"] = apply_rate_limit(
            current_config.get("height_factor", 0.005), height_target, 0.10, min_step=0.0002
        )

        for colname, config_key in learnable_keys.items():
            target = clamp(coefs[colname] / denom, FACTOR_BOUNDS)
            current = current_config.get(config_key, 0.0)
            updates[config_key] = apply_rate_limit(current, target, 0.10, min_step=0.01)

        # 基準カテゴリは定義上 0
        for col, (prefix, ref) in CATEGORICALS.items():
            updates[f"{prefix}_{ref}_factor"] = 0.0

# --- 8. タイトル別の補正倍率（game_*_trim）を学習 ---------------------------
# scale（エンジン固有の単位変換）は定数のまま。
# 「そのタイトルのプレイヤーは相対的に速い／遅い感度を好む」ぶんだけを trim として学習する。
learned_base = updates.get("base_edpi", current_config.get("base_edpi", 230.0))
global_median = float(df["subtotal"].median())

for game_name in GAMES:
    g = df[df["game"] == game_name]
    if len(g) < MIN_ROWS_PER_GAME:
        continue
    game_median = float(g["subtotal"].median())
    if global_median <= 0:
        continue
    # そのタイトルの実測中央値 / 全体中央値 のズレを、現行 trim に掛けて目標値とする。
    # 件数が少ないうちはサンプリング誤差でブレるため、1.0 側へ縮小（shrinkage）する。
    ratio = game_median / global_median
    shrink = len(g) / (len(g) + TRIM_SHRINK_K)
    ratio = 1.0 + (ratio - 1.0) * shrink
    target_trim = clamp(trim[game_name] * ratio, TRIM_BOUNDS)
    updates[f"game_{game_name}_trim"] = apply_rate_limit(
        trim[game_name], target_trim, 0.10, min_step=0.005
    )
    print(f"   🎮 {game_name}: n={len(g)} median={game_median:.1f} "
          f"trim {trim[game_name]:.4f} -> {updates[f'game_{game_name}_trim']:.4f}")

# --- 9. 単位変換スケールの初期投入（未登録なら既定値を書き込むだけ） --------
for game_name in GAMES:
    key = f"scale_{game_name}"
    if key not in current_config:
        updates[key] = DEFAULT_SCALE[game_name]
    if f"game_{game_name}_trim" not in current_config and f"game_{game_name}_trim" not in updates:
        updates[f"game_{game_name}_trim"] = 1.0

updates["learned_sample_count"] = float(total_samples)

# --- 10. Supabase へ反映 ----------------------------------------------------
changed = 0
for key, value in sorted(updates.items()):
    before = current_config.get(key)
    if before is not None and abs(before - float(value)) < 1e-9:
        continue
    supabase.table("app_config").upsert({"key": key, "value": float(value)}, on_conflict="key").execute()
    print(f"   ✏️ {key}: {before} -> {value}")
    changed += 1

print(f"✅ 学習完了！ 有効データ {total_samples} 件をもとに {changed} 件の係数を更新しました。")
