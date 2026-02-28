import { execSync } from 'child_process';
import * as core from '@actions/core';
import * as github from '@actions/github';
import * as semver from 'semver';

const CONVENTIONAL_COMMIT_REGEX = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?!?:\s.+$/;

type BumpType = 'major' | 'minor' | 'patch' | 'none';
type FloatingTagMode = 'off' | 'major' | 'major+minor';

interface CommitInfo {
  message: string;
  sha: string;
}

function parseFloatingTagMode(input: string): FloatingTagMode {
  const raw = (input || '').trim().toLowerCase();

  if (raw === 'false' || raw === 'off' || raw === '0' || raw === 'no') return 'off';
  if (raw === 'minor' || raw === 'major+minor' || raw === 'major,minor' || raw === 'majorminor') return 'major+minor';

  // Back-compat: default/true => major-only
  return 'major';
}

function parseBooleanInput(input: string, defaultValue: boolean): boolean {
  const raw = (input || '').trim().toLowerCase();
  if (raw === '') return defaultValue;
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  return defaultValue;
}

async function run(): Promise<void> {
  try {
    const token = core.getInput('github-token', { required: true });
    const tagPrefix = core.getInput('tag-prefix') || 'v';
    const initialVersion = core.getInput('initial-version') || '0.0.0';
    const floatingTagMode = parseFloatingTagMode(core.getInput('floating-tag'));
    const createRelease = parseBooleanInput(core.getInput('create-release'), false);
    const preReleaseCommand = (core.getInput('pre-release-command') || '').trim() || null;

    const octokit = github.getOctokit(token);
    const context = github.context;

    core.info(`Event: ${context.eventName}`);
    core.info(`Repository: ${context.repo.owner}/${context.repo.repo}`);

    if (context.eventName === 'pull_request') {
      await handlePullRequest(context);
    } else if (context.eventName === 'push') {
      await handlePush(octokit, context, tagPrefix, initialVersion, floatingTagMode, createRelease, preReleaseCommand);
    } else {
      core.warning(`Unsupported event: ${context.eventName}. Skipping.`);
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('An unexpected error occurred');
    }
  }
}

async function handlePullRequest(context: typeof github.context): Promise<void> {
  const prTitle = context.payload.pull_request?.title;

  if (!prTitle) {
    core.setFailed('Unable to retrieve PR title');
    return;
  }

  core.info(`PR Title: "${prTitle}"`);

  if (!CONVENTIONAL_COMMIT_REGEX.test(prTitle)) {
    core.setFailed(
      `PR title does not follow Conventional Commits format.\n\n` +
      `Expected format: <type>[optional scope][!]: <description>\n\n` +
      `Valid types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert\n\n` +
      `Examples:\n` +
      `  - feat: add new feature\n` +
      `  - fix(auth): resolve login issue\n` +
      `  - feat!: breaking change in API\n` +
      `  - chore(deps): update dependencies\n\n` +
      `Your title: "${prTitle}"`
    );
    return;
  }

  core.info('PR title follows Conventional Commits format');
}

