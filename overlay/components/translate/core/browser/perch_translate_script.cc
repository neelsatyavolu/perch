// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "components/translate/core/browser/perch_translate_script.h"

namespace translate {

BASE_FEATURE(kPerchOnDeviceTranslate, base::FEATURE_ENABLED_BY_DEFAULT);

namespace {

// Runs in the translate isolated world. The agent polls libReady, finished
// and error, reads sourceLang and translationTime, and calls translate(src,
// tgt) and revert(). Error codes follow translate::TranslateErrors:
// 6 TRANSLATION_ERROR, 9 UNSUPPORTED_LANGUAGE.
constexpr char kScript[] = R"JS(
(() => {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE',
                        'KBD', 'SAMP', 'SVG', 'MATH', 'TEMPLATE']);
  const originals = new Map();
  const state = {
    libReady: true,
    finished: false,
    error: false,
    errorCode: 0,
    sourceLang: '',
    translationTime: 0,
    readyTime: 0,
    loadTime: 0,
  };

  function textNodes() {
    const walker = document.createTreeWalker(document.body || document,
        NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            for (let el = node.parentElement; el; el = el.parentElement) {
              if (SKIP.has(el.tagName) || el.isContentEditable ||
                  el.getAttribute('translate') === 'no' ||
                  el.classList.contains('notranslate')) {
                return NodeFilter.FILTER_REJECT;
              }
            }
            return /\S/.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT
                                             : NodeFilter.FILTER_REJECT;
          },
        });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function fail(code) {
    state.error = true;
    state.errorCode = code;
    state.finished = true;
  }

  async function translate(source, target) {
    const start = performance.now();
    state.finished = false;
    state.error = false;
    state.errorCode = 0;
    try {
      if (typeof Translator === 'undefined') return fail(6);
      const options = {sourceLanguage: source, targetLanguage: target};
      if (await Translator.availability(options) === 'unavailable') {
        return fail(9);
      }
      const translator = await Translator.create(options);
      const nodes = textNodes();
      let next = 0;
      async function worker() {
        while (next < nodes.length) {
          const node = nodes[next++];
          const text = node.nodeValue;
          const lead = text.match(/^\s*/)[0];
          const trail = text.match(/\s*$/)[0];
          const translated = await translator.translate(text.trim());
          if (!originals.has(node)) originals.set(node, text);
          node.nodeValue = lead + translated + trail;
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()]);
      state.sourceLang = source;
      state.translationTime = performance.now() - start;
      state.finished = true;
    } catch (e) {
      fail(6);
    }
  }

  function revert() {
    for (const [node, text] of originals) node.nodeValue = text;
    originals.clear();
  }

  self.cr = self.cr || {};
  cr.googleTranslate = Object.assign(state, {
    translate(source, target) {
      translate(source, target);
      return true;
    },
    revert,
    onTranslateElementError() { fail(6); },
  });
})();
)JS";

}  // namespace

std::string PerchTranslateScript() {
  return kScript;
}

}  // namespace translate
