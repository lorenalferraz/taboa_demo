'use strict';

const crypto = require('crypto');

const EMAIL = 'lorenalferraz@gmail.com';
const KEY = Buffer.from('dK7WSJtPq1qyaMYaSNgxFYLAQJfSs9h433J69MRnZQI=', 'base64');
const BOX = {
  iv: 'vhc29yMvN81/TInH',
  tag: 'I8tIWRyJRznYKe59TsCGOA==',
  data: 'fxOEIzQnfHFngA==',
};

function decryptPassword() {
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(BOX.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(BOX.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(BOX.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function mapbiomasCredentials() {
  const email = String(process.env.MAPBIOMAS_EMAIL || EMAIL).trim();
  const password = process.env.MAPBIOMAS_PASSWORD || decryptPassword();
  return { email, password };
}

module.exports = { mapbiomasCredentials };