async function handlePush(
  octokit: ReturnType<typeof github.getOctokit>,
  context: typeof github.context,
  tagPrefix: string,
  initialVersion: string,
  floatingTagMode: FloatingTagMode,
  createRelease: boolean,
  preReleaseCommand: string | null
): Promise<void> {
  const { owner, repo } = context.repo;
  const defaultBranch = context.payload.repository?.default_branch || 'main';
  const ref = context.ref;

  if (ref !== `refs/heads/${defaultBranch}` && ref !== `refs/heads/main` && ref !== `refs/heads/master`) {
    core.info(`Push is not to the default branch (${ref}). Skipping tag creation.`);
    core.setOutput('bump-type', 'none');
    return;
  }

  core.info('Push to main branch detected. Analyzing commits...');

  const latestTag = await getLatestTag(octokit, owner, repo, tagPrefix);
  core.info(`Latest tag: ${latestTag || 'none'}`);

  const commits = await getCommitsSinceTag(octokit, owner, repo, latestTag);
  core.info(`Found ${commits.length} commits since last tag`);

  if (commits.length === 0) {
    core.info('No new commits since last tag. Skipping.');
    core.setOutput('bump-type', 'none');
    return;
  }

  const bumpType = determineBumpType(commits);
  core.info(`Determined bump type: ${bumpType}`);

  if (bumpType === 'none') {
    core.info('No version bump required based on commit messages.');
    core.setOutput('bump-type', 'none');
    return;
  }

  const currentVersion = latestTag
    ? latestTag.replace(new RegExp(`^${tagPrefix}`), '')
    : initialVersion;

  const newVersion = semver.inc(currentVersion, bumpType);

  if (!newVersion) {
    core.setFailed(`Failed to increment version from ${currentVersion}`);
    return;
  }

  const newTag = `${tagPrefix}${newVersion}`;
  core.info(`Creating new tag: ${newTag}`);

  const shaToTag = await runPreReleaseCommandIfSet(
    preReleaseCommand,
    newVersion,
    newTag,
    context
  );
  await createTag(octokit, owner, repo, newTag, shaToTag);

  core.setOutput('new-tag', newTag);
  core.setOutput('bump-type', bumpType);
  core.info(`Successfully created tag ${newTag}`);

  if (createRelease) {
    const releaseUrl = await upsertReleaseWithGeneratedNotes(
      octokit,
      owner,
      repo,
      newTag,
      latestTag,
      defaultBranch
    );
    if (releaseUrl) {
      core.setOutput('release-url', releaseUrl);
      core.info(`Created/updated GitHub Release: ${releaseUrl}`);
    }
  }

  if (floatingTagMode !== 'off') {
    const majorVersion = semver.major(newVersion);
    if (majorVersion === 0) {
      core.info('Skipping floating tag creation for v0.x.x versions');
    } else {
      const floatingTagName = `${tagPrefix}${majorVersion}`;
      await updateFloatingTag(octokit, owner, repo, floatingTagName, context.sha);
      core.setOutput('floating-tag', floatingTagName);
      core.info(`Updated floating tag ${floatingTagName} -> ${newTag}`);

      if (floatingTagMode === 'major+minor') {
        const minorVersion = semver.minor(newVersion);
        const floatingMinorTagName = `${tagPrefix}${majorVersion}.${minorVersion}`;
        await updateFloatingTag(octokit, owner, repo, floatingMinorTagName, context.sha);
        core.setOutput('floating-minor-tag', floatingMinorTagName);
        core.info(`Updated floating minor tag ${floatingMinorTagName} -> ${newTag}`);
      }
    }
  }
}

async function upsertReleaseWithGeneratedNotes(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  tag: string,
  previousTag: string | null,
  targetCommitish: string
): Promise<string | null> {
  let releaseName: string | undefined;
  let releaseBody: string | undefined;

  try {
    const { data } = await octokit.request('POST /repos/{owner}/{repo}/releases/generate-notes', {
      owner,
      repo,
      tag_name: tag,
      previous_tag_name: previousTag || undefined,
      target_commitish: targetCommitish,
    });

    releaseName = data.name || tag;
    releaseBody = data.body || undefined;
  } catch (error) {
    core.warning(`Failed to generate release notes via API: ${error}`);
  }

  try {
    const { data: release } = await octokit.rest.repos.createRelease({
      owner,
      repo,
      tag_name: tag,
      name: releaseName || tag,
      body: releaseBody,
      draft: false,
      prerelease: false,
      generate_release_notes: releaseBody ? false : true,
    });

    return release.html_url || null;
  } catch (error) {
    core.info(`Release already exists or create failed; attempting update. (${error})`);
  }

  try {
    const { data: existing } = await octokit.rest.repos.getReleaseByTag({
      owner,
      repo,
      tag,
    });

    const { data: updated } = await octokit.rest.repos.updateRelease({
      owner,
      repo,
      release_id: existing.id,
      name: releaseName || existing.name || tag,
      body: releaseBody || existing.body || undefined,
      draft: existing.draft,
      prerelease: existing.prerelease,
    });

    return updated.html_url || existing.html_url || null;
  } catch (error) {
    core.warning(`Failed to update existing release: ${error}`);
    return null;
  }
}

async function getLatestTag(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  tagPrefix: string
): Promise<string | null> {
  try {
    const { data: tags } = await octokit.rest.repos.listTags({
      owner,
      repo,
      per_page: 100,
    });

    const semverTags = tags
      .map(tag => tag.name)
      .filter(name => name.startsWith(tagPrefix))
      .filter(name => {
        const version = name.replace(new RegExp(`^${tagPrefix}`), '');
        return semver.valid(version) !== null;
      })
      .sort((a, b) => {
        const versionA = a.replace(new RegExp(`^${tagPrefix}`), '');
        const versionB = b.replace(new RegExp(`^${tagPrefix}`), '');
        return semver.rcompare(versionA, versionB);
      });

    return semverTags.length > 0 ? semverTags[0] : null;
  } catch (error) {
    core.warning(`Failed to fetch tags: ${error}`);
    return null;
  }
}

