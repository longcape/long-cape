// 回帰テストで使う入力パターンの定義。
//
// ここを変えるとベースラインが総入れ替えになるため、原則として追加のみ行う。
// パターンを増やしたい場合は EXTRA_CASES 側へ足すと、既存行の並びを崩さずに済む。

// games.json からは読まず、あえてここに固定する。
// レジストリ側の事故（タイトルの消失など）でテスト範囲が黙って縮まないようにするため。
// タイトルを増やしたらここへ追記し、baseline を --update で作り直す。
export const GAME_KEYS = ['valo', 'apex', 'ow', 'fn', 'delta', 'cod', 'pubg'];

const HEIGHTS = [150, 160, 170, 180, 190];
const DEXTERITY = ['1', '2', '3', '4', '5'];
const ARM = ['slim', 'normal', 'heavy'];
const WEIGHT = ['ultra', 'standard', 'mid', 'heavy', 'ultraheavy'];
const PIVOT = ['wrist', 'arm', 'shoulder'];

/** 全身体パラメータの直積 × 全タイトル（DPI は 800 固定）。 */
function mainGrid() {
    const cases = [];
    for (const game of GAME_KEYS) {
        for (const height of HEIGHTS) {
            for (const dexterity of DEXTERITY) {
                for (const armThickness of ARM) {
                    for (const mouseWeight of WEIGHT) {
                        for (const aimPart of PIVOT) {
                            cases.push({
                                game, height, dexterity, armThickness, mouseWeight, aimPart, dpi: 800,
                            });
                        }
                    }
                }
            }
        }
    }
    return cases;
}

/** DPI 依存と境界値。PUBG の clamp(1,100) に当たる極端な条件を含める。 */
function extraCases() {
    const cases = [];
    const profiles = [
        { height: 150, dexterity: '1', armThickness: 'heavy', mouseWeight: 'ultraheavy', aimPart: 'wrist' },
        { height: 170, dexterity: '3', armThickness: 'normal', mouseWeight: 'standard', aimPart: 'arm' },
        { height: 190, dexterity: '5', armThickness: 'slim', mouseWeight: 'ultra', aimPart: 'shoulder' },
    ];
    // DPI 未入力（800 とみなす）と 0（不正値 → 800 フォールバック）も通す
    const dpis = [null, 0, 100, 400, 800, 1600, 3200, 6400, 25600];
    for (const game of GAME_KEYS) {
        for (const p of profiles) {
            for (const dpi of dpis) {
                cases.push({ game, ...p, dpi });
            }
        }
    }
    return cases;
}

export const CASES = [...mainGrid(), ...extraCases()];

export const CSV_HEADER = 'game,height,dexterity,arm,weight,pivot,dpi,final_sens,display';

export function caseToCsv(c, result) {
    const dpi = c.dpi === null ? '' : c.dpi;
    return [
        c.game, c.height, c.dexterity, c.armThickness, c.mouseWeight, c.aimPart, dpi,
        result.finalSens, result.display,
    ].join(',');
}
