# tag-it

The zero-config GitHub Action for automated semver. Enforces Conventional Commits on PRs and auto-calculates/deploys the next version tag (v1.2.3) on merge to main based on fix, feat, and ! (breaking) prefixes. Automate your release cycle in seconds.

## Features

- **PR Title Validation**: Ensures PR titles follow [Conventional Commits](https://www.conventionalcommits.org/) format
- **Automatic Semantic Versioning**: Analyzes commits on push to main and creates appropriate version tags
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

## Outputs

| Output | Description |
|--------|-------------|
| `new-tag` | The new tag that was created (only on push events) |
| `bump-type` | The type of version bump (major, minor, patch, or none) |

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
      
      - name: Create Release
        if: steps.tag-it.outputs.new-tag != ''
        run: |
          echo "New tag created: ${{ steps.tag-it.outputs.new-tag }}"
          echo "Bump type: ${{ steps.tag-it.outputs.bump-type }}"
```

## License

MIT
