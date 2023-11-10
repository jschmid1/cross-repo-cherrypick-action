# Cross Repo Cherrypicks

This project provides a GitHub Action designed to streamline the backporting of merged pull requests to another repository. This could be a direct fork or any other related repository.

## Features

- Flexible - Supports all [merge methods](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/about-merge-methods-on-github) including [merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) and [Bors](https://bors.tech/)
- Configurable - Use inputs and outputs to fit it to your project
- Transparent - Informs about its success / Cherry-picks with [`-x`](https://git-scm.com/docs/git-cherry-pick#Documentation/git-cherry-pick.txt--x)

## How it Works

The `upstream_repo` option allows you to specify the repository where the action will backport the Pull Request.

When a Pull Request (where this action is configured) is merged, the action searches for a label defined by the `trigger_label` option. If this label is present, the action performs the following steps:

1. Adds the remote and authenticates using GitHub tokens.
2. Fetches and checks out a new branch from the target branch.
3. Cherry-picks the commits from the merged Pull Request.
4. Creates a new Pull Request to merge the new branch into the target branch on the `upstream_repo`.
5. Posts a comment on the original Pull Request indicating the success of the operation.

If your branch naming convention differs from the standard (for example, if the default branch in your repository is `master` and in the `upstream_repo` it's `main`), you can use the `branch_map` option to handle this discrepancy.

## Usage

Add the following workflow configuration to your repository's `.github/workflows` folder.

```yaml
name: Cherry-pick merged pull request to another remote
on:
  pull_request_target:
    types: [closed]
permissions:
  contents: write # so it can comment
  pull-requests: write # so it can create pull requests
jobs:
  backport:
    name: Backport pull request to another remote
    runs-on: ubuntu-latest
    # Don't run on closed unmerged pull requests
    if: github.event.pull_request.merged
    steps:
      - uses: actions/checkout@v4
      - name: Create backport pull requests
        uses: jschmid/cherry-pick-across-remote-action@master
```

> **Note**
> This workflow runs on [`pull_request_target`](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#pull_request_target) so that `GITHUB_TOKEN` has write access to the repo when the merged pull request comes from a forked repository.
> This write access is necessary for the action to push the commits it cherry-picked.


</p>
</details>

## Inputs

The action can be configured with the following optional [inputs](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idstepswith):

### `token`

Default: `${{ github.token }}`

Token to authenticate requests to GitHub.
Used to create and label pull requests and to comment.

Either `GITHUB_TOKEN` or a repo-scoped [Personal Access Token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token) (PAT).

### `github_workspace`

Default: `${{ github.workspace }}`

Working directory for the backport action.

### `merge_commits`

Default: `fail`

Specifies how the action should deal with merge commits on the merged pull request.

- When set to `fail` the backport fails when the action detects one or more merge commits.
- When set to `skip` the action only cherry-picks non-merge commits, i.e. it ignores merge commits.
  This can be useful when you [keep your pull requests in sync with the base branch using merge commits](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/keeping-your-pull-request-in-sync-with-the-base-branch).

### `pull_description`

Default:
```
# Description
Backport of #${pull_number} to `${target_branch}`.
```

Template used as description (i.e. body) in the pull requests created by this action.

Placeholders can be used to define variable values.
These are indicated by a dollar sign and curly braces (`${placeholder}`).
Please refer to this action's README for all available [placeholders](#placeholders).

### `pull_title`

Default: `[Backport ${target_branch}] ${pull_title}`

Template used as the title in the pull requests created by this action.

Placeholders can be used to define variable values.
These are indicated by a dollar sign and curly braces (`${placeholder}`).
Please refer to this action's README for all available [placeholders](#placeholders).

### `branch_map`

Default: `""`

Allows you to specify a json-formatted map that defines relationships between branches.
For example, in your origin repository you may have a default branch called `master` while
the upstream repsitory calls it `main`. This also allows you to bridge small differences in naming
convention.
If you do not define this option, the action assums that the target branch is identical in the upstream repository.

Example:

`branch_map: '{"master": "main"}'`


### `trigger_label`

Default: `""`

Allows you to specify a label that triggers this action.


## Placeholders
In the `pull_description` and `pull_title` inputs, placeholders can be used to define variable values.
These are indicated by a dollar sign and curly braces (`${placeholder}`).
The following placeholders are available and are replaced with:

Placeholder | Replaced with
------------|------------
`pull_author` | The username of the original pull request's author, e.g. `jschmid1`
`pull_number` | The number of the original pull request that is backported, e.g. `123`
`pull_title` | The title of the original pull request that is backported, e.g. `fix: some error`

## Outputs

The action provides the following [outputs](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idoutputs):

Output | Description
-------|------------
`was_successful` | Whether or not the changes could be backported successfully to all targets. Either `true` or `false`.
`was_successful_by_target` | Whether or not the changes could be backported successfully to all targets - broken down by target. Follows the pattern `{{label}}=true\|false`.
