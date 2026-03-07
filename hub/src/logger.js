'use strict';

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const MIN_LEVEL = LEVELS[(process.env.LOG_LEVEL || 'INFO').toUpperCase()] ?? LEVELS.INFO;

function ts() {
    return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function log(level, tag, msg) {
    if (LEVELS[level] < MIN_LEVEL) return;
    const line = `[${ts()}] [${level}] [${tag}] ${msg}`;
    if (level === 'ERROR') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
}

function makeLogger(tag) {
    return {
        debug: (msg) => log('DEBUG', tag, msg),
        info: (msg) => log('INFO', tag, msg),
        warn: (msg) => log('WARN', tag, msg),
        error: (msg) => log('ERROR', tag, msg),
    };
}

module.exports = { makeLogger };
