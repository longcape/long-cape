# rollback スクリプト

各 migration で **新設したテーブルを落とすだけ**。既存の `calc_logs` / `app_config` と
それらの RLS・policy には一切触れない。

適用順の逆で実行する。

```
down_0005_aim_metrics.sql
down_0004_aim_sessions.sql
down_0003_aim_import_batches.sql
down_0002_aim_metric_registry.sql
down_0001_user_consents.sql
```

`drop table` は依存する policy・index・constraint も同時に落とすため、
`drop policy → create policy` のように保護が一時的に消える状態は発生しない。

**0002 の seed（`0002_aim_metric_registry_seed.sql`）に対する rollback は用意しない。**
seed は生成物で、テーブルごと落ちれば消えるため。
