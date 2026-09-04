/**
 * テスト用の Supabase 互換クライアント。
 *
 * **本番の policy と同じ規則をここでも実装している。** 目的は2つ。
 *   1. ネットワークも本番DBも使わずに、保存・読込・削除の流れを検証する。
 *   2. 「アプリ側が RLS に頼りきらず、自分でも守っているか」を確かめる。
 *      RLS はサーバー側の最後の砦であって、アプリ側が破ろうとして通ってしまう設計は避けたい。
 *
 * 本番へ適用した migration（0001〜0005）の制約を写している:
 *   * 本人の行しか読めない / 書けない
 *   * anon は Aim 系へ触れない
 *   * profile_storage の有効な同意が無いと aim_import_batches を作れない
 *   * aim_sessions は (user_id, source, raw_content_hash, parser_version) が一意
 *   * aim_metrics は Registry に (metric_key, metric_version, unit) が無いと入らない
 *   * ratio は 0〜1 / percent は 0〜100 / count は 0 以上
 *   * cm360 は dpi_confirmed が無いと入らない
 *   * timezone_status='unknown' で observed_at_utc を入れられない
 *   * session を消すと metric も消える / ユーザーを消すと全部消える
 */

let seq = 0;
const uuid = (p) => `${p}-${String(++seq).padStart(8, '0')}`;

// migration で定義した column default。実DBと同じ既定値にしておかないと、
// 「NULL かどうか」で分岐する判定がテストだけ通ってしまう。
const DEFAULTS = {
    user_consents: { revoked_at: null, source: 'web_ui' },
    aim_import_batches: { files_received: 0, sessions_parsed: 0, files_rejected: 0 },
    aim_sessions: {
        timezone_status: 'unknown', observed_at_utc: null, observed_at_tz: null,
        difficulty_varied: false, logical_fingerprint: null,
        logical_fingerprint_status: 'not_implemented', cm360: null, dpi_confirmed: null
    },
    aim_metrics: { weapon: null },
    aim_metric_registry: { recommendation_hold: false, usage_prohibited: false }
};

