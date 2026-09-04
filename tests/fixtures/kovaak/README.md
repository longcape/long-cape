# KovaaK fixture について

| ファイル | 位置づけ |
|---|---|
| `Synthetic Intro Scenario - Challenge - 2026.09.04-23.05.48 Stats.csv` | **実 KovaaK 3.9.8 の構造を保った匿名・合成データ。これが現行形式の基準。** 値はすべて架空で、実ファイルの転載ではない |
| `Tile Frenzy - …` / `Multi Weapon - …` / `Some - Odd - Name - …` | 合成のストレスケース。BOM・シナリオ名の `" - "`・複数武器・未知列などを個別に検査するためのもの。**実ファイルの構造とは一致しない部分がある**（武器行に設定値を持たせている等） |
| `Legacy Scenario - …` | DPI を持たない旧世代の想定 |
| `Broken Rows` / `No Score` / `not-a-kovaak-file.csv` | 異常系 |

## 実ファイルで確認した 3.9.8 の構造（2026-09-04）

- 4ブロック: Kill表 / Weapon表 / Summary / Settings
- **Weapon表のヘッダには設定名が並ぶが、データ行には武器統計しか無い。** 設定値はフッターにある
- Kill の Timestamp は **時刻表記** `HH:MM:SS.mmm`（経過秒ではない）
- **Accuracy は 0〜1 の小数**（パーセントではない）
- TTK は `7.649000s` のように **s 接尾辞付き**
- `Cheated` は `0` / `1`（`false` ではない）
- **改行コードは混在**（Kill表は LF、以降は CRLF）
- **ファイル名の日時は終了時刻。** 開始時刻はフッターの `Challenge Start`
- `Sens Scale` は **名前**（`Valorant`）であって数値ではない
- フッターは 42 キー
- **stats フォルダに CSV 以外のファイルは生成されない**（秒単位データの export は無い）

実ファイルそのものは個人情報の有無を確認したうえでリポジトリへ入れていない。