async function getCommitsSinceTag(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  tag: string | null
): Promise<CommitInfo[]> {
  try {
    if (!tag) {
      const { data: commits } = await octokit.rest.repos.listCommits({
        owner,
        repo,
        per_page: 100,
      });

      return commits.map(commit => ({
        message: commit.commit.message,
        sha: commit.sha,
      }));
    }

    const { data: tagData } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `tags/${tag}`,
    });

    const tagSha = tagData.object.sha;

    let commitSha = tagSha;
    if (tagData.object.type === 'tag') {
      const { data: tagObject } = await octokit.rest.git.getTag({
        owner,
        repo,
        tag_sha: tagSha,
      });
      commitSha = tagObject.object.sha;
    }

    const { data: comparison } = await octokit.rest.repos.compareCommits({
      owner,
      repo,
      base: commitSha,
      head: 'HEAD',
    });

    return comparison.commits.map(commit => ({
      message: commit.commit.message,
      sha: commit.sha,
    }));
  } catch (error) {
    core.warning(`Failed to get commits since tag: ${error}`);
    return [];
  }
}

function determineBumpType(commits: CommitInfo[]): BumpType {
  let hasBreaking = false;
  let hasFeat = false;
  let hasFix = false;

  for (const commit of commits) {
    const message = commit.message;
    const firstLine = message.split('\n')[0];

    if (
      firstLine.includes('!:') ||
      message.includes('BREAKING CHANGE:') ||
      message.includes('BREAKING-CHANGE:')
    ) {
      hasBreaking = true;
    }

    if (firstLine.startsWith('feat')) {
      hasFeat = true;
    }

    if (firstLine.startsWith('fix')) {
      hasFix = true;
    }
  }

  if (hasBreaking) {
    return 'major';
  }
  if (hasFeat) {
    return 'minor';
  }
  if (hasFix) {
    return 'patch';
  }

  return 'none';
}

async function runPreReleaseCommandIfSet(
  preReleaseCommand: string | null,
  newVersion: string,
  newTag: string,
  context: typeof github.context
): Promise<string> {
  if (!preReleaseCommand) {
    return context.sha;
  }

  const cwd = process.env.GITHUB_WORKSPACE || process.cwd();
  core.info(`Running pre-release command: ${preReleaseCommand}`);

  try {
    execSync(preReleaseCommand, {
      cwd,
      stdio: 'inherit',
      env: {
        ...process.env,
        NEW_VERSION: newVersion,
        NEW_TAG: newTag,
      },
    });
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`Pre-release command failed: ${error.message}`);
    } else {
      core.setFailed('Pre-release command failed');
    }
    throw error;
  }

  const statusOutput = execSync('git status --porcelain', {
    cwd,
    encoding: 'utf-8',
  }).trim();

  if (!statusOutput) {
    core.info('Pre-release command produced no file changes; tagging current commit.');
    return context.sha;
  }

  core.info('Pre-release command produced changes; creating release commit.');
  const actor = process.env.GITHUB_ACTOR || 'github-actions[bot]';
  const email = actor === 'github-actions[bot]' ? '41898282+github-actions[bot]@users.noreply.github.com' : `${actor}@users.noreply.github.com`;

  execSync(`git config user.name "${actor}"`, { cwd });
  execSync(`git config user.email "${email}"`, { cwd });
  execSync('git add -A', { cwd });
  execSync(`git commit -m "chore: release ${newTag}"`, { cwd });
  execSync('git push', { cwd });

  const newSha = execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8' }).trim();
  core.info(`Created release commit ${newSha}`);
  return newSha;
}

async function createTag(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  tag: string,
  sha: string
): Promise<void> {
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/tags/${tag}`,
    sha,
  });
}

async function updateFloatingTag(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  tag: string,
  sha: string
): Promise<void> {
  try {
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `tags/${tag}`,
      sha,
      force: true,
    });
    core.info(`Updated existing floating tag ${tag}`);
  } catch (error) {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/tags/${tag}`,
      sha,
    });
    core.info(`Created new floating tag ${tag}`);
  }
}

run();
