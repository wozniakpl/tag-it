import * as core from '@actions/core';
import * as github from '@actions/github';
import * as semver from 'semver';

const CONVENTIONAL_COMMIT_REGEX = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?!?:\s.+$/;

type BumpType = 'major' | 'minor' | 'patch' | 'none';

interface CommitInfo {
  message: string;
  sha: string;
}

async function run(): Promise<void> {
  try {
    const token = core.getInput('github-token', { required: true });
    const tagPrefix = core.getInput('tag-prefix') || 'v';
    const initialVersion = core.getInput('initial-version') || '0.0.0';
    const floatingTag = core.getInput('floating-tag') !== 'false';

    const octokit = github.getOctokit(token);
    const context = github.context;

    core.info(`Event: ${context.eventName}`);
    core.info(`Repository: ${context.repo.owner}/${context.repo.repo}`);

    if (context.eventName === 'pull_request') {
      await handlePullRequest(context);
    } else if (context.eventName === 'push') {
      await handlePush(octokit, context, tagPrefix, initialVersion, floatingTag);
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
  floatingTag: boolean
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

  await createTag(octokit, owner, repo, newTag, context.sha);

  core.setOutput('new-tag', newTag);
  core.setOutput('bump-type', bumpType);
  core.info(`Successfully created tag ${newTag}`);

  if (floatingTag) {
    const majorVersion = semver.major(newVersion);
    if (majorVersion === 0) {
      core.info('Skipping floating tag creation for v0.x.x versions');
    } else {
      const floatingTagName = `${tagPrefix}${majorVersion}`;
      await updateFloatingTag(octokit, owner, repo, floatingTagName, context.sha);
      core.setOutput('floating-tag', floatingTagName);
      core.info(`Updated floating tag ${floatingTagName} -> ${newTag}`);
    }
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
