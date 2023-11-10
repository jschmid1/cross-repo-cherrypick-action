# Cross Fork Cherry Picks

This project is a GitHub action that automates the process of backporting merged pullrequests to another repository. This can be a direct fork
or just a related repository.

## Features

- Flexible - Supports all [merge methods](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/about-merge-methods-on-github) including [merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) and [Bors](https://bors.tech/)
- Configurable - Use inputs and outputs to fit it to your project
- Transparent - Informs about its success / Cherry-picks with [`-x`](https://git-scm.com/docs/git-cherry-pick#Documentation/git-cherry-pick.txt--x)

## How it works

You can specify the `upstream_repo` option to define where the action will backport the PullRequest to.

Once a pullrequest ( where this action is configured) is merged, we look for a label that can be defined by
`trigger_label`.
If such a label is found, the action takes the following steps:

1. add the remote and give access via github tokens
2. fetch and checkout a new branch from the target branch
3. cherry-pick the merged pull request's commits
4. create a pull request to merge the new branch into the target branch on the configured `upstream_repo`
5. comment on the original pull request about its success

If the branch naming convention deviates, for example if the default branch in your repository is `master` and on the `upstream_repo` it is `main` you can use
the `branch_map` option to account for that.

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
