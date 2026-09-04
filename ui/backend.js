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

    // ---------------------------------------------------------- ログイン導線
    //
    // Lab 専用の認証画面は作らず、既存のログイン画面へ送る。
    // 戻り先は **同一オリジンの Lab ページだけ**に限定する。
    // 任意の URL を受け取ると、外部サイトへ飛ばされる踏み台になりうるため。
    var RETURN_ALLOWED = ['import.html', 'profile.html'];

    /** 戻り先として受け入れてよい値か。受け入れられないものは null を返す。 */
    function sanitizeReturn(value) {
        if (!value) return null;
        var v = String(value);
        // 絶対 URL・プロトコル相対・親ディレクトリ参照はすべて拒否
        if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.indexOf('//') === 0 || v.indexOf('..') >= 0) return null;
        var page = v.split('?')[0].split('#')[0].replace(/^\.?\//, '');
        return RETURN_ALLOWED.indexOf(page) >= 0 ? page : null;
    }

    /** いまの画面へ戻ってこられるログイン URL。 */
    function loginUrlWithReturn() {
        var here = null;
        try {
            here = sanitizeReturn(location.pathname.split('/').pop());
        } catch (e) { here = null; }
        return here ? 'index.html?return=' + encodeURIComponent(here) : 'index.html';
    }

    /** ログイン画面側で使う。戻り先が指定されていれば返す。 */
    function pendingReturn(search) {
        var q = search !== undefined ? search : (root.location ? root.location.search : '');
        var m = /[?&]return=([^&]*)/.exec(q || '');
        return m ? sanitizeReturn(decodeURIComponent(m[1])) : null;
    }

    root.LC_BACKEND = {
        available: available,
        client: function () { return client; },
        currentUser: currentUser,
        onAuthChange: onAuthChange,
        signOut: signOut,
        // 互換のため残す。実際の遷移には loginUrlWithReturn() を使う。
        loginUrl: 'index.html',
        loginUrlWithReturn: loginUrlWithReturn,
        pendingReturn: pendingReturn,
        sanitizeReturn: sanitizeReturn,
        RETURN_ALLOWED: RETURN_ALLOWED
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
