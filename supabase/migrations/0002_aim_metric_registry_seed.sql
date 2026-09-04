-- 0002_aim_metric_registry_seed.sql
--
-- **自動生成。手で編集しないこと。**
--   生成元: metrics.json （registry_version 1.5.0 / 35 metric）
--   生成:   node tools/sync-metric-registry-sql.mjs
--   検証:   node tools/sync-metric-registry-sql.mjs --check
--
-- 正本は Git の metrics.json であり、この表ではない。
-- 差分は CI の drift detection が検出する。

insert into public.aim_metric_registry
    (metric_key, metric_version, unit, layer, concept,
     comparability_group, comparability_rule, rating_status,
     recommendation_eligible, recommendation_hold, usage_prohibited, registry_version)
values
    ('kovaak.score', '1', 'score', 'normalized', 'performance', 'kovaak.score.same_scenario', 'same_scenario', 'rated', true, false, false, '1.5.0'),
    ('kovaak.kills', '1', 'count', 'normalized', 'performance', 'kovaak.kills.same_scenario', 'same_scenario', 'rated', false, true, false, '1.5.0'),
    ('kovaak.deaths', '1', 'count', 'normalized', 'performance', 'kovaak.deaths.same_scenario', 'same_scenario', 'unrated', false, false, false, '1.5.0'),
    ('kovaak.fight_time', '1', 's', 'normalized', 'context', 'kovaak.fight_time.condition', 'condition', 'unrated', false, false, true, '1.5.0'),
    ('kovaak.hit_count', '1', 'count', 'normalized', 'performance', 'kovaak.hit_count.same_scenario', 'same_scenario', 'unrated', false, false, false, '1.5.0'),
    ('kovaak.accuracy', '1', 'ratio', 'derived', 'precision', 'kovaak.accuracy.same_scenario', 'same_scenario', 'rated', false, true, false, '1.5.0'),
    ('kovaak.kill_accuracy', '1', 'ratio', 'normalized', 'precision', 'kovaak.kill_accuracy.kill_level', 'kill_level', 'unrated', false, false, false, '1.5.0'),
    ('kovaak.avg_ttk', '1', 's', 'normalized', 'speed', 'kovaak.avg_ttk.unresolved', 'unresolved', 'unrated', false, false, true, '1.5.0'),
    ('kovaak.avg_fps', '1', 'fps', 'normalized', 'environment', 'kovaak.avg_fps.condition', 'condition', 'unrated', false, false, false, '1.5.0'),
    ('kovaak.damage_done', '1', 'damage', 'normalized', 'performance', 'kovaak.damage_done.same_scenario', 'same_scenario', 'unrated', false, false, false, '1.5.0'),
    ('kovaak.damage_taken', '1', 'damage', 'normalized', 'performance', 'kovaak.damage_taken.same_scenario', 'same_scenario', 'unrated', false, false, false, '1.5.0'),
    ('kovaak.midairs', '1', 'count', 'normalized', 'precision', 'kovaak.midairs.same_scenario', 'same_scenario', 'unrated', false, false, false, '1.5.0'),
    ('kovaak.midaired', '1', 'count', 'normalized', 'precision', 'kovaak.midaired.same_scenario', 'same_scenario', 'unrated', false, false, false, '1.5.0'),
    ('kovaak.directs', '1', 'count', 'normalized', 'precision', 'kovaak.directs.same_scenario', 'same_scenario', 'unrated', false, false, false, '1.5.0'),
    ('kovaak.directed', '1', 'count', 'normalized', 'precision', 'kovaak.directed.same_scenario', 'same_scenario', 'unrated', false, false, false, '1.5.0'),
    ('kovaak.distance_traveled', '1', 'unit', 'normalized', 'context', 'kovaak.distance_traveled.condition', 'condition', 'unrated', false, false, false, '1.5.0'),
    ('kovaak.weapon.shots', '1', 'count', 'normalized', 'performance', 'kovaak.weapon.shots.same_scenario', 'same_scenario', 'unrated', false, false, false, '1.5.0'),
    ('kovaak.weapon.hits', '1', 'count', 'normalized', 'performance', 'kovaak.weapon.hits.same_scenario', 'same_scenario', 'unrated', false, false, false, '1.5.0'),
    ('kovaak.weapon.damage_done', '1', 'damage', 'normalized', 'performance', 'kovaak.weapon.damage_done.same_scenario', 'same_scenario', 'unrated', false, false, false, '1.5.0'),
    ('kovaak.weapon.damage_possible', '1', 'damage', 'normalized', 'context', 'kovaak.weapon.damage_possible.condition', 'condition', 'unrated', false, false, false, '1.5.0'),
    ('manual.dpi', '1', 'dpi', 'normalized', 'measurement_condition', 'condition_dpi', 'condition', 'rated', false, false, false, '1.5.0'),
    ('manual.cm360', '1', 'cm_per_360', 'normalized', 'measurement_condition', 'condition_cm360', 'condition', 'rated', false, false, false, '1.5.0'),
    ('manual.in_game_sens', '1', 'sens', 'normalized', 'measurement_condition', 'condition_in_game_sens', 'condition', 'rated', false, false, false, '1.5.0'),
    ('manual.input_device', '1', 'label', 'normalized', 'measurement_condition', 'condition_input_device', 'condition', 'rated', false, false, false, '1.5.0'),
    ('manual.benchmark_score', '1', 'score', 'normalized', 'performance', 'manual_benchmark_score', 'same_scenario', 'rated', true, false, false, '1.5.0'),
    ('manual.accuracy_transcribed', '1', 'percent', 'normalized', 'accuracy', 'manual_accuracy', 'same_scenario', 'rated', true, false, false, '1.5.0'),
    ('manual.recalled_score', '1', 'score', 'normalized', 'performance', 'manual_benchmark_score', 'same_scenario', 'rated', false, false, false, '1.5.0'),
    ('manual.self_rating', '1', 'rating', 'normalized', 'subjective', 'manual_self_rating', 'condition', 'rated', false, false, false, '1.5.0'),
    ('kovaak.miss_count', '1', 'count', 'normalized', 'performance', 'kovaak.miss_count.same_scenario', 'same_scenario', 'unrated', false, false, false, '1.5.0'),
    ('kovaak.total_overshots', '1', 'count', 'normalized', 'precision', 'kovaak.total_overshots.same_scenario', 'same_scenario', 'unrated', false, false, false, '1.5.0'),
    ('kovaak.reloads', '1', 'count', 'normalized', 'context', 'kovaak.reloads.condition', 'condition', 'unrated', false, false, false, '1.5.0'),
    ('kovaak.mbs_points', '1', 'score', 'normalized', 'performance', 'kovaak.mbs_points.same_scenario', 'same_scenario', 'unrated', false, false, false, '1.5.0'),
    ('kovaak.time_remaining', '1', 's', 'normalized', 'context', 'kovaak.time_remaining.condition', 'condition', 'unrated', false, false, false, '1.5.0'),
    ('kovaak.pause_count', '1', 'count', 'normalized', 'context', 'kovaak.pause.condition', 'condition', 'unrated', false, false, false, '1.5.0'),
    ('kovaak.pause_duration', '1', 's', 'normalized', 'context', 'kovaak.pause.condition', 'condition', 'unrated', false, false, false, '1.5.0')
