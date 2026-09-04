/**
 * Long Cape Lab — 多言語（日本語 / English / 한국어）
 *
 * 既存 index.html と同じ方式に合わせてある。
 *   * `data-i18n="key"` を付けた要素の textContent を差し替える
 *   * 言語は localStorage の `appLang` を共有する（サイト全体で同じ言語になる）
 *
 * 画面に出す文字列は **すべてここに置く**。HTML や JS へ直書きしない。
 * 技術用語・エラー・同意文言も辞書に含める。
 */
(function (root) {
    'use strict';

    var LANGS = ['ja', 'en', 'ko'];
    var DEFAULT = 'ja';

    var D = {
        ja: {
            // ---- 共通
            brandSub: 'FPS PERFORMANCE LAB',
            navImport: '取り込み', navProfile: 'プロフィール', navDiag: 'かんたん診断',
            devMode: '開発モード', devInternals: '内部の内訳',
            devHiddenNote: 'production の画面では表示しません。',
            close: '閉じる', retry: 'もう一度試す', cancel: 'やめる',

            // ---- データ状態
            stateConfirmed: '確認済み', stateNeedsCheck: '要確認',
            stateExcluded: '分析対象外', stateUnsupported: '未対応',
            stateConfirmedDesc: '内容を確認できました。分析に使えます。',
            stateNeedsCheckDesc: 'そのままでは確定できない項目があります。',
            stateExcludedDesc: '記録は残していますが、感度の比較には使いません。',
            stateUnsupportedDesc: '対応していない形式です。推測で読み込みません。',

            // ---- 取り込み画面
            importTitle: '測定データを取り込む',
            importLede: 'KovaaK の記録ファイル（CSV）を読み込みます。',
            importLedeSafe: 'ファイルはこの端末の中だけで処理し、送信しません。',
            importLedeNoLogin: 'ログインは不要です。',
            step1: 'ファイルを選ぶ',
            dropBig: 'ここにファイルをドラッグ＆ドロップ',
            dropSub: 'またはクリックして選択（複数まとめて選べます）',
            dropPrivacy: '送信しません。この画面の中だけで読み取ります。',
            dropHint: '置き場所の例:',
            btnSample: 'サンプルで試す',
            btnSampleAdaptive: '適応型を含むサンプル',
            btnSampleBroken: '未対応ファイルを含むサンプル',
            btnClear: 'クリア',
            emptyTitle: 'まだファイルがありません。',
            emptyBody: '読み込むと、シナリオ・日時・DPI・感度・スコアなどをこの場で確認できます。',
            step2: '読み込み結果',
            kpiFilesReceived: '受け取ったファイル', kpiParsed: '読み取れたセッション',
            kpiRejected: '読み取れなかった', kpiExcluded: '分析対象外',
            notSentTitle: '送信していません。',
            step3: 'マウスのDPIを確認',
            step4: '読み取った内容',
            warnToggle: '注意メッセージを見る', warnNone: 'ありません。',
            nextTitle: '次へ',
            nextBody: '取り込んだ内容はこの端末に保持しています。保存はしていません。',
            toProfile: 'プロフィールを見る',

            // ---- 表の列
            colState: '状態', colScenario: 'シナリオ', colTime: '日時',
            colDpiFile: 'DPI(ファイル)', colSensScale: '感度スケール', colInGameSens: 'ゲーム内感度',
            colFov: 'FOV', colCm360: 'cm/360', colScore: 'Score', colKills: 'Kills',
            colAccuracy: '命中率', colDifficulty: '難易度',
            tzUnknown: '(TZ不明)', selfDeclared: '自己申告',
            difficultyVaried: '変動あり', difficultyStable: '一定',
            cm360Blocked: 'DPI未確認',

            // ---- DPI
            dpiRecorded: 'KovaaKに記録されたDPI：{dpi}',
            dpiQuestion: '実際に使用しているマウスDPIは {dpi} ですか？',
            dpiNote: 'KovaaKのDPI欄は手で入力する設定値です。実際のマウス設定と違っていることがあります。',
            dpiNoRecord: 'ファイルにDPIの記録がありません。',
            dpiNoRecordBody: '実際に使っているマウスのDPIを入力してください。',
            dpiMixed: 'ファイルによってDPIの記録が違います（{list}）。',
            dpiMixedBody: 'どれが実際の値か選んでください。',
            dpiAsIs: 'このDPIで正しい', dpiAsIsDesc: '{dpi} として扱います',
            dpiOverride: '別のDPIを入力', dpiOverrideDesc: '実際のマウス設定の値を入れてください',
            dpiDefer: '今は確認しない', dpiDeferDesc: 'スコアなどの分析はできます',
            dpiApply: '確定する',
            dpiBlockedTitle: 'DPIが未確認のあいだ、次は出しません。',
            dpiBlockedList: '振り向き（cm/360）／感度の水準判定／感度の推奨',
            dpiBlockedWhy: 'DPIが2倍違うと、振り向きの距離も2倍ずれるためです。',
            dpiMismatchTitle: 'ファイルの記録（{file}）と違う値で確定しました。',
            dpiMismatchBody: 'KovaaK側の設定も {actual} に直しておくと、次から食い違いません。',

            // ---- プロフィール画面
            profileTitle: 'あなたの測定プロフィール',
            profileLede: 'いま集まっているデータと、次に何を測ればよいかを表示します。',
            notSaved: '（保存はしていません）',
            loggedIn: 'ログイン中', notLoggedIn: 'ログインしていません',
            loginToggle: 'ログイン状態を切り替え（デモ）', loginLink: 'ログインする',
            capsGuest: 'ログインしなくても、取り込みとプロフィールの確認まではできます。保存は要ログインです。',
            capsUser: '保存と継続的な測定ができます。',
            demoLabel: '表示するデータ:',
            demoImported: '取り込んだデータ', demoEnough: '人工データ（推奨あり）',
            demoNotEnough: '人工データ（推奨なし）', demoAdaptive: '人工データ（適応型混在）',
            demoStored: '保存済みデータ',
            demoNote: '推奨の画面は人工データで検証しています。KovaaK の実データは本番の推奨計算へ接続していません。',
            profileEmptyTitle: 'まだデータがありません。',
            profileEmptyBody: '取り込み画面から CSV を読み込むか、上の人工データを選んでください。',

            invTitle: '取り込み状況',
            invSessions: '取り込んだセッション', invSources: 'データ元', invScenarios: 'シナリオ数',
            invLevels: '試した感度の数', invEvidence: 'エビデンス件数',
            coverageTitle: '感度の広がり', coverageNone: '感度の広がりはまだ計算できません。',
            coverageRange: '試した範囲', coverageLevels: '水準数',
            coverageSkewed: '片側に偏っています', coverageEdge: '最良が端にあります',

            metersTitle: '3つの指標',
            metersNote: '意味が違うので、ひとつのメーターにまとめていません。',
            meterCompleteness: 'プロフィールの充実度',
            meterCompletenessDesc: 'どれだけ材料が集まったか。推奨の当たりやすさとは別です。',
            meterQuality: 'データの質',
            meterQualityDesc: '意味と信頼度が確定している項目の割合です。',
            meterConfidence: '推奨の確からしさ',
            meterConfidenceDesc: '推奨そのものの確からしさ。上の2つとは別の指標です。',
            meterUnavailable: '推奨がまだ出せないため計算していません。',
            meterGaps: '不足',

            trendTitle: 'スコアの推移', trendNone: 'スコアがまだありません。',
            trendMin: '最小', trendMax: '最大',
            trendMixedNote: 'シナリオが違うとスコアの尺度も違うため、別シナリオの点を直接くらべないでください。',
            trendAdaptiveNote: '灰色は難易度が変動したセッションです。比較には使っていません。',

            unresolvedTitle: '確認が必要な項目', unresolvedNone: 'ありません。',
            excludedTitle: '比較から外したセッション', excludedNone: 'ありません。',
            excludedReason: '難易度がセッション中に変化したため、現在の感度比較からは除外',
            excludedKeptNote: 'データは保持しています。難易度の変化を補正できるようになれば再び使えます。',
            excludedCount: '{n} 件を感度の比較から外しています（記録は残しています）。',

            fieldDpiVerified: 'マウスDPIの確認', fieldCm360: '振り向き（cm/360）',
            fieldInGameSens: 'ゲーム内感度', fieldComparability: 'このセッションを比較に使えるか',

            // ---- 推奨
            recNow: '現時点の推奨',
            recScopeTitle: 'この推奨はAimテストにもとづくものです',
            recScopeDisclaimer: 'この結果はAimテストでのパフォーマンスに基づくものです。実際のゲームでは、武器、移動、交戦距離、判断などの影響により、最適な感度が異なる場合があります。',
            recScopeLayers: '現在は「機械的なエイム性能」の層だけを測定しています。実ゲームの成績にもとづく層と、その2つを統合した推奨は、ゲーム内のデータが集まるまで作りません。',
            recScopeNotProven: 'ゲーム内で最適だと実証したものではありません。',
            recWithheld: 'まだ推奨できません',
            recCm360: '推奨（振り向き）', recRange: '有力な範囲 cm',
            recConfidence: '推奨の確からしさ', recEvidence: '使ったデータ件数',
            recSources: 'データ元', recExcluded: '除外',
            recWhyToggle: 'なぜこの結果？',
            recWhyHeadline: 'スコアが一番高い感度を、そのまま選んでいるわけではありません',
            recWhySummary: '成績だけでなく、ブレの小ささや日をまたいだ再現性も合わせて判断しています。',
            recWhyNote: '調子の良い1回だけ極端に高い感度より、いつも同じように出せる感度を優先します。',
            recWhatToDo: '出せるようにするには',
            recUsable: 'いま使えるデータ',
            recWhyDpi: 'マウスのDPIが未確認だからです。DPIが2倍違うと、振り向きの距離も2倍ずれてしまいます。',
            recWhyEvidence: '感度を比べるための材料が足りていません。',
            recConfirmDpi: '実際に使っているマウスのDPIを確認してください',
            recConfirmDpiDetail: 'DPIさえ分かれば、いま取り込んだデータのまま計算できます。',
            recImportMore: '測定データをもう少し取り込んでください',
            recRangeMeaning: '範囲の意味',
            recSyntheticBanner: '人工データによる表示確認です。 実際の測定結果ではありません。',
            recLocalBanner: '取り込んだデータのみで計算しています。 保存も送信もしていません。',
            factorPerformance: '成績', factorPerformanceDesc: 'そのままのスコアの高さ',
            factorStability: '安定性', factorStabilityDesc: '1回ごとのブレの小ささ',
            factorRepeatability: '再現性', factorRepeatabilityDesc: '日をまたいでも同じように出せるか',
            factorRecency: '新しさ', factorRecencyDesc: '最近のデータかどうか',
            factorCoverage: '測定の広がり', factorCoverageDesc: '前後の感度も試したか',

            // ---- 次の測定
            nextExperiment: 'NEXT EXPERIMENT',
            nextSentence: '次は {cm}cm で {n}回 試してください。',
            nextScenario: 'シナリオは {name} を使ってください。',
            nextChipSens: '次に試す感度', nextChipCount: '必要な回数', nextChipScenario: 'シナリオ',
            nextUncertainty: 'どれくらい確信が上がるかを数値では出しません。まだ根拠がないためです。',
            reasonIncreaseLevels: '比べられる感度がまだ足りないためです。',
            reasonExploreEdge: 'いちばん良かったのが試した範囲の端だったので、その外側も確かめます。',
            reasonDistinguish: '上位2つの差がまだ判別できないためです。',
            reasonReinforce: 'この感度のデータが少ないためです。',

            // ---- 保存 / 同意
            saveTitle: 'この端末のデータを保存する',
            saveReady: '{n} 件を保存できます。',
            saveRawNote: '元のCSVは保存しません。ハッシュと測定結果だけを保存します。',
            saveButton: '保存する', saving: '保存しています…',
            saveDone: '{n} 件を保存しました。',
            saveSkipped: '{n} 件は取り込み済みだったので飛ばしました。',
            saveReanalysis: '{n} 件は前回と違う版で読み直しました。',
            saveNothingNew: '新しく取り込むものはありませんでした。',
            saveFailed: '保存に失敗しました',
            saveNoBackend: '保存機能に接続できません。取り込みと確認はこのまま使えます。',
            saveSynthetic: '人工データは保存しません。「取り込んだデータ」に切り替えると保存できます。',
            saveNoData: '保存できるデータがありません。',
            saveNeedLogin: '保存するにはログインが必要です。取り込みと確認はログインなしでもできます。',
            saveNeedConsent: '「個人プロフィールとして保存する」に同意すると保存できます。',
            saveNoConsentRow: '同意の記録が見つかりません。',

            consentTitle: '保存とデータの使い道',
            consentNoNeed: 'ここまでの表示に同意は要りません。',
            consentNoNeedBody: '取り込みとプロフィールの確認は、同意なし・ログインなしで使えます。',
            consentPick: '保存する場合だけ、目的ごとに選んでください。まとめてひとつのチェックにはしていません。',
            consentProfile: '個人プロフィールとして保存する',
            consentProfileDesc: '次に来たときも続きから測定できるようになります。',
            consentStats: '匿名の集計統計に使う',
            consentStatsDesc: '個人が分からない形で、全体の傾向を出すために使います。',
            consentModel: 'モデルの改善・学習に使う',
            consentModelDesc: '推奨の精度を上げるために使います。',
            consentSelected: '選んだ用途のみに使います。',
            consentSelectedBody: '選んでいない用途には使いません。',
            consentNone: 'どれも選んでいません。',
            consentNoneBody: 'このままでも取り込みとプロフィールの確認は使えます。',
            consentRevocable: '同意は目的ごとに記録され、いつでも取り消せます。取り消すと、それ以降の保存ができなくなります。',
            consentRevokeKeeps: '取り消しても、すでに保存したデータは自動では削除しません。消したいときは「データを削除」を使ってください。',

            // ---- データの権利
            dataTitle: 'あなたのデータ',
            btnExport: '自分のデータをExport', btnDelete: 'データを削除',
            btnReload: '保存済みを読み込む',
            dataFree: '削除とExportは、今後どの料金プランになっても無料のままにします。有料機能にはしません。',
            exportDone: 'この端末の中でファイルを作成しました。送信はしていません。',
            deleteConfirm: '保存してある測定データをすべて削除します。よろしいですか？',
            deleteLocalDone: 'この端末に持っていたデータを消しました。',
            deleteDone: '削除しました。',
            deleteFailed: '削除に失敗しました',
            reloadNeedLogin: 'ログインすると保存済みを読み込めます。',
            reloading: '読み込んでいます…',
            reloadDone: '保存済み {n} 件を読み込みました。',

            // ---- エラー / 通信
            errNetwork: '通信できませんでした。',
            errNetworkBody: 'インターネット接続を確認して、もう一度お試しください。取り込んだ内容はこの端末に残っています。',
            errServer: 'サーバー側で問題が起きました。',
            errServerBody: '少し時間をおいて、もう一度お試しください。',
            errAuth: 'ログインの有効期限が切れたようです。',
            errAuthBody: 'もう一度ログインしてからお試しください。',
            errPermission: 'この操作を行う権限がありません。',
            errPermissionBody: '別のアカウントのデータには触れません。',
            errUnknown: '問題が起きました。',
            errUnknownBody: '一度やり直してみてください。取り込んだ内容はこの端末に残っています。',
            errRetrying: '再試行しています（{n}回目）…',
            errGaveUp: '{n} 回試しましたが、うまくいきませんでした。',
            offlineBanner: 'オフラインです。取り込みと確認はこのまま使えますが、保存はできません。',
            onlineBanner: '接続が戻りました。'
        },

        en: {
            brandSub: 'FPS PERFORMANCE LAB',
            navImport: 'Import', navProfile: 'Profile', navDiag: 'Quick check',
            devMode: 'Developer mode', devInternals: 'Internal breakdown',
            devHiddenNote: 'Not shown in the production view.',
            close: 'Close', retry: 'Try again', cancel: 'Cancel',

            stateConfirmed: 'Confirmed', stateNeedsCheck: 'Needs checking',
            stateExcluded: 'Not used for analysis', stateUnsupported: 'Unsupported',
            stateConfirmedDesc: 'We could read this. It can be used for analysis.',
            stateNeedsCheckDesc: 'Something here cannot be settled as-is.',
            stateExcludedDesc: 'Kept on record, but not used when comparing sensitivities.',
            stateUnsupportedDesc: 'Unsupported format. We do not guess at it.',

            importTitle: 'Import your measurements',
            importLede: 'Reads KovaaK stats files (CSV).',
            importLedeSafe: 'Files are processed on this device only and are not uploaded.',
            importLedeNoLogin: 'No login required.',
            step1: 'Choose files',
            dropBig: 'Drag and drop files here',
            dropSub: 'or click to choose (you can select several at once)',
            dropPrivacy: 'Nothing is uploaded. Everything is read inside this page.',
            dropHint: 'Typical location:',
            btnSample: 'Try a sample',
            btnSampleAdaptive: 'Sample with an adaptive scenario',
            btnSampleBroken: 'Sample with an unsupported file',
            btnClear: 'Clear',
            emptyTitle: 'No files yet.',
            emptyBody: 'Once loaded, you can check scenario, time, DPI, sensitivity and score right here.',
            step2: 'What was read',
            kpiFilesReceived: 'Files received', kpiParsed: 'Sessions read',
            kpiRejected: 'Could not read', kpiExcluded: 'Not used for analysis',
            notSentTitle: 'Nothing was uploaded.',
            step3: 'Confirm your mouse DPI',
            step4: 'Contents',
            warnToggle: 'Show warnings', warnNone: 'None.',
            nextTitle: 'Next',
            nextBody: 'What you imported is held on this device. Nothing has been saved.',
            toProfile: 'Open your profile',

            colState: 'State', colScenario: 'Scenario', colTime: 'Time',
            colDpiFile: 'DPI (file)', colSensScale: 'Sens scale', colInGameSens: 'In-game sens',
            colFov: 'FOV', colCm360: 'cm/360', colScore: 'Score', colKills: 'Kills',
            colAccuracy: 'Accuracy', colDifficulty: 'Difficulty',
            tzUnknown: '(timezone unknown)', selfDeclared: 'self-declared',
            difficultyVaried: 'varied', difficultyStable: 'constant',
            cm360Blocked: 'DPI unconfirmed',

            dpiRecorded: 'DPI recorded by KovaaK: {dpi}',
            dpiQuestion: 'Is the mouse you actually use set to {dpi} DPI?',
            dpiNote: 'The DPI field in KovaaK is typed in by hand. It can differ from your real mouse setting.',
            dpiNoRecord: 'No DPI is recorded in the file.',
            dpiNoRecordBody: 'Please enter the DPI your mouse is actually set to.',
            dpiMixed: 'The files disagree about DPI ({list}).',
            dpiMixedBody: 'Please pick the one that is correct.',
            dpiAsIs: 'That DPI is correct', dpiAsIsDesc: 'We will treat it as {dpi}',
            dpiOverride: 'Enter a different DPI', dpiOverrideDesc: 'Use the value from your mouse settings',
            dpiDefer: 'Not now', dpiDeferDesc: 'Scores and the rest still work',
            dpiApply: 'Confirm',
            dpiBlockedTitle: 'While DPI is unconfirmed, we will not show these.',
            dpiBlockedList: 'cm/360 · sensitivity level · sensitivity recommendation',
            dpiBlockedWhy: 'If the DPI is off by 2x, the distance for a 360 is off by 2x as well.',
            dpiMismatchTitle: 'Confirmed a value different from the file ({file}).',
            dpiMismatchBody: 'Setting KovaaK to {actual} as well will keep them in step from now on.',

            profileTitle: 'Your measurement profile',
            profileLede: 'What has been collected so far, and what to measure next.',
            notSaved: '(nothing saved)',
            loggedIn: 'Signed in', notLoggedIn: 'Not signed in',
            loginToggle: 'Toggle sign-in (demo)', loginLink: 'Sign in',
            capsGuest: 'You can import and review without signing in. Saving needs an account.',
            capsUser: 'You can save and keep measuring over time.',
            demoLabel: 'Show:',
            demoImported: 'Imported data', demoEnough: 'Synthetic (with a recommendation)',
            demoNotEnough: 'Synthetic (no recommendation)', demoAdaptive: 'Synthetic (adaptive mixed in)',
            demoStored: 'Saved data',
            demoNote: 'The recommendation view is checked with synthetic data. Real KovaaK data is not wired into the production recommendation.',
            profileEmptyTitle: 'No data yet.',
            profileEmptyBody: 'Import a CSV, or pick one of the synthetic sets above.',

            invTitle: 'What has been imported',
            invSessions: 'Sessions imported', invSources: 'Sources', invScenarios: 'Scenarios',
            invLevels: 'Sensitivities tried', invEvidence: 'Evidence items',
            coverageTitle: 'Sensitivity coverage', coverageNone: 'Not enough to compute coverage yet.',
            coverageRange: 'Range tried', coverageLevels: 'Levels',
            coverageSkewed: 'skewed to one side', coverageEdge: 'best result is at the edge',

            metersTitle: 'Three separate measures',
            metersNote: 'They mean different things, so they are not merged into one meter.',
            meterCompleteness: 'Profile completeness',
            meterCompletenessDesc: 'How much material has been gathered. Not the same as how likely the recommendation is to be right.',
            meterQuality: 'Data quality',
            meterQualityDesc: 'The share of items whose meaning and reliability are settled.',
            meterConfidence: 'Recommendation confidence',
            meterConfidenceDesc: 'How confident the recommendation itself is. A different measure from the two above.',
            meterUnavailable: 'Not computed, because no recommendation can be issued yet.',
            meterGaps: 'Missing',

            trendTitle: 'Score over time', trendNone: 'No scores yet.',
            trendMin: 'min', trendMax: 'max',
            trendMixedNote: 'Different scenarios use different score scales, so do not compare points across scenarios.',
            trendAdaptiveNote: 'Grey bars are sessions where the difficulty varied. They are not used for comparison.',

            unresolvedTitle: 'Needs your confirmation', unresolvedNone: 'Nothing.',
            excludedTitle: 'Sessions kept out of the comparison', excludedNone: 'None.',
            excludedReason: 'Difficulty changed during the session, so it is excluded from the sensitivity comparison',
            excludedKeptNote: 'The data is kept. Once we can correct for changing difficulty, it can be used again.',
            excludedCount: '{n} session(s) are kept out of the sensitivity comparison (the records remain).',

            fieldDpiVerified: 'Mouse DPI confirmation', fieldCm360: 'cm per 360',
            fieldInGameSens: 'In-game sensitivity', fieldComparability: 'Whether this session can be compared',

            recNow: 'Current recommendation',
            recScopeTitle: 'This recommendation comes from aim-test performance',
            recScopeDisclaimer: 'This result is based on your performance in aim tests. In an actual game, the best sensitivity may differ because of weapons, movement, engagement distance, decision-making and other factors.',
            recScopeLayers: 'Right now only the mechanical aim layer is measured. A layer based on in-game results, and a recommendation combining the two, are not produced until in-game data exists.',
            recScopeNotProven: 'It has not been proven optimal inside a game.',
            recWithheld: 'Not enough to recommend yet',
            recCm360: 'Recommended (cm/360)', recRange: 'Likely range (cm)',
            recConfidence: 'Confidence', recEvidence: 'Data used',
            recSources: 'Sources', recExcluded: 'Excluded',
            recWhyToggle: 'Why this result?',
            recWhyHeadline: 'We do not simply pick the sensitivity with the highest score',
            recWhySummary: 'Alongside raw results, we weigh how little it varies and how well it repeats across days.',
            recWhyNote: 'A sensitivity you can hit consistently beats one that spiked once on a good day.',
            recWhatToDo: 'To make a recommendation possible',
            recUsable: 'Usable data',
            recWhyDpi: 'Because your mouse DPI is unconfirmed. If DPI is off by 2x, the distance for a 360 is off by 2x.',
            recWhyEvidence: 'There is not enough to compare sensitivities against each other.',
            recConfirmDpi: 'Confirm the DPI your mouse is actually set to',
            recConfirmDpiDetail: 'Once the DPI is known, the data you already imported is enough.',
            recImportMore: 'Import a few more measurements',
            recRangeMeaning: 'What the range means',
            recSyntheticBanner: 'Shown with synthetic data. These are not real results.',
            recLocalBanner: 'Computed from imported data only. Nothing saved or uploaded.',
            factorPerformance: 'Result', factorPerformanceDesc: 'the raw score',
            factorStability: 'Stability', factorStabilityDesc: 'how little it varies run to run',
            factorRepeatability: 'Repeatability', factorRepeatabilityDesc: 'whether it holds across days',
            factorRecency: 'Recency', factorRecencyDesc: 'how recent the data is',
            factorCoverage: 'Coverage', factorCoverageDesc: 'whether nearby sensitivities were tried',

            nextExperiment: 'NEXT EXPERIMENT',
            nextSentence: 'Next, try {cm}cm for {n} run(s).',
            nextScenario: 'Use the {name} scenario.',
            nextChipSens: 'sensitivity to try', nextChipCount: 'runs needed', nextChipScenario: 'scenario',
            nextUncertainty: 'We do not put a number on how much this raises confidence. There is no basis for one yet.',
            reasonIncreaseLevels: 'There are not enough sensitivities to compare yet.',
            reasonExploreEdge: 'The best result was at the edge of what you tried, so we check beyond it.',
            reasonDistinguish: 'The top two cannot be told apart yet.',
            reasonReinforce: 'There is little data at this sensitivity.',

            saveTitle: 'Save the data on this device',
            saveReady: '{n} session(s) can be saved.',
            saveRawNote: 'The original CSV is not saved. Only a hash and the measurements are.',
            saveButton: 'Save', saving: 'Saving…',
            saveDone: 'Saved {n} session(s).',
            saveSkipped: '{n} were already imported and were skipped.',
            saveReanalysis: '{n} were re-read with a different version than before.',
            saveNothingNew: 'There was nothing new to import.',
            saveFailed: 'Saving failed',
            saveNoBackend: 'Cannot reach the save service. Import and review still work.',
            saveSynthetic: 'Synthetic data is not saved. Switch to "Imported data" to save.',
            saveNoData: 'There is nothing to save.',
            saveNeedLogin: 'Signing in is required to save. Import and review work without it.',
            saveNeedConsent: 'Agree to "Save as my personal profile" to enable saving.',
            saveNoConsentRow: 'No consent record was found.',

            consentTitle: 'Saving and how your data is used',
            consentNoNeed: 'Nothing above requires your consent.',
            consentNoNeedBody: 'Import and profile review work without consent and without an account.',
            consentPick: 'Only if you want to save. Choose per purpose — these are not bundled into one checkbox.',
            consentProfile: 'Save as my personal profile',
            consentProfileDesc: 'So you can pick up where you left off next time.',
            consentStats: 'Use for anonymised statistics',
            consentStatsDesc: 'Used to show overall trends in a form that cannot identify you.',
            consentModel: 'Use to improve the model',
            consentModelDesc: 'Used to make recommendations more accurate.',
            consentSelected: 'Used only for what you chose.',
            consentSelectedBody: 'Nothing you left unchecked will be used.',
            consentNone: 'Nothing selected.',
            consentNoneBody: 'Import and profile review still work as they are.',
            consentRevocable: 'Consent is recorded per purpose and can be withdrawn at any time. Withdrawing stops further saving.',
            consentRevokeKeeps: 'Withdrawing does not delete what is already saved. Use "Delete my data" if you want it removed.',

            dataTitle: 'Your data',
            btnExport: 'Export my data', btnDelete: 'Delete my data',
            btnReload: 'Load saved data',
            dataFree: 'Deleting and exporting stay free whatever the plan becomes. They will never be paid features.',
            exportDone: 'A file was created on this device. Nothing was uploaded.',
            deleteConfirm: 'This deletes all saved measurements. Continue?',
            deleteLocalDone: 'Cleared the data held on this device.',
            deleteDone: 'Deleted.',
            deleteFailed: 'Deleting failed',
            reloadNeedLogin: 'Sign in to load your saved data.',
            reloading: 'Loading…',
            reloadDone: 'Loaded {n} saved session(s).',

            errNetwork: 'Could not reach the network.',
            errNetworkBody: 'Check your connection and try again. What you imported is still on this device.',
            errServer: 'Something went wrong on the server.',
            errServerBody: 'Please wait a moment and try again.',
            errAuth: 'Your session seems to have expired.',
            errAuthBody: 'Please sign in again and retry.',
            errPermission: 'You do not have permission for this.',
            errPermissionBody: 'Another account’s data cannot be touched.',
            errUnknown: 'Something went wrong.',
            errUnknownBody: 'Please try again. What you imported is still on this device.',
            errRetrying: 'Retrying (attempt {n})…',
            errGaveUp: 'Tried {n} times without success.',
            offlineBanner: 'You are offline. Import and review still work, but saving does not.',
            onlineBanner: 'Connection is back.'
        },

        ko: {
            brandSub: 'FPS PERFORMANCE LAB',
            navImport: '가져오기', navProfile: '프로필', navDiag: '간단 진단',
            devMode: '개발자 모드', devInternals: '내부 상세',
            devHiddenNote: '실제 서비스 화면에는 표시하지 않습니다.',
            close: '닫기', retry: '다시 시도', cancel: '취소',

            stateConfirmed: '확인됨', stateNeedsCheck: '확인 필요',
            stateExcluded: '분석 제외', stateUnsupported: '미지원',
            stateConfirmedDesc: '내용을 확인했습니다. 분석에 사용할 수 있습니다.',
            stateNeedsCheckDesc: '이대로는 확정할 수 없는 항목이 있습니다.',
            stateExcludedDesc: '기록은 남기지만 감도 비교에는 사용하지 않습니다.',
            stateUnsupportedDesc: '지원하지 않는 형식입니다. 추측해서 읽지 않습니다.',

            importTitle: '측정 데이터 가져오기',
            importLede: 'KovaaK 기록 파일(CSV)을 읽습니다.',
            importLedeSafe: '파일은 이 기기 안에서만 처리하며 전송하지 않습니다.',
            importLedeNoLogin: '로그인은 필요 없습니다.',
            step1: '파일 선택',
            dropBig: '여기에 파일을 끌어다 놓으세요',
            dropSub: '또는 클릭해서 선택 (여러 개 한 번에 가능)',
            dropPrivacy: '전송하지 않습니다. 이 화면 안에서만 읽습니다.',
            dropHint: '보통 이 위치에 있습니다:',
            btnSample: '샘플로 시험',
            btnSampleAdaptive: '적응형 포함 샘플',
            btnSampleBroken: '미지원 파일 포함 샘플',
            btnClear: '지우기',
            emptyTitle: '아직 파일이 없습니다.',
            emptyBody: '읽어오면 시나리오·시각·DPI·감도·점수를 이 자리에서 확인할 수 있습니다.',
            step2: '읽어온 결과',
            kpiFilesReceived: '받은 파일', kpiParsed: '읽은 세션',
            kpiRejected: '읽지 못함', kpiExcluded: '분석 제외',
            notSentTitle: '전송하지 않았습니다.',
            step3: '마우스 DPI 확인',
            step4: '읽어온 내용',
            warnToggle: '경고 보기', warnNone: '없습니다.',
            nextTitle: '다음',
            nextBody: '가져온 내용은 이 기기에 있습니다. 저장하지 않았습니다.',
            toProfile: '프로필 보기',

            colState: '상태', colScenario: '시나리오', colTime: '시각',
            colDpiFile: 'DPI(파일)', colSensScale: '감도 스케일', colInGameSens: '게임 내 감도',
            colFov: 'FOV', colCm360: 'cm/360', colScore: 'Score', colKills: 'Kills',
            colAccuracy: '명중률', colDifficulty: '난이도',
            tzUnknown: '(시간대 불명)', selfDeclared: '자기 신고',
            difficultyVaried: '변동 있음', difficultyStable: '일정',
            cm360Blocked: 'DPI 미확인',

            dpiRecorded: 'KovaaK에 기록된 DPI: {dpi}',
            dpiQuestion: '실제 사용 중인 마우스 DPI가 {dpi} 맞습니까?',
            dpiNote: 'KovaaK의 DPI 항목은 직접 입력하는 설정값입니다. 실제 마우스 설정과 다를 수 있습니다.',
            dpiNoRecord: '파일에 DPI 기록이 없습니다.',
            dpiNoRecordBody: '실제 사용 중인 마우스 DPI를 입력해 주세요.',
            dpiMixed: '파일마다 DPI 기록이 다릅니다 ({list}).',
            dpiMixedBody: '어느 값이 맞는지 선택해 주세요.',
            dpiAsIs: '이 DPI가 맞습니다', dpiAsIsDesc: '{dpi} 으로 처리합니다',
            dpiOverride: '다른 DPI 입력', dpiOverrideDesc: '실제 마우스 설정값을 넣어 주세요',
            dpiDefer: '지금은 확인하지 않음', dpiDeferDesc: '점수 등의 분석은 가능합니다',
            dpiApply: '확정',
            dpiBlockedTitle: 'DPI가 미확인인 동안에는 다음을 표시하지 않습니다.',
            dpiBlockedList: '360도 거리(cm/360) · 감도 수준 판정 · 감도 추천',
            dpiBlockedWhy: 'DPI가 2배 다르면 360도 거리도 2배 어긋나기 때문입니다.',
            dpiMismatchTitle: '파일 기록({file})과 다른 값으로 확정했습니다.',
            dpiMismatchBody: 'KovaaK 설정도 {actual} 로 맞춰 두면 다음부터 어긋나지 않습니다.',

            profileTitle: '내 측정 프로필',
            profileLede: '지금까지 모인 데이터와 다음에 무엇을 측정할지 보여 줍니다.',
            notSaved: '(저장하지 않았습니다)',
            loggedIn: '로그인 중', notLoggedIn: '로그인하지 않음',
            loginToggle: '로그인 상태 전환 (데모)', loginLink: '로그인하기',
            capsGuest: '로그인하지 않아도 가져오기와 프로필 확인은 가능합니다. 저장은 로그인이 필요합니다.',
            capsUser: '저장하고 이어서 측정할 수 있습니다.',
            demoLabel: '표시할 데이터:',
            demoImported: '가져온 데이터', demoEnough: '인공 데이터 (추천 있음)',
            demoNotEnough: '인공 데이터 (추천 없음)', demoAdaptive: '인공 데이터 (적응형 혼재)',
            demoStored: '저장된 데이터',
            demoNote: '추천 화면은 인공 데이터로 검증합니다. KovaaK 실제 데이터는 실서비스 추천 계산에 연결하지 않았습니다.',
            profileEmptyTitle: '아직 데이터가 없습니다.',
            profileEmptyBody: '가져오기 화면에서 CSV를 읽거나 위의 인공 데이터를 선택하세요.',

            invTitle: '가져오기 현황',
            invSessions: '가져온 세션', invSources: '데이터 출처', invScenarios: '시나리오 수',
            invLevels: '시도한 감도 수', invEvidence: '근거 항목 수',
            coverageTitle: '감도 범위', coverageNone: '아직 감도 범위를 계산할 수 없습니다.',
            coverageRange: '시도한 범위', coverageLevels: '수준 수',
            coverageSkewed: '한쪽으로 치우쳐 있습니다', coverageEdge: '가장 좋은 값이 끝에 있습니다',

            metersTitle: '세 가지 지표',
            metersNote: '의미가 다르므로 하나의 게이지로 합치지 않았습니다.',
            meterCompleteness: '프로필 충실도',
            meterCompletenessDesc: '자료가 얼마나 모였는지. 추천이 맞을 가능성과는 다릅니다.',
            meterQuality: '데이터 품질',
            meterQualityDesc: '의미와 신뢰도가 확정된 항목의 비율입니다.',
            meterConfidence: '추천의 확실성',
            meterConfidenceDesc: '추천 자체의 확실성. 위의 둘과는 다른 지표입니다.',
            meterUnavailable: '아직 추천을 낼 수 없어 계산하지 않았습니다.',
            meterGaps: '부족',

            trendTitle: '점수 추이', trendNone: '아직 점수가 없습니다.',
            trendMin: '최소', trendMax: '최대',
            trendMixedNote: '시나리오가 다르면 점수 척도도 다르므로 다른 시나리오의 점을 직접 비교하지 마세요.',
            trendAdaptiveNote: '회색은 난이도가 변동한 세션입니다. 비교에는 사용하지 않습니다.',

            unresolvedTitle: '확인이 필요한 항목', unresolvedNone: '없습니다.',
            excludedTitle: '비교에서 제외한 세션', excludedNone: '없습니다.',
            excludedReason: '세션 중 난이도가 변해서 현재 감도 비교에서 제외',
            excludedKeptNote: '데이터는 보존합니다. 난이도 변화를 보정할 수 있게 되면 다시 사용할 수 있습니다.',
            excludedCount: '{n}건을 감도 비교에서 제외했습니다 (기록은 남아 있습니다).',

            fieldDpiVerified: '마우스 DPI 확인', fieldCm360: '360도 거리(cm/360)',
            fieldInGameSens: '게임 내 감도', fieldComparability: '이 세션을 비교에 쓸 수 있는지',

            recNow: '현재 추천',
            recScopeTitle: '이 추천은 에임 테스트 결과에 근거합니다',
            recScopeDisclaimer: '이 결과는 에임 테스트에서의 퍼포먼스에 기반합니다. 실제 게임에서는 무기, 이동, 교전 거리, 판단 등의 영향으로 최적 감도가 달라질 수 있습니다.',
            recScopeLayers: '현재는 기계적 에임 성능 계층만 측정하고 있습니다. 실제 게임 성적에 기반한 계층과 둘을 통합한 추천은 게임 내 데이터가 쌓일 때까지 생성하지 않습니다.',
            recScopeNotProven: '게임 내에서 최적이라고 실증된 것은 아닙니다.',
            recWithheld: '아직 추천할 수 없습니다',
            recCm360: '추천 (360도 거리)', recRange: '유력 범위 cm',
            recConfidence: '추천의 확실성', recEvidence: '사용한 데이터 수',
            recSources: '데이터 출처', recExcluded: '제외',
            recWhyToggle: '왜 이 결과인가요?',
            recWhyHeadline: '점수가 가장 높은 감도를 그대로 고르는 것이 아닙니다',
            recWhySummary: '성적뿐 아니라 흔들림이 적은지, 날짜를 넘겨도 재현되는지를 함께 봅니다.',
            recWhyNote: '컨디션 좋은 한 번만 높았던 감도보다, 늘 같게 나오는 감도를 우선합니다.',
            recWhatToDo: '추천이 가능해지려면',
            recUsable: '현재 사용 가능한 데이터',
            recWhyDpi: '마우스 DPI가 미확인이기 때문입니다. DPI가 2배 다르면 360도 거리도 2배 어긋납니다.',
            recWhyEvidence: '감도를 비교할 자료가 부족합니다.',
            recConfirmDpi: '실제 사용 중인 마우스 DPI를 확인해 주세요',
            recConfirmDpiDetail: 'DPI만 알면 이미 가져온 데이터로 계산할 수 있습니다.',
            recImportMore: '측정 데이터를 조금 더 가져와 주세요',
            recRangeMeaning: '범위의 의미',
            recSyntheticBanner: '인공 데이터로 표시를 확인한 것입니다. 실제 측정 결과가 아닙니다.',
            recLocalBanner: '가져온 데이터만으로 계산했습니다. 저장도 전송도 하지 않았습니다.',
            factorPerformance: '성적', factorPerformanceDesc: '점수 자체의 높이',
            factorStability: '안정성', factorStabilityDesc: '한 번마다의 흔들림이 적은지',
            factorRepeatability: '재현성', factorRepeatabilityDesc: '날짜를 넘겨도 같게 나오는지',
            factorRecency: '최신성', factorRecencyDesc: '최근 데이터인지',
            factorCoverage: '측정 범위', factorCoverageDesc: '앞뒤 감도도 시도했는지',

            nextExperiment: 'NEXT EXPERIMENT',
            nextSentence: '다음은 {cm}cm 로 {n}회 시도해 주세요.',
            nextScenario: '시나리오는 {name} 을(를) 사용하세요.',
            nextChipSens: '다음에 시도할 감도', nextChipCount: '필요한 횟수', nextChipScenario: '시나리오',
            nextUncertainty: '확신이 얼마나 오르는지는 수치로 내지 않습니다. 아직 근거가 없기 때문입니다.',
            reasonIncreaseLevels: '비교할 감도가 아직 부족하기 때문입니다.',
            reasonExploreEdge: '가장 좋았던 값이 시도 범위의 끝이라 그 바깥도 확인합니다.',
            reasonDistinguish: '상위 두 개의 차이를 아직 구분할 수 없기 때문입니다.',
            reasonReinforce: '이 감도의 데이터가 적기 때문입니다.',

            saveTitle: '이 기기의 데이터를 저장',
            saveReady: '{n}건을 저장할 수 있습니다.',
            saveRawNote: '원본 CSV는 저장하지 않습니다. 해시와 측정 결과만 저장합니다.',
            saveButton: '저장', saving: '저장 중…',
            saveDone: '{n}건을 저장했습니다.',
            saveSkipped: '{n}건은 이미 가져온 것이라 건너뛰었습니다.',
            saveReanalysis: '{n}건은 이전과 다른 버전으로 다시 읽었습니다.',
            saveNothingNew: '새로 가져올 것이 없었습니다.',
            saveFailed: '저장에 실패했습니다',
            saveNoBackend: '저장 기능에 연결할 수 없습니다. 가져오기와 확인은 그대로 사용할 수 있습니다.',
            saveSynthetic: '인공 데이터는 저장하지 않습니다. "가져온 데이터"로 전환하면 저장할 수 있습니다.',
            saveNoData: '저장할 데이터가 없습니다.',
            saveNeedLogin: '저장하려면 로그인이 필요합니다. 가져오기와 확인은 로그인 없이도 가능합니다.',
            saveNeedConsent: '"개인 프로필로 저장"에 동의하면 저장할 수 있습니다.',
            saveNoConsentRow: '동의 기록을 찾을 수 없습니다.',

            consentTitle: '저장과 데이터 사용처',
            consentNoNeed: '여기까지의 표시에는 동의가 필요 없습니다.',
            consentNoNeedBody: '가져오기와 프로필 확인은 동의 없이, 로그인 없이 사용할 수 있습니다.',
            consentPick: '저장할 때만, 목적별로 선택해 주세요. 하나의 체크로 묶지 않았습니다.',
            consentProfile: '개인 프로필로 저장',
            consentProfileDesc: '다음에 와도 이어서 측정할 수 있게 됩니다.',
            consentStats: '익명 집계 통계에 사용',
            consentStatsDesc: '개인을 알 수 없는 형태로 전체 경향을 내는 데 사용합니다.',
            consentModel: '모델 개선·학습에 사용',
            consentModelDesc: '추천 정확도를 높이는 데 사용합니다.',
            consentSelected: '선택한 용도로만 사용합니다.',
            consentSelectedBody: '선택하지 않은 용도로는 사용하지 않습니다.',
            consentNone: '아무것도 선택하지 않았습니다.',
            consentNoneBody: '이대로도 가져오기와 프로필 확인은 사용할 수 있습니다.',
            consentRevocable: '동의는 목적별로 기록되며 언제든 취소할 수 있습니다. 취소하면 이후 저장이 중지됩니다.',
            consentRevokeKeeps: '취소해도 이미 저장된 데이터는 자동으로 삭제하지 않습니다. 지우려면 "데이터 삭제"를 사용하세요.',

            dataTitle: '내 데이터',
            btnExport: '내 데이터 Export', btnDelete: '데이터 삭제',
            btnReload: '저장된 데이터 불러오기',
            dataFree: '삭제와 Export는 어떤 요금제가 되어도 무료로 유지합니다. 유료 기능으로 만들지 않습니다.',
            exportDone: '이 기기 안에서 파일을 만들었습니다. 전송하지 않았습니다.',
            deleteConfirm: '저장된 측정 데이터를 모두 삭제합니다. 계속할까요?',
            deleteLocalDone: '이 기기에 있던 데이터를 지웠습니다.',
            deleteDone: '삭제했습니다.',
            deleteFailed: '삭제에 실패했습니다',
            reloadNeedLogin: '로그인하면 저장된 데이터를 불러올 수 있습니다.',
            reloading: '불러오는 중…',
            reloadDone: '저장된 {n}건을 불러왔습니다.',

            errNetwork: '통신할 수 없었습니다.',
            errNetworkBody: '인터넷 연결을 확인하고 다시 시도해 주세요. 가져온 내용은 이 기기에 남아 있습니다.',
            errServer: '서버 쪽에서 문제가 발생했습니다.',
            errServerBody: '잠시 후 다시 시도해 주세요.',
            errAuth: '로그인 유효 기간이 지난 것 같습니다.',
            errAuthBody: '다시 로그인한 뒤 시도해 주세요.',
            errPermission: '이 작업을 수행할 권한이 없습니다.',
            errPermissionBody: '다른 계정의 데이터에는 접근할 수 없습니다.',
            errUnknown: '문제가 발생했습니다.',
            errUnknownBody: '다시 시도해 주세요. 가져온 내용은 이 기기에 남아 있습니다.',
            errRetrying: '다시 시도 중 ({n}회째)…',
            errGaveUp: '{n}회 시도했지만 성공하지 못했습니다.',
            offlineBanner: '오프라인입니다. 가져오기와 확인은 가능하지만 저장은 되지 않습니다.',
            onlineBanner: '연결이 복구되었습니다.'
        }
    };

    var current = DEFAULT;

    function detect() {
        var saved = null;
        try { saved = root.localStorage && root.localStorage.getItem('appLang'); } catch (e) {}
        if (saved && LANGS.indexOf(saved) >= 0) return saved;
        var nav = (root.navigator && (root.navigator.language || root.navigator.userLanguage)) || '';
        var short = String(nav).slice(0, 2).toLowerCase();
        return LANGS.indexOf(short) >= 0 ? short : DEFAULT;
    }

    /** 文字列を取り出す。{key} を params で置換する。 */
    function t(key, params) {
        var dict = D[current] || D[DEFAULT];
        var s = dict[key];
        // 訳が無ければ日本語へ落とす（画面が空欄になるより良い）
        if (s === undefined) s = D[DEFAULT][key];
        if (s === undefined) return key;
        if (!params) return s;
        return String(s).replace(/\{(\w+)\}/g, function (m, k) {
            return params[k] !== undefined ? String(params[k]) : m;
        });
    }

    function setLang(lang) {
        if (LANGS.indexOf(lang) < 0) return current;
        current = lang;
        try { root.localStorage && root.localStorage.setItem('appLang', lang); } catch (e) {}
        if (root.document) {
            root.document.documentElement.setAttribute('lang', lang);
            apply(root.document);
        }
        return current;
    }

    function getLang() { return current; }

    /** data-i18n / data-i18n-attr を持つ要素を差し替える。 */
    function apply(rootEl) {
        if (!rootEl || !rootEl.querySelectorAll) return;
        Array.prototype.forEach.call(rootEl.querySelectorAll('[data-i18n]'), function (el) {
            el.textContent = t(el.getAttribute('data-i18n'));
        });
        // 属性の翻訳: data-i18n-attr="aria-label:keyName;title:otherKey"
        Array.prototype.forEach.call(rootEl.querySelectorAll('[data-i18n-attr]'), function (el) {
            el.getAttribute('data-i18n-attr').split(';').forEach(function (pair) {
                var kv = pair.split(':');
                if (kv.length === 2) el.setAttribute(kv[0].trim(), t(kv[1].trim()));
            });
        });
    }

    /** 3言語すべてに同じ鍵があるか調べる（テスト用）。 */
    function auditKeys() {
        var base = Object.keys(D[DEFAULT]).sort();
        var report = { complete: true, missing: {}, extra: {}, keyCount: base.length };
        LANGS.forEach(function (l) {
            if (l === DEFAULT) return;
            var keys = Object.keys(D[l]);
            var missing = base.filter(function (k) { return keys.indexOf(k) < 0; });
            var extra = keys.filter(function (k) { return base.indexOf(k) < 0; });
            if (missing.length) { report.missing[l] = missing; report.complete = false; }
            if (extra.length) { report.extra[l] = extra; report.complete = false; }
        });
        return report;
    }

    current = detect();

    root.LC_I18N = {
        LANGS: LANGS, DEFAULT: DEFAULT, dict: D,
        t: t, setLang: setLang, getLang: getLang, apply: apply,
        detect: detect, auditKeys: auditKeys
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
