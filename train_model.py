import os
import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from supabase import create_client

# --- 1. Supabase 接続 ---
SUPABASE_URL = "https://gmhayutirvdaesneulgr.supabase.co"
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "YOUR_LOCAL_SERVICE_ROLE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# --- 2. データ取得（ユーザー手動設定データ） ---
res = supabase.table("calc_logs").select("*").eq("is_custom", True).execute()
raw_data = res.data

if not raw_data or len(raw_data) < 10:
    print("⚠️ 学習データが不十分です（最低10件必要）。今回の学習は見送ります。")
    exit()

df = pd.DataFrame(raw_data)

# --- 🧠 2-A. 品質フィルター（ボツ判定 & ネガティブメモの除外） ---
# ① ユーザーが「ボツ (bad)」と指定したログを排除
if "rating" in df.columns:
    df = df[df["rating"] != "bad"]

# ② メモ欄のネガティブキーワード自動検出・排除
ng_keywords = [
    "微妙", "ダメ", "合わない", "あわない", "ぶれる", "ブレる", 
    "イマイチ", "いまいち", "やめた", "ボツ", "しっくりこない",
    "bad", "not good", "worst", "fail", "discard"
]
ng_pattern = "|".join(ng_keywords)
df = df[~df["memo"].astype(str).str.lower().str.contains(ng_pattern, na=False)]

# ③ 同一ユーザー × 同一ゲームの試行錯誤ログのクレンジング（最新の1件＝最終到達感度のみ採用）
if "user_id" in df.columns and "created_at" in df.columns:
    df["created_at"] = pd.to_datetime(df["created_at"])
    df = df.sort_values("created_at").groupby(["user_id", "game"]).last().reset_index()

# --- 3. クリーニング ＆ タイトル別外れ値カット（IQR法） ---
df["dpi"] = pd.to_numeric(df["dpi"], errors="coerce")
df["final_sens"] = pd.to_numeric(df["final_sens"], errors="coerce")
df["height"] = pd.to_numeric(df["height"], errors="coerce").fillna(170)

df = df[(df["dpi"] >= 400) & (df["dpi"] <= 6400)]
df = df[(df["final_sens"] >= 0.01) & (df["final_sens"] <= 100.0)]

games = ["valo", "apex", "ow", "fn", "delta", "cod", "pubg"]
clean_dfs = []

for game_name in games:
    df_game = df[df["game"] == game_name].copy()
    if len(df_game) < 3:
        continue

    # タイトル別の IQR 外れ値カット
    Q1 = df_game["final_sens"].quantile(0.25)
    Q3 = df_game["final_sens"].quantile(0.75)
    IQR = Q3 - Q1
    df_game_clean = df_game[
        (df_game["final_sens"] >= (Q1 - 1.5 * IQR)) &
        (df_game["final_sens"] <= (Q3 + 1.5 * IQR))
    ].copy()

    # タイトル別スケールを VALORANT 基準の eDPI へ統一変換
    df_game_clean["eDPI"] = df_game_clean["final_sens"] * df_game_clean["dpi"]
    if game_name == "apex":
        df_game_clean["eDPI"] /= 3.18
    elif game_name == "ow" or game_name == "cod":
        df_game_clean["eDPI"] /= 10.60
    elif game_name == "delta":
        df_game_clean["eDPI"] /= 7.80  # Delta Force (7.80)
    elif game_name == "fn":
        df_game_clean["eDPI"] /= 12.60
    elif game_name == "pubg":
        df_game_clean["eDPI"] = 240 * (2 ** ((df_game_clean["final_sens"] - 50) / 25))

    clean_dfs.append(df_game_clean)

if not clean_dfs:
    print("⚠️ 有効な集計データが得られませんでした。")
    exit()

df_all = pd.concat(clean_dfs, ignore_index=True)
total_samples = len(df_all)
print(f"📊 クレンジング済み 有効データ数: {total_samples}件")

# --- 4. 現行の全係数を DB から取得 ---
config_res = supabase.table("app_config").select("*").execute()
current_config = {item["key"]: float(item["value"]) for item in config_res.data}

# 🛑 変化率ブレーキ関数（1回の更新で最大±10%までの変動に抑える）
def apply_rate_limit(current_val, target_val, max_change_rate=0.10):
    min_allowed = current_val * (1.0 - max_change_rate)
    max_allowed = current_val * (1.0 + max_change_rate)
    return round(max(min_allowed, min(target_val, max_allowed)), 4)

updates = {}

# --- 5. 段階的・暗黙的（組み合わせ）学習アルゴリズム ---
if total_samples < 50:
    print("ℹ️ データ数50件未満のため【フェーズ1：全体基準値学習】を実行します。")
    target_base = df_all["eDPI"].median()
    current_base = current_config.get("base_edpi", 230)
    updates["base_edpi"] = apply_rate_limit(current_base, target_base, 0.10)

else:
    print("🚀 データ数50件以上を検知！【フェーズ2：暗黙的組み合わせ独立学習】を実行します。")
    
    y = df_all["eDPI"]
    features = ["neuro", "weight", "pivot"]
    X_cats = pd.get_dummies(df_all[features], drop_first=False)
    
    # 身長(height)と各種スタイルの交差項（暗黙的体格モデル）を作成
    X_interact = X_cats.multiply(df_all["height"] - 170, axis=0)
    X_interact.columns = [f"{col}_height_inter" for col in X_cats.columns]
    
    X = pd.concat([X_cats, X_interact], axis=1)
    
    model = Ridge(alpha=2.0)
    model.fit(X, y)
    
    updates["base_edpi"] = apply_rate_limit(current_config.get("base_edpi", 230), model.intercept_, 0.10)
    
    base_val = model.intercept_ if model.intercept_ > 0 else 230
    for col_name in X_cats.columns:
        coef_val = model.coef_[X.columns.get_loc(col_name)]
        calculated_factor = coef_val / base_val
        key_name = f"{col_name}_factor"
        
        if key_name in current_config:
            curr_factor = current_config[key_name]
            updates[key_name] = apply_rate_limit(curr_factor, calculated_factor, 0.10)

# --- 6. Supabase DB の書き換え ---
for key, value in updates.items():
    supabase.table("app_config").upsert({"key": key, "value": value}).execute()

print(f"✅ 学習完了！ {len(updates)} 件の純粋な高品質パラメータを最新化・保存しました。")
