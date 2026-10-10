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
        const out = suggestParamMapping([]);
        for (const key of Object.keys(PARAM_FUZZY_MAP)) {
            assert.ok(key in out, `缺少映射键 ${key}`);
            assert.strictEqual(out[key], null);
        }
    });
});
