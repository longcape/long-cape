/**
 * Supabase への接続（G-5）。**ブラウザでのみ使う薄い層。**
 *
 * ここには判断を置かない。判断は ui/storage.js と ui/ui-logic.js にあり、
 * そちらは Node でテストしている。
 *
 * 使うのは anon key だけ。**service role キーは絶対に置かない。**
 * 個人データの保護はサーバー側の RLS が担保する。
 */
(function (root) {
    'use strict';

    var SUPABASE_URL = 'https://gmhayutirvdaesneulgr.supabase.co';
    var SUPABASE_ANON_KEY = 'sb_publishable_jC2SZ-N4rA_vhLhxd0_66g_1xhydPPt';

    var client = null;
    if (typeof root.supabase !== 'undefined' && root.supabase
        && typeof root.supabase.createClient === 'function') {
        client = root.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }

    function available() { return client !== null; }

    /** 現在のログイン状態。未ログインでも例外にしない。 */
    function currentUser() {
        if (!client) return Promise.resolve(null);
        return client.auth.getUser()
            .then(function (r) { return (r && r.data && r.data.user) || null; })
            .catch(function () { return null; });
    }

    function onAuthChange(cb) {
        if (!client) return;
        client.auth.onAuthStateChange(function () { currentUser().then(cb); });
    }

    function signOut() { return client ? client.auth.signOut() : Promise.resolve(); }

    root.LC_BACKEND = {
        available: available,
        client: function () { return client; },
        currentUser: currentUser,
        onAuthChange: onAuthChange,
        signOut: signOut,
        loginUrl: 'index.html'
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
