# ロングケープの定理 (Long Cape Theorem)

身長・腕の太さ・手先の器用さ・マウス重量・エイムの支点といった身体的／環境的パラメータから、
FPS タイトルごとの「理論上の最適インゲーム感度」を算出するエイム最適化エンジン。

**公開先** : https://longcapenotieri.jp （Vercel による自動デプロイ）

```
index.html          アプリ本体（HTML + CSS + Vanilla JS の 1 ファイル構成）
about.html          解説記事ページ
privacy.html        プライバシーポリシー
terms.html          利用規約
contact.html        お問い合わせ
robots.txt          クロール許可
sitemap.xml         サイトマップ
ads.txt             AdSense の販売者情報
manifest.json       PWA マニフェスト
train_model.py      係数の自動学習ジョブ（GitHub Actions から週次実行）
requirements.txt    学習ジョブの依存パッケージ
supabase/schema.sql テーブル定義と RLS ポリシー（手動で適用が必要）
```

---

## 計算モデル

フロント（`calculateEDPI`）と学習ジョブは、**同一の関数形**を共有している。

```
subTotal   = base_edpi × (1 + height_factor×(170 − 身長)
                            + 器用さ係数 + 腕の太さ係数 + マウス重量係数 + 支点係数)

finalEDPI  = subTotal × ダイナミクスカーブ(subTotal) × game_<title>_trim

インゲーム感度 = finalEDPI ÷ DPI × scale_<title>
```

| 要素 | 出どころ | 学習対象 |
| --- | --- | --- |
| `base_edpi` / 各係数 | `app_config`（フォールバック値を `index.html` に内蔵） | ○ |
| ダイナミクスカーブ | `index.html` / `train_model.py` にハードコード（実測ベースでFIX） | × |
| `scale_<title>` | エンジン固有の単位変換定数（Apex 3.18 / OW・CoD 10.60 / FN 12.60 / Delta 7.80 …） | × |
| `game_<title>_trim` | `app_config`（既定 1.00） | ○ |

`app_config` に値が無い場合は `index.html` 内の既定値が使われるため、DB が空でも動作する。

---

## 学習の仕組み

`train_model.py` を GitHub Actions が **毎週日曜 24:00 (JST)** に実行する。手動実行も可能。

### 教師データ

学習に使うのは「**ユーザー本人が申告した実使用感度**」だけ。

| 種類 | メモ欄の値 | 学習に使う |
| --- | --- | --- |
| 診断フォームの「現在の感度」自動収集 | `自動学習収集データ` | ○ |
| 感度メモタブからの保存 | 任意 | ○ |
| 診断結果そのものの保存 | `Long Cape Theory` | **×**（自己強化ループを防ぐため） |

### 安全装置

| 内容 | 実装箇所 |
| --- | --- |
| 1 回の更新幅を最大 ±10%（0 や負の係数でも正しく機能する） | `apply_rate_limit()` |
| 各係数の絶対的な上下限クランプ | `ABS_BOUNDS` / `FACTOR_BOUNDS` / `TRIM_BOUNDS` |
| タイトル別 IQR 外れ値カット | `3-E` |
| 「ボツ」評価・ネガティブメモの除外 | `3-B` |
| 同一ユーザー × 同一タイトルは最終到達値のみ採用 | `3-D` |
| 水準ごとの最小件数（5 件）未満は学習しない | `MIN_ROWS_PER_LEVEL` |
| タイトル別補正は 20 件以上かつ 1.0 側へ縮小 | `MIN_ROWS_PER_GAME` / `TRIM_SHRINK_K` |
| DPI・感度のレンジ外を除外 | `3-C` + フロント側の入力バリデーション |

### 学習の段階

- 有効データ **10 件未満** … 何もしない
- **10〜49 件** … `base_edpi` のみ中央値へ寄せる
- **50 件以上** … 身体パラメータが揃ったデータで Ridge 回帰し、全係数を同時更新

観測されたインゲーム感度は、上記の計算式を不動点反復で逆算して `subTotal`（身体由来の基準 eDPI）
に戻してから回帰にかける。基準カテゴリ（普通 / 標準 / 肘）の係数は 0 に固定される。

---

## セットアップ

### 1. Supabase

`supabase/schema.sql` を Supabase ダッシュボードの SQL Editor で実行する。
**行レベルセキュリティ（RLS）はここでしか担保できない**ため、必ず適用すること。
管理画面のメールアドレス判定はブラウザ側のもので、サーバー側の防御にはならない。

### 2. GitHub Actions

リポジトリの Settings → Secrets and variables → Actions に以下を登録する。

| Secret 名 | 値 |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase の service_role キー（RLS を迂回して全件集計するため必要） |

> 公開リポジトリのスケジュール実行は、60 日間コミットが無いと自動停止する。
> 学習を止めたくない場合は定期的にコミットするか、Actions 画面から手動で再有効化する。

### 3. Google AdSense

- `ads.txt` は配置済み。
- 手動の広告ユニットを使う場合は、`index.html` の `ADSENSE_SLOT_ID` に
  AdSense 管理画面で発行した**数字の広告ユニット ID** を設定する。
  空のままなら枠は表示されず、`<head>` の AdSense コードによる自動広告のみが動作する。
  （`data-ad-slot="auto"` は無効値で、広告が配信されない）

---

## ローカルでの確認

```bash
python3 -m http.server 8099
# → http://localhost:8099/
```

Supabase の SDK が読み込めない環境でも、感度診断そのものは動作する（保存機能のみ無効になる）。

## 学習ジョブのローカル実行

```bash
pip install -r requirements.txt
SUPABASE_SERVICE_ROLE_KEY=xxxx python train_model.py
```

実データを書き換えるため、動作確認だけの場合は Supabase 側のバックアップを取ってから実行すること。

---

本ツールは各ゲームタイトルの開発・運営元とは関係のない非公式のファンメイドツールです。