on conflict (metric_key, metric_version) do update set
    unit                    = excluded.unit,
    layer                   = excluded.layer,
    concept                 = excluded.concept,
    comparability_group     = excluded.comparability_group,
    comparability_rule      = excluded.comparability_rule,
    rating_status           = excluded.rating_status,
    recommendation_eligible = excluded.recommendation_eligible,
    recommendation_hold     = excluded.recommendation_hold,
    usage_prohibited        = excluded.usage_prohibited,
    registry_version        = excluded.registry_version,
    synced_at               = now();

-- metrics.json から消えた metric を DB からも消す。
-- ただし **参照されている metric は外部キーで守られるので消えない**（消せない場合はエラーになり、
-- 「使われている metric を registry から外そうとした」ことに気づける）。
delete from public.aim_metric_registry r
where (r.metric_key, r.metric_version) not in (('kovaak.score', '1'), ('kovaak.kills', '1'), ('kovaak.deaths', '1'), ('kovaak.fight_time', '1'), ('kovaak.hit_count', '1'), ('kovaak.accuracy', '1'), ('kovaak.kill_accuracy', '1'), ('kovaak.avg_ttk', '1'), ('kovaak.avg_fps', '1'), ('kovaak.damage_done', '1'), ('kovaak.damage_taken', '1'), ('kovaak.midairs', '1'), ('kovaak.midaired', '1'), ('kovaak.directs', '1'), ('kovaak.directed', '1'), ('kovaak.distance_traveled', '1'), ('kovaak.weapon.shots', '1'), ('kovaak.weapon.hits', '1'), ('kovaak.weapon.damage_done', '1'), ('kovaak.weapon.damage_possible', '1'), ('manual.dpi', '1'), ('manual.cm360', '1'), ('manual.in_game_sens', '1'), ('manual.input_device', '1'), ('manual.benchmark_score', '1'), ('manual.accuracy_transcribed', '1'), ('manual.recalled_score', '1'), ('manual.self_rating', '1'), ('kovaak.miss_count', '1'), ('kovaak.total_overshots', '1'), ('kovaak.reloads', '1'), ('kovaak.mbs_points', '1'), ('kovaak.time_remaining', '1'), ('kovaak.pause_count', '1'), ('kovaak.pause_duration', '1'));
