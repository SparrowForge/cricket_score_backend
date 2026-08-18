#!/usr/bin/env node
/**
 * Rules-engine fixture runner.
 *
 * There is no jest/vitest in this repo (see backend CLAUDE.md — scripts/ IS the
 * test suite), so this is a plain-node runner over fixtures/rotation-rules.json.
 * It exercises the PURE engine only: no database, no network, no server needed.
 *
 *   npm run build && npm run test:rules
 *
 * The same corpus is mirrored into the mobile repo at
 * code/mobile/test/fixtures/rotation_rules.json and run by
 * test/rotation_rules_test.dart. That is the whole point of the file: the
 * offline scorers mirror the engine by hand in two other languages, and a rule
 * that lands only on the server shows up as a ball that scores fine offline and
 * is rejected on sync. `--emit-mirror` rewrites the mobile copy from this one.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'fixtures', 'rotation-rules.json');
const MIRROR = path.join(ROOT, '..', 'mobile', 'test', 'fixtures', 'rotation_rules.json');
const ENGINE = path.join(ROOT, 'dist', 'matches', 'rules-engine.js');

function loadEngine() {
  if (!fs.existsSync(ENGINE)) {
    console.error('\n  dist/matches/rules-engine.js not found — run `npm run build` first.\n');
    process.exit(2);
  }
  return require(ENGINE);
}

/** Shallow merge, but `null` in the override deletes the key (used to drop solo_batting). */
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v === null && k in base) delete out[k];
    else out[k] = v;
  }
  return out;
}

function equal(actual, expected) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((v, i) => equal(actual[i], v));
  }
  if (expected && typeof expected === 'object') {
    return actual && typeof actual === 'object'
      && Object.entries(expected).every(([k, v]) => equal(actual[k], v));
  }
  return actual === expected;
}

const show = (v) => JSON.stringify(v);

function run() {
  const { applyBall } = loadEngine();
  const doc = JSON.parse(fs.readFileSync(FIXTURES, 'utf8'));
  const { defaults, cases } = doc;

  let passed = 0;
  const failures = [];

  for (const c of cases) {
    const rules = merge(defaults.rules, c.rules);
    const state = merge(defaults.state, c.state);
    const event = merge(defaults.event, c.event);

    // structuredClone so a case cannot mutate the shared defaults for the next.
    const result = applyBall(structuredClone(state), structuredClone(event), rules);
    const problems = [];

    if (result.ok !== c.expect.ok) {
      problems.push(`ok: expected ${c.expect.ok}, got ${result.ok}` +
        (result.ok === false ? ` (${result.code}: ${result.message})` : ''));
    } else if (c.expect.ok === false) {
      if (result.code !== c.expect.code) {
        problems.push(`code: expected ${c.expect.code}, got ${result.code}`);
      }
    } else {
      if (c.expect.effects) {
        const got = result.effects.map((e) => e.kind);
        if (!equal(got, c.expect.effects)) {
          problems.push(`effects: expected ${show(c.expect.effects)}, got ${show(got)}`);
        }
      }
      for (const [k, v] of Object.entries(c.expect.next ?? {})) {
        if (!equal(result.next[k], v)) {
          problems.push(`next.${k}: expected ${show(v)}, got ${show(result.next[k])}`);
        }
      }
    }

    if (problems.length === 0) {
      passed += 1;
      console.log(`  ok   ${c.name}`);
    } else {
      failures.push({ name: c.name, why: c.why, problems });
      console.log(`  FAIL ${c.name}`);
    }
  }

  console.log('');
  if (failures.length) {
    for (const f of failures) {
      console.log(`FAILED: ${f.name}`);
      if (f.why) console.log(`  rationale: ${f.why}`);
      for (const p of f.problems) console.log(`    - ${p}`);
      console.log('');
    }
  }

  // Mirror drift is a test failure in its own right: a corpus the Dart port is
  // not actually running proves nothing about the Dart port.
  let mirrorNote = '';
  if (fs.existsSync(MIRROR)) {
    const a = fs.readFileSync(FIXTURES, 'utf8').replace(/\r\n/g, '\n');
    const b = fs.readFileSync(MIRROR, 'utf8').replace(/\r\n/g, '\n');
    if (a !== b) {
      mirrorNote = 'mobile fixture copy has DRIFTED — run `npm run test:rules -- --emit-mirror`';
      failures.push({ name: 'mirror parity', problems: [mirrorNote] });
      console.log(`  FAIL mirror parity — ${mirrorNote}\n`);
    } else {
      console.log('  ok   mirror parity (mobile copy is identical)\n');
    }
  } else {
    console.log('  warn mobile fixture copy not found — skipping mirror parity\n');
  }

  console.log(`${passed}/${cases.length} engine cases passed` +
    (failures.length ? `, ${failures.length} failure(s)` : ''));
  process.exit(failures.length ? 1 : 0);
}

if (process.argv.includes('--emit-mirror')) {
  fs.mkdirSync(path.dirname(MIRROR), { recursive: true });
  fs.copyFileSync(FIXTURES, MIRROR);
  console.log(`mirrored -> ${MIRROR}`);
  process.exit(0);
}

run();
