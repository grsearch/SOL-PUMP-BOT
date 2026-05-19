'use strict';
const cfg = require('../config');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const cur = LEVELS[cfg.logLevel] ?? 1;

function ts() {
  const d = new Date();
  return d.toISOString().replace('T', ' ').slice(0, 23);
}

function fmt(level, tag, msg, extra) {
  const head = `[${ts()}] ${level.toUpperCase().padEnd(5)} ${tag ? '[' + tag + '] ' : ''}`;
  if (extra !== undefined) {
    return head + msg + ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra));
  }
  return head + msg;
}

function make(tag = '') {
  return {
    debug: (m, e) => LEVELS.debug >= cur && console.log(fmt('debug', tag, m, e)),
    info:  (m, e) => LEVELS.info  >= cur && console.log(fmt('info',  tag, m, e)),
    warn:  (m, e) => LEVELS.warn  >= cur && console.warn(fmt('warn', tag, m, e)),
    error: (m, e) => LEVELS.error >= cur && console.error(fmt('error', tag, m, e)),
    child: (sub) => make(tag ? `${tag}/${sub}` : sub),
  };
}

module.exports = make();
module.exports.child = make().child;
