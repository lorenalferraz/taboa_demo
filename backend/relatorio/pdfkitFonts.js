'use strict';

/**
 * O pdfkit pede Helvetica com require('#standard-fonts/Helvetica').
 * Na Vercel esse require devolve um objeto vazio ou embrulhado, e o PDF
 * morre com "Invalid standard font data". Carregamos o arquivo da pasta
 * e devolvemos o objeto da fonte.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const FONT_DIR = path.join(__dirname, 'standard-fonts');

function fontFile(request) {
  const rel = String(request).split('standard-fonts/').pop();
  return path.join(FONT_DIR, rel.endsWith('.cjs') ? rel : `${rel}.cjs`);
}

function compileFont(file) {
  const m = new Module(file);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(fs.readFileSync(file, 'utf8'), file);
  const exp = m.exports;
  if (exp && exp.name) return exp;
  if (exp && exp.default && exp.default.name) return exp.default;
  return exp;
}

function fontDataFrom(request, loaded) {
  if (loaded && loaded.name) return loaded;
  if (loaded && loaded.default && loaded.default.name) return loaded.default;
  const file = fontFile(request);
  if (fs.existsSync(file)) return compileFont(file);
  return loaded;
}

if (!global.__TABOA_PDFKIT_FONTS__) {
  global.__TABOA_PDFKIT_FONTS__ = true;
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (typeof request === 'string' && request.includes('standard-fonts/')) {
      const file = fontFile(request);
      if (fs.existsSync(file)) return file;
    }
    return origResolve.call(this, request, parent, isMain, options);
  };
  const origRequire = Module.prototype.require;
  Module.prototype.require = function (request) {
    const loaded = origRequire.apply(this, arguments);
    if (typeof request === 'string' && request.includes('standard-fonts/')) {
      return fontDataFrom(request, loaded);
    }
    return loaded;
  };
}

require('./standard-fonts/Courier.cjs');
require('./standard-fonts/CourierBold.cjs');
require('./standard-fonts/CourierBoldOblique.cjs');
require('./standard-fonts/CourierOblique.cjs');
require('./standard-fonts/Helvetica.cjs');
require('./standard-fonts/HelveticaBold.cjs');
require('./standard-fonts/HelveticaBoldOblique.cjs');
require('./standard-fonts/HelveticaOblique.cjs');
require('./standard-fonts/Symbol.cjs');
require('./standard-fonts/TimesBold.cjs');
require('./standard-fonts/TimesBoldItalic.cjs');
require('./standard-fonts/TimesItalic.cjs');
require('./standard-fonts/TimesRoman.cjs');
require('./standard-fonts/ZapfDingbats.cjs');