export function createFakeSupabase(options = {}) {
    const registry = options.registry || {};
    const db = {
        user_consents: [],
        aim_import_batches: [],
        aim_sessions: [],
        aim_metrics: [],
        aim_metric_registry: Object.keys(registry).map((k) => ({ metric_key: k, ...registry[k] }))
    };

    // 誰として実行しているか
    const auth = { userId: options.userId || null, role: options.role || 'anon' };

    const ok = (data) => Promise.resolve({ data, error: null });
    const err = (code, message) => Promise.resolve({ data: null, error: { code, message } });

    const OWNED = ['user_consents', 'aim_import_batches', 'aim_sessions', 'aim_metrics'];

    function checkInsert(table, row) {
        if (OWNED.includes(table)) {
            if (auth.role !== 'authenticated' || !auth.userId) {
                return 'RLS: この操作には認証が必要です（anon には policy がありません）';
            }
            if (row.user_id !== auth.userId) {
                return 'RLS: 自分以外の user_id では書き込めません';
            }
        }
        if (table === 'aim_metric_registry') {
            return 'RLS: aim_metric_registry には書き込み policy がありません';
        }

        if (table === 'aim_import_batches') {
            const c = db.user_consents.find((x) => x.id === row.consent_id);
            if (!c || c.user_id !== auth.userId || c.purpose !== 'profile_storage' || c.revoked_at !== null) {
                return 'RLS: 有効な profile_storage 同意がありません';
            }
        }

        if (table === 'aim_sessions') {
            const b = db.aim_import_batches.find((x) => x.id === row.batch_id);
            if (!b || b.user_id !== auth.userId) return 'RLS: 自分の batch ではありません';
            if (!/^[0-9a-f]{64}$/.test(String(row.raw_content_hash || ''))) {
                return 'CHECK: raw_content_hash が 64 桁の16進ではありません';
            }
            if (!row.parser_version) return 'NOT NULL: parser_version が必要です';
            if (row.cm360 !== null && row.cm360 !== undefined && !row.dpi_confirmed) {
                return 'CHECK: DPI が確定していないと cm360 を保存できません';
            }
            if (row.timezone_status === 'unknown' && (row.observed_at_utc || row.observed_at_tz)) {
                return 'CHECK: timezone が不明のまま UTC を保存できません';
            }
            const dup = db.aim_sessions.find((x) =>
                x.user_id === row.user_id && x.source === row.source
                && x.raw_content_hash === row.raw_content_hash
                && x.parser_version === row.parser_version);
            if (dup) return 'UNIQUE: この内容はすでに同じ parser 版で取り込み済みです';
        }

        if (table === 'aim_metrics') {
            const s = db.aim_sessions.find((x) => x.id === row.session_id);
            if (!s || s.user_id !== auth.userId) return 'RLS: 自分の session ではありません';
            const def = db.aim_metric_registry.find((x) =>
                x.metric_key === row.metric_key && (x.metric_version || '1') === row.metric_version
                && x.unit === row.unit);
            if (!def) return `FK: Registry に (${row.metric_key}, ${row.metric_version}, ${row.unit}) がありません`;
            if (row.unit === 'ratio' && (row.value < 0 || row.value > 1)) return 'CHECK: ratio は 0〜1';
            if (row.unit === 'percent' && (row.value < 0 || row.value > 100)) return 'CHECK: percent は 0〜100';
            if (row.unit === 'count' && row.value < 0) return 'CHECK: count は 0 以上';
            const dup = db.aim_metrics.find((x) =>
                x.session_id === row.session_id && x.metric_key === row.metric_key
                && x.metric_version === row.metric_version && (x.weapon || null) === (row.weapon || null));
            if (dup) return 'UNIQUE: 同じセッションに同じ metric を二重登録できません';
        }
        return null;
    }

    function visible(table, rows) {
        if (table === 'aim_metric_registry') return rows;            // 誰でも読める
        if (auth.role !== 'authenticated' || !auth.userId) return []; // anon は見えない
        return rows.filter((r) => r.user_id === auth.userId);
    }

    function cascadeDeleteSessions(ids) {
        db.aim_metrics = db.aim_metrics.filter((m) => !ids.includes(m.session_id));
        db.aim_sessions = db.aim_sessions.filter((s) => !ids.includes(s.id));
    }

    function from(table) {
        const filters = [];
        const q = {
            _rows: () => visible(table, db[table]).filter((r) =>
                filters.every((f) => f(r))),

            select() { return q; },
            eq(col, val) { filters.push((r) => r[col] === val); return q; },
            is(col, val) { filters.push((r) => r[col] === val); return q; },

            insert(rows) {
                const list = Array.isArray(rows) ? rows : [rows];
                const inserted = [];
                for (const row of list) {
                    const problem = checkInsert(table, row);
                    if (problem) return { select: () => ({ single: () => err('23000', problem), then: (f) => err('23000', problem).then(f) }), then: (f) => err('23000', problem).then(f) };
                    // 実DBの column default を再現する。
                    // 例: user_consents.revoked_at は NULL 既定。undefined のままだと
                    //     「有効な同意か」の判定が実DBと食い違う。
                    const withId = { id: uuid(table), created_at: new Date().toISOString(),
                        ...DEFAULTS[table], ...row };
                    for (const k of Object.keys(DEFAULTS[table] || {})) {
                        if (withId[k] === undefined) withId[k] = DEFAULTS[table][k];
                    }
                    db[table].push(withId);
                    inserted.push(withId);
                }
                const res = { data: inserted, error: null };
                return {
                    select: () => ({
                        single: () => Promise.resolve({ data: inserted[0], error: null }),
                        then: (f) => Promise.resolve(res).then(f)
                    }),
                    then: (f) => Promise.resolve(res).then(f)
                };
            },

            update(patch) {
                const target = q._rows();
                target.forEach((r) => Object.assign(r, patch));
                return {
                    eq(col, val) { filters.push((r) => r[col] === val); return this; },
                    is(col, val) { filters.push((r) => r[col] === val); return this; },
                    select: () => Promise.resolve({ data: target, error: null }),
                    then: (f) => Promise.resolve({ data: target, error: null }).then(f)
                };
            },

            delete() {
                return {
                    eq(col, val) {
                        const target = visible(table, db[table]).filter((r) => r[col] === val);
                        const ids = target.map((r) => r.id);
                        if (table === 'aim_sessions') cascadeDeleteSessions(ids);
                        else if (table === 'aim_import_batches') {
                            const sids = db.aim_sessions.filter((s) => ids.includes(s.batch_id)).map((s) => s.id);
                            cascadeDeleteSessions(sids);
                            db.aim_import_batches = db.aim_import_batches.filter((b) => !ids.includes(b.id));
                        } else {
                            db[table] = db[table].filter((r) => !ids.includes(r.id));
                        }
                        return Promise.resolve({ data: target, error: null });
                    }
                };
            },

            single() { const rows = q._rows(); return Promise.resolve({ data: rows[0] || null, error: null }); },
            then(f) { return Promise.resolve({ data: q._rows(), error: null }).then(f); }
        };
        return q;
    }

    return {
        from,
        _db: db,
        _auth: auth,
        /** ログインしているユーザーを切り替える。 */
        signInAs(userId) { auth.userId = userId; auth.role = 'authenticated'; },
        signOut() { auth.userId = null; auth.role = 'anon'; },
        /** アカウント削除。auth.users の cascade を再現する。 */
        deleteAccount(userId) {
            const sids = db.aim_sessions.filter((s) => s.user_id === userId).map((s) => s.id);
            cascadeDeleteSessions(sids);
            db.aim_import_batches = db.aim_import_batches.filter((b) => b.user_id !== userId);
            db.user_consents = db.user_consents.filter((c) => c.user_id !== userId);
            db.aim_metrics = db.aim_metrics.filter((m) => m.user_id !== userId);
        }
    };
}
