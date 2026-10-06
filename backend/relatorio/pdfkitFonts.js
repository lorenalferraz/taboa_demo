'use strict';

/**
 * O pdfkit pede Helvetica com require('#standard-fonts/Helvetica').
 * Na Vercel esse caminho aponta para um arquivo que o pacote não leva,
 * e a função morre antes de responder (o navegador mostra isso como CORS).
 * As fontes ficam nesta pasta e o resolve é redirecionado para cá.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const FONT_DIR = path.join(__dirname, 'standard-fonts');

if (!global.__TABOA_PDFKIT_FONTS__) {
  global.__TABOA_PDFKIT_FONTS__ = true;
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (typeof request === 'string' && request.includes('standard-fonts/')) {
      const rel = request.split('standard-fonts/').pop();
      const file = path.join(FONT_DIR, rel.endsWith('.cjs') ? rel : `${rel}.cjs`);
      if (fs.existsSync(file)) return file;
    }
    return orig.call(this, request, parent, isMain, options);
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
