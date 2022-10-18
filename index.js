const core = require('@actions/core');
const github = require('@actions/github');
const {execa} = require('execa');
const path = require('path');
const {version} = require('./package.json');



const tmpdir = process.env['RUNNER_TEMP'];
const ctx = github.context;


const DATA_FMT_VERSION = 1;


async function exec(cmd, args, stdin) {
  try {
    const wd = core.getInput('working-directory');
    core.startGroup(`$ ${cmd} ${args.join(' ')}`);
    const subprocess = execa(cmd, args,
      {
        cwd: wd,
        env: {
          ...process.env,
          'GIT_AUTHOR_NAME': 'Go Coverage Action',
          'GIT_AUTHOR_EMAIL': '<>',
          'GIT_COMMITTER_NAME': 'Go Coverage Action',
          'GIT_COMMITTER_EMAIL': '<>',
        },
        all: true,
        input: stdin,
      });
    subprocess.all.pipe(process.stdout);
    const {all} = await subprocess;
    return {output: all};
  } catch (e) {
    core.warning(`Failed to run ${cmd} ${args.join(' ')}`);
    throw (e);
  } finally {
    core.endGroup();
  }
}


async function setup() {
  await exec('go', ['version']);
  await fetchCoverage();
}


async function fetchCoverage() {
  try {
    await exec('git', ['fetch', 'origin',
      '+refs/notes/gocoverage:refs/notes/gocoverage']);
  } catch (e) {
    // expected to fail if the ref hasn't been created yet
    core.info('no existing gocoverage ref');
  }
}


async function setCoverageNote(data) {
  const jsdata = JSON.stringify(data);
  await fetchCoverage();
  await exec('git', ['notes',
    '--ref=gocoverage',
    'add',
    '-f', '--file=-', ctx.sha], jsdata);
  await exec('git', ['push', 'origin', 'refs/notes/gocoverage']);
}


async function getPriorCoverage() {
  const stats = {'coverage_pct': null, 'pkg_stats': {}};
  const pl = ctx.payload;
  const ref = pl.pull_request ? pl.pull_request.base.sha : pl.before;
  if (!ref) {
    return stats;
  }
  try {
    const {output} = await exec('git',
      ['log',
        '--notes=gocoverage',
        '--pretty=format:%H%n%N',
        '--grep=coverage_pct', '-n', '1', ref]);

    try {
      const lines = output.split('\n');
      const sha = lines[0];
      const data = JSON.parse(lines[1]);
      data['sha'] = sha;
      return data;
    } catch (e) {
      core.info(`failed to decode prior coverage: ${e}`);
      return stats;
    }
  } catch (e) {
    // git log may fail if an invalid ref is given; that's ok.
  }
  core.info(`no prior coverage found`);
  return stats;
}

function packageDelta(prior, now) {
  const priorPkgNames = Object.keys(prior);
  const nowPkgNames = Object.keys(now);
  const allNames = new Set(priorPkgNames.concat(nowPkgNames));
  const pkgs = [];
  for (const pkgName of [...allNames].sort()) {
    const priorPct = prior[pkgName]?.[0] || 0;
    const nowPct = now[pkgName]?.[0] || 0;
    if (priorPct != nowPct) {
      pkgs.push([pkgName, priorPct, nowPct]);
    }
  }
  return pkgs;
}

