# tag-it

The zero-config GitHub Action for automated semver. Enforces Conventional Commits on PRs and auto-calculates/deploys the next version tag (v1.2.3) on merge to main based on fix, feat, and ! (breaking) prefixes. Automate your release cycle in seconds.

## Features

- **PR Title Validation**: Ensures PR titles follow [Conventional Commits](https://www.conventionalcommits.org/) format
- **Automatic Semantic Versioning**: Analyzes commits on push to main and creates appropriate version tags
- **Floating Tags**: Automatically maintains floating tags (major by default, optionally minor too)
- **GitHub Releases (Optional)**: Can automatically create/update a GitHub Release with generated release notes
- **Pre-release command (Optional)**: Run a custom command before tagging (e.g. bump version in `Cargo.toml`); if it changes files, a release commit is created and the tag points to it
- **Zero Configuration**: Works out of the box with sensible defaults

## Usage

Create a workflow file at `.github/workflows/tag-it.yml`:

```yaml
name: Tag It

on:
  pull_request:
    types: [opened, edited, synchronize, reopened]
  push:
    branches:
      - main

permissions:
  contents: write

jobs:
  tag-it:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: wozniakpl/tag-it@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `github-token` | GitHub token for API access | Yes | `${{ github.token }}` |
| `tag-prefix` | Prefix for version tags | No | `v` |
| `initial-version` | Initial version if no tags exist | No | `0.0.0` |
| `floating-tag` | Floating tags mode: `true` (major only), `minor` (major + minor), `false` (off) | No | `true` |
| `create-release` | Create/update a GitHub Release with generated release notes | No | `false` |
| `pre-release-command` | Shell command to run before creating the tag (e.g. bump version in a file). If it produces file changes, they are committed and pushed, then the tag is created on that commit. Env: `NEW_VERSION`, `NEW_TAG`. | No | *(not set)* |

## Outputs

| Output | Description |
|--------|-------------|
| `new-tag` | The new tag that was created (only on push events) |
| `bump-type` | The type of version bump (major, minor, patch, or none) |
| `floating-tag` | The floating major version tag that was updated (e.g., `v5`) |
| `floating-minor-tag` | The floating minor version tag that was updated (e.g., `v5.2`) |
| `release-url` | The GitHub Release URL that was created/updated (only when `create-release` is enabled) |

## How It Works

### On Pull Request

The action validates that the PR title follows the Conventional Commits format:

```
<type>[optional scope][!]: <description>
```

Valid types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

Examples:
- `feat: add user authentication`
- `fix(api): resolve timeout issue`
- `feat!: redesign API endpoints`
- `chore(deps): update dependencies`

### On Push to Main

The action:
1. Fetches the latest semantic version tag
2. Analyzes all commits since that tag
3. Determines the version bump based on commit messages:
   - **MAJOR**: Commits with `!` (e.g., `feat!:`) or `BREAKING CHANGE` in the body
   - **MINOR**: Commits starting with `feat`
   - **PATCH**: Commits starting with `fix`
4. Creates and pushes the new tag to the repository
5. Updates the floating major version tag (if enabled)

### Floating Tags

Floating tags allow users to reference a major (and optionally minor) version without specifying the exact patch version. This is the recommended pattern for GitHub Actions.

For example, when `v5.2.0` is released:
- A new tag `v5.2.0` is created
- The floating tag `v5` is updated to point to `v5.2.0`

This allows consumers to use `@v5` in their workflows to always get the latest `v5.x.x` release:

```yaml
- uses: wozniakpl/tag-it@v5  # Always uses latest v5.x.x
```

To also maintain a floating **minor** tag (e.g., `v5.2`), set:

```yaml
- uses: wozniakpl/tag-it@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    floating-tag: minor
```

Floating tags are **enabled by default** (major only). To disable them:

```yaml
- uses: wozniakpl/tag-it@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    floating-tag: 'false'
```

### Pre-release command

To bump a version in your repo before the tag is created (e.g. in `Cargo.toml`, `pyproject.toml`, or `package.json`), set `pre-release-command`. The action runs it with `NEW_VERSION` and `NEW_TAG` in the environment. If the command changes any files, it commits and pushes them, then creates the tag on that new commit.

Example: update version in a Rust project’s `Cargo.toml` with a small script:

```yaml
- uses: wozniakpl/tag-it@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    pre-release-command: |
      sed -i "s/^version = .*/version = \"$NEW_VERSION\"/" Cargo.toml
```

Example: use a Node script that writes the new version into `package.json`:

```yaml
- uses: wozniakpl/tag-it@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    pre-release-command: 'node -e "const p=require(\"./package.json\"); p.version=process.env.NEW_VERSION; require(\"fs\").writeFileSync(\"package.json\", JSON.stringify(p,null,2));"'
```

If `pre-release-command` is not set (default), no command runs and the tag is created on the current commit.

## Example Workflow with Outputs

```yaml
name: Release

on:
  push:
    branches:
      - main

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      
      - name: Tag It
        id: tag-it
        uses: wozniakpl/tag-it@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          create-release: 'true'
      
      - name: Create Release
        if: steps.tag-it.outputs.new-tag != ''
        run: |
          echo "New tag created: ${{ steps.tag-it.outputs.new-tag }}"
          echo "Bump type: ${{ steps.tag-it.outputs.bump-type }}"
          echo "Release URL: ${{ steps.tag-it.outputs.release-url }}"
```

## License

MIT
