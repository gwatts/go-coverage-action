const core = require('@actions/core');
const github = require('@actions/github');
const {execFile} = require("child_process");
const {promisify} = require("util")
const path = require('path');

const execFileCmd = promisify(execFile)

const tmpdir = process.env['RUNNER_TEMP'];



async function exec(cmd, args) {
  const wd = core.getInput('working-directory');
  try {
    core.info(`executing ${cmd} ${args.join(' ')}`);
    const {stdout, stderr} = await execFileCmd(cmd, args,
      {
        cwd: wd,
        env: {
          ...process.env,
          'GIT_AUTHOR_NAME': 'Go Coverage Action',
          'GIT_AUTHOR_EMAIL': '<>',
          'GIT_COMMITTER_NAME': 'Go Coverage Action',
          'GIT_COMMITTER_EMAIL': '<>',
        },
      });
    if (stdout.trim()) {
      core.info(stdout.trim());
    }
    if (stderr.trim()) {
      core.info(stderr.trim());
    }
    return stdout;
  } catch (error) {
    core.error(`Failed to run ${cmd} ${args.join(' ')}: ${error}`);
    core.setFailed(error.message);
    process.exit(1);
  }
}

async function logGoVersion() {
  const result = await exec('go', ['version']);
  core.info(result);
}

async function setCoverageNote(newPct) {
  await exec('git', ['notes',
    '--ref=gocoverage',
    'add',
    '-f', '-m', `gocov=${newPct}`, github.context.sha]);
  return await exec('git', ['push', 'origin', 'refs/notes/gocoverage']);
}

async function getPriorCoverage(ref) {
  const stdout = await exec('git', ['log', '--notes=gocoverage', '--pretty=format:%H:%N', '--grep=gocov', '-n', '1', ref]);
  const m = stdout.match(/^(\w+):gocov=([\d.]+)/);

  if (m) {
    core.debug(`returning sha=${m[1]} and priorPct ${Number(m[2])}`);
    return {priorSha: m[1], priorPct: Number(m[2])};
  }
  core.info(`no prior coverage found`);
  return {};
}


async function generateReport() {
  let report = {
    'pkg_count': 0,
    'with_tests': 0,
    'no_tests': 0,
    'coverage_pct': 0,
    'pathname': '',
  };

  await logGoVersion();

  const covFile = path.join(tmpdir, 'go.cov');
  core.setOutput('gocov-pathname', covFile);

  const filename = core.getInput('report-filename');
  report.pathname = filename.startsWith('/') ? filename : path.join(tmpdir, filename);
  core.setOutput('report-pathname', report.pathname);


  const coverMode = core.getInput('cover-mode');

  const testArgs = JSON.parse(core.getInput('test-args'));

  let args = ['test'].concat(testArgs).concat(
    ['-covermode', coverMode, '-coverprofile', covFile, './...']);
  let stdout = await exec('go', args);

  for (const m of stdout.matchAll(/^(\?|ok)/gm)) {
    report.pkg_count++;
    if (m[0] == 'ok') {
      report.with_tests++;
    } else {
      report.no_tests++;
    }
  }

  await exec('go', ['tool', 'cover', '-html', covFile, '-o', report.pathname]);
  core.info(`Generated ${report.pathname}`);

  stdout = await exec('go', ['tool', 'cover', '-func', covFile]);
  const m = stdout.match(/^total:.+\s([\d.]+)%/m);
  if (!m) {
    core.error(`Failed to parse output of go tool cover.  Output was ${stdout}`);
    core.setFailed('parse error');
    return;
  }

  report.coverage_pct = Number(m[1]);

  return report;
}


async function run() {
  const report = await generateReport();
  if (!report) {
    return;
  }

  await exec('git', ['fetch', 'origin', 
    'refs/notes/gocoverage:refs/notes/gocoverage']);

  let priorPct, priorSha;
  if (github.context.payload.pull_request) {
    const base_sha = github.context.payload.pull_request.base.sha;
    ({priorPct, priorSha} = await getPriorCoverage(base_sha));

  } else if (github.context.payload.before) {
    ({priorPct, priorSha} = await getPriorCoverage(github.context.payload.before));

  }

  const minPct = Number(core.getInput('coverage-threshold'));
  const isBelowThreshold = (minPct > report.coverage_pct);

  core.info(`Found ${report.pkg_count} packages`);
  core.info(`Packages with tests: ${report.with_tests}`);
  core.info(`Packages with zero tests: ${report.no_tests}`);
  core.info(`Total coverage: ${report.coverage_pct}%`);
  core.info(`Minimum required coverage: ${minPct}%`);

  core.setOutput('coverage-pct', report.coverage_pct);
  core.setOutput('package-count', report.pkg_count);
  core.setOutput('uncovered-packages', report.no_tests);

  let commitComment = `Go test coverage: ${report.coverage_pct}`;

  if (priorPct != undefined) {
    core.info(`Previous coverage: ${priorPct}% as of ${priorSha}`);
    const delta = report.coverage_pct - priorPct;
    const deltaFmt = Intl.NumberFormat('en-US', {signDisplay: 'exceptZero'}).format(delta);
    core.info(`Coverage delta: ${deltaFmt}%`);
    core.setOutput('coverage-delta', delta);
    core.setOutput('coverage-last-pct', priorPct);
    core.setOutput('coverage-last-sha', priorSha);

    commitComment = `:arrow_right: Go test coverage stayed the same at ${report.coverage_pct}% compared to ${priorSha}`;
    if (delta > 0) {
      commitComment = `:arrow_up: Go test coverage increased from ${priorPct}% to ${report.coverage_pct}% compared to ${priorSha}`;
    } else if (delta < 0) {
      commitComment = `:arrow_down: Go test coverage decreased from ${priorPct}% to ${report.coverage_pct}% compared to ${priorSha}`;
    }
  } else {
    core.info('No prior coverage information found in log');
    core.setOutput('coverage-delta', 0);
  }
  if (report.no_tests > 0) {
    commitComment += `\n$:warning: {report.no_tests} of ${report.pkg_count} packages have zero coverage.`
  }

  await setCoverageNote(report.coverage_pct);

  const reportUrl = core.getInput('report-url');
  if (reportUrl) {
    commitComment += `\n\n[View full coverage report](${reportUrl})`;
  }

  if (isBelowThreshold) {
    commitComment += `\n\n:no_entry: Coverage does not meet minimum requirement of ${minPct}%.`;
  }


  if (github.context.payload.pull_request) {
    const token = core.getInput('token');
    const octokit = github.getOctokit(token);
    const pr_number = github.context.payload.pull_request.number;
    await octokit.rest.issues.createComment({
      owner: github.context.payload.repository.owner.login,
      repo: github.context.payload.repository.name,
      issue_number: pr_number,
      body: commitComment,
    });

    if (isBelowThreshold) {
      core.error(`Code coverage of ${report.coverage_pct}% falls below minimum required coverage of ${minPct}%`);
      core.setFailed(`Code coverage of ${report.coverage_pct}% falls below minimum required coverage of ${minPct}%`);
    }
  }
}

run();
