/**
 * model-import 的 suggestParamMapping 回归用例。
 *
 * 起因：调用方把 CDI 里的参数 Id 直接推进数组（`cdiJson.Parameters.map(p => p.Id)`），
 * 而 Live2D 的 CDI 规范允许 Parameters 条目只有 Name/GroupId、没有 Id —— 于是数组里
 * 会出现 undefined，`p.toLowerCase()` 抛 TypeError。异常被导入处理器外层的 catch 吞掉，
 * 用户只看到一句泛化的失败，参数/表情/动作列表一并丢失。
 *
 * 运行：node --test tests/test-model-import.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');

const { suggestParamMapping, PARAM_FUZZY_MAP } = require('../src/main/model-import');

describe('suggestParamMapping', () => {
    it('按候选名做大小写不敏感匹配', () => {
        const out = suggestParamMapping(['ParamAngleX', 'ParamEyeBallY']);
        assert.strictEqual(out.angleX, 'ParamAngleX');
        assert.strictEqual(out.eyeBallY, 'ParamEyeBallY');
        assert.strictEqual(out.angleY, null, '没出现的参数应为 null');
    });

    it('遇到没有 Id 的参数值不得抛异常（回归：整次导入会因此失败）', () => {
        const dirty = ['ParamAngleX', undefined, null, 0, {}, 'ParamEyeBallY'];
        assert.doesNotThrow(() => suggestParamMapping(dirty));
        const out = suggestParamMapping(dirty);
        assert.strictEqual(out.angleX, 'ParamAngleX', '脏数据不该影响正常项的匹配');
        assert.strictEqual(out.eyeBallY, 'ParamEyeBallY');
    });

    it('非数组输入也不抛', () => {
        for (const bad of [undefined, null, 'ParamAngleX', 42, {}]) {
            assert.doesNotThrow(() => suggestParamMapping(bad), `输入 ${String(bad)} 不该抛`);
        }
        assert.strictEqual(suggestParamMapping(undefined).angleX, null);
    });

    it('返回的键与 PARAM_FUZZY_MAP 完全对应，未命中的一律为 null', () => {
        // 期望键集写成字面量：如果拿实现自己遍历的那张表来断言，这条只能证明
        // "实现没有脱离那张表"，把表里的候选别名删掉也照样绿。
        const expectedKeys = ['angleX', 'angleY', 'angleZ', 'bodyAngleX', 'eyeBallX', 'eyeBallY'];
        assert.deepStrictEqual(Object.keys(PARAM_FUZZY_MAP).sort(), expectedKeys.slice().sort(),
            'PARAM_FUZZY_MAP 的键集变了，请同步本用例的期望值');

        const out = suggestParamMapping([]);
        assert.deepStrictEqual(Object.keys(out).sort(), expectedKeys.slice().sort());
        for (const key of expectedKeys) {
            assert.strictEqual(out[key], null, `${key} 不该凭空命中`);
        }
    });

    it('每个映射键的候选别名都能命中真实实现', () => {
        // 逐个别名单独喂进去，必须都能认出来（防止候选表被误删/写错）。
        for (const [key, candidates] of Object.entries(PARAM_FUZZY_MAP)) {
            assert.ok(Array.isArray(candidates) && candidates.length > 0, `${key} 的候选表不该为空`);
            for (const alias of candidates) {
                const out = suggestParamMapping([alias]);
                assert.strictEqual(out[key], alias, `别名 ${alias} 应当命中 ${key}`);
            }
        }
    });
});