async function generateCoverage() {
  const report = {
    'pkg_count': 0,
    'with_tests': 0,
    'no_tests': 0,
    'coverage_pct': 0,
    'reportPathname': '',
    'gocovPathname': '',
  };

  report.gocovPathname = path.join(tmpdir, 'go.cov');

  const filename = core.getInput('report-filename');
  report.reportPathname = filename.startsWith('/') ? filename : path.join(tmpdir, filename);


  const coverMode = core.getInput('cover-mode');
  const coverPkg = core.getInput('cover-pkg');

  let testArgs;
  try {
    testArgs = JSON.parse(core.getInput('test-args'));
    if (!Array.isArray(testArgs)) {
      throw ('not an array');
    }
  } catch (e) {
    throw (`invalid value for test-args; must be a JSON array of strings, got ${testArgs} (${e})`);
  }

  const args = ['test'].concat(testArgs).concat([
    '-covermode', coverMode,
    '-coverprofile', report.gocovPathname,
    ...(coverPkg ? ['-coverpkg', coverPkg] : []),
    './...'
  ]);
  const {output: testOutput} = await exec('go', args);

  const pkgStats = {};
  for (const m of testOutput.matchAll(/^(\?|ok)\s+([^\t]+)(.+coverage: ([\d.]+)%)?/gm)) {
    report.pkg_count++;

    if (m[1] == 'ok') {
      report.with_tests++;
      pkgStats[m[2]] = [Number(m[4])];  // an array so additional fields can easily be added later
    } else {
      report.no_tests++;
      pkgStats[m[2]] = [0];
    }
  }


  await exec('go', ['tool', 'cover', '-html', report.gocovPathname, '-o', report.reportPathname]);
  core.info(`Generated ${report.reportPathname}`);

  const {output: coverOutput} = await exec('go', ['tool', 'cover', '-func', report.gocovPathname]);
  const m = coverOutput.match(/^total:.+\s([\d.]+)%/m);
  if (!m) {
    throw ('Failed to parse output of go tool cover');
  }

  report.coverage_pct = Number(m[1]);
  report.pkg_stats = pkgStats;

  return report;
}


const commentMarker = '<!-- gocovaction -->';

async function generatePRComment(stats) {
  let commitComment = `${commentMarker}Go test coverage: ${stats.current.coverage_pct}% for commit ${ctx.sha}`;

  if (stats.prior.coverage_pct != null) {
    core.info(`Previous coverage: ${stats.prior.coverage_pct}% as of ${stats.prior.sha}`);

    commitComment = `${commentMarker}:arrow_right: Go test coverage stayed the same at ${stats.current.coverage_pct}% compared to ${stats.prior.sha}`;
    if (stats.deltaPct > 0) {
      commitComment = `${commentMarker}:arrow_up: Go test coverage increased from ${stats.prior.coverage_pct}% to ${stats.current.coverage_pct}% compared to ${stats.prior.sha}`;
    } else if (stats.deltaPct < 0) {
      commitComment = `${commentMarker}:arrow_down: Go test coverage decreased from ${stats.prior.coverage_pct}% to ${stats.current.coverage_pct}% compared to ${stats.prior.sha}`;
    }
  } else {
    core.info('No prior coverage information found in log');
  }
  if (stats.current.no_tests > 0) {
    commitComment += `\n:warning: ${stats.current.no_tests} of ${stats.current.pkg_count} packages have zero coverage.`
  }

  if (!stats.meetsThreshold) {
    commitComment += `\n:no_entry: Coverage does not meet minimum requirement of ${stats.minPct}%.\n`;
  }

  const reportUrl = core.getInput('report-url');
  if (reportUrl) {
    commitComment += `\n\n[View full coverage report](${reportUrl})\n`;
  }


  if (stats.prior.coverage_pct !== null) {
    const delta = packageDelta(stats.prior.pkg_stats, stats.current.pkg_stats);
    if (delta.length) {
      const maxPkgLen = Math.max.apply(null, delta.map(pkg => pkg[0].length));
      commitComment += '\nUpdated Packages:\n\n```diff\n';
      commitComment += `# ${'Package Name'.padEnd(maxPkgLen, ' ')} | Prior Coverage | New Coverage\n`;
      for (const pkg of delta) {
        const [pkgName, priorPct, newPct] = pkg;
        const priorPctFmt = priorPct.toFixed(1) + '%';
        const newPctFmt = newPct.toFixed(1) + '%';
        commitComment += `${newPct >= priorPct ? '+' : '-'} ${pkgName.padEnd(maxPkgLen, ' ')} | ${priorPctFmt.padEnd(6, ' ')}         | ${newPctFmt.padEnd(5, ' ')}\n`;
      }
      commitComment += '```\n\n';
    } else {
      commitComment += `\nNo change in coverage for any package.\n\n`;
    }
  }

  return commitComment;

}


