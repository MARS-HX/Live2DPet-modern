/**
 * i18n Helper — Main process translation function.
 * Extracted from main.js lines 180-186.
 */
const I18N = require('../i18n/locales');

function createI18nHelper(ctx) {
    function mt(key) {
        const lang = ctx._cachedLang || 'en';
        return (I18N[lang] && I18N[lang][key]) || (I18N['en'] && I18N['en'][key]) || key;
    }
    return { mt };
}

module.exports = { createI18nHelper };
