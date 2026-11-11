'use strict';

/**
 * Minimal PASS/FAIL/SKIP reporter shared by the integration checks.
 *
 * Integration checks run against a real Claude Desktop install, so they also
 * report SKIP when a prerequisite is missing (no portable copy, package not
 * readable). A skip is never a pass: the summary states how many checks were
 * skipped, so a green run cannot hide missing coverage.
 */

function createReport(title) {
  const results = [];

  function record(status, name, detail) {
    results.push({ status, name, detail });
    const suffix = detail ? `  -> ${detail}` : '';
    console.log(`  ${status.padEnd(4)}  ${name}${suffix}`);
  }

  return {
    section(name) {
      console.log(`\n${name}`);
    },
    pass(name, detail) {
      record('PASS', name, detail);
    },
    fail(name, detail) {
      record('FAIL', name, detail);
    },
    skip(name, reason) {
      record('SKIP', name, reason);
    },
    check(name, condition, detail) {
      if (condition) this.pass(name);
      else this.fail(name, detail);
    },
    finish() {
      const failed = results.filter((r) => r.status === 'FAIL').length;
      const passed = results.filter((r) => r.status === 'PASS').length;
      const skipped = results.filter((r) => r.status === 'SKIP').length;
      console.log('\n' + '-'.repeat(56));
      const verdict = failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`;
      console.log(`${verdict}  (${passed} passed, ${failed} failed, ${skipped} skipped)`);
      return failed === 0 ? 0 : 1;
    },
  };
}

/** Parse `--flag value` / `--flag=value` arguments; positionals land in `_.` */
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[token.slice(2)] = argv[++i];
    } else {
      args[token.slice(2)] = true;
    }
  }
  return args;
}

module.exports = { createReport, parseArgs };