async function findPreviousComment(octokit, issue_number) {
  const it = octokit.paginate.iterator(octokit.rest.issues.listComments, {
    owner: ctx.payload.repository.owner.login,
    repo: ctx.payload.repository.name,
    issue_number: issue_number,
    per_page: 100
  });

  for await (const {data: comments} of it) {
    for (const comment of comments) {
      if (comment.body.startsWith(commentMarker)) {
        return comment.id;
      }
    }
  }
  return null;
}

async function generateReport() {
  await setup();

  const current = await generateCoverage();
  const prior = await getPriorCoverage();
  const minPct = Number(core.getInput('coverage-threshold'));
  const deltaPct = current.coverage_pct - prior.coverage_pct;

  const stats = {
    current,
    prior,
    deltaPct,
    minPct,
    meetsThreshold: current.coverage_pct > minPct,
    deltaPctFmt: Intl.NumberFormat('en-US', {signDisplay: 'exceptZero'}).format(deltaPct)
  };


  core.info(`Found ${stats.current.pkg_count} packages`);
  core.info(`Packages with tests: ${stats.current.with_tests}`);
  core.info(`Packages with zero tests: ${stats.current.no_tests}`);
  core.info(`Total coverage: ${stats.current.coverage_pct}%`);
  core.info(`Minimum required coverage: ${stats.minPct}%`);
  core.info(`Coverage delta: ${stats.deltaPctFmt}%`);

  core.startGroup('Set output values');
  core.setOutput('coverage-pct', stats.current.coverage_pct);
  core.setOutput('package-count', stats.current.pkg_count);
  core.setOutput('uncovered-packages', stats.current.no_tests);

  core.setOutput('coverage-delta', stats.deltaPct);
  core.setOutput('coverage-last-pct', stats.prior.coverage_pct);
  core.setOutput('coverage-last-sha', stats.prior.sha);
  core.setOutput('meets-threshold', stats.meetsThreshold);
  core.setOutput('gocov-pathname', current.gocovPathname);
  core.setOutput('report-pathname', current.reportPathname);
  core.endGroup();

  const nowData = {
    'go-coverage-action-fmt': DATA_FMT_VERSION,
    'coverage_pct': current.coverage_pct,
    'pkg_stats': current.pkg_stats,
  };
  await setCoverageNote(nowData);


  if (!stats.meetsThreshold) {
    const fail_policy = core.getInput('fail-coverage');
    if (fail_policy == 'always' || (fail_policy == 'only_pull_requests' && ctx.payload.pull_request)) {
      core.setFailed(`Code coverage of ${stats.current.coverage_pct}% falls below minimum required coverage of ${stats.minPct}%`);
    } else {
      core.warning(`Code coverage of ${stats.current.coverage_pct}% falls below minimum required coverage of ${stats.minPct}%`);
    }
  }



  const comment = await generatePRComment(stats);
  await core.summary
    .addRaw(comment)
    .write();

  if (core.getBooleanInput('add-comment') && ctx.payload.pull_request) {
    const token = core.getInput('token');
    const octokit = github.getOctokit(token);
    const pr_number = ctx.payload.pull_request.number;
    const prev_comment_id = await findPreviousComment(octokit, pr_number);
    if (prev_comment_id) {
      core.info(`Updating existing comment id ${prev_comment_id}`);
      await octokit.rest.issues.updateComment({
        owner: ctx.payload.repository.owner.login,
        repo: ctx.payload.repository.name,
        comment_id: prev_comment_id,
        body: comment
      });
    } else {
      core.info('Creating new comment');
      await octokit.rest.issues.createComment({
        owner: ctx.payload.repository.owner.login,
        repo: ctx.payload.repository.name,
        issue_number: pr_number,
        body: comment,
      });
    }
  }
}



async function run() {
  try {
    core.info(`Running go-coverage-action version ${version}`);

    await generateReport();
  } catch (e) {
    core.setFailed(e);
  }
}


run();
