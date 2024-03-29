import * as core from "@actions/core";
import dedent from "dedent";

import {
  CreatePullRequestResponse,
  PullRequest,
  MergeStrategy,
} from "./github";
import { GithubApi } from "./github";
import { Git, GitRefNotFoundError } from "./git";
import * as utils from "./utils";

type PRContent = {
  title: string;
  body: string;
};

export type Config = {
  pwd: string;
  labels: {
    pattern?: RegExp;
  };
  pull: {
    description: string;
    title: string;
  };
  target_branches?: string;
  commits: {
    merge_commits: "fail" | "skip";
  };
  upstream_repo: string;
  branch_map: Map<string, string>;
  trigger_label?: string;
};

enum Output {
  wasSuccessful = "was_successful",
  wasSuccessfulByTarget = "was_successful_by_target",
}

export class CherryPick {
  private github;
  private config;
  private git;

  constructor(github: GithubApi, config: Config, git: Git) {
    this.github = github;
    this.config = config;
    this.git = git;
  }

  async run(): Promise<void> {
    try {
      const payload = this.github.getPayload();
      const owner = this.github.getRepo().owner;
      const repo = payload.repository?.name ?? this.github.getRepo().repo;
      const pull_number = this.github.getPullNumber();
      const mainpr = await this.github.getPullRequest(pull_number);
      // The head_ref or source branch of the pull request in a workflow run. This property is only available when the event that triggers a workflow
      const headref = mainpr.head.sha;
      // The base_ref or target branch of the pull request in a workflow run. This property is only available when the event that triggers a workflow
      const baseref = mainpr.base.sha;
      const branch_map = this.config.branch_map;
      // define the upstream name for git remote
      const upstream_name = "upstream";

      if (!(await this.github.isMerged(mainpr))) {
        const message = "Only merged pull requests can be cherry-picked.";
        this.github.createComment({
          owner,
          repo,
          issue_number: pull_number,
          body: message,
        });
        return;
      }

      // check if the pull request has the trigger label
      if (
        mainpr.labels &&
        Array.isArray(mainpr.labels) &&
        this.config.trigger_label
      ) {
        if (
          !mainpr.labels.some(
            (label) => label.name === this.config.trigger_label,
          )
        ) {
          // Abort in case there is no matching label
          console.log(`Pull request #${pull_number} has no matching label`);
          return;
        }
      }
      console.log("Pull request has a matching label");

      const target = branch_map.get(mainpr.base.ref) ?? mainpr.base.ref;
      console.log(`Target branch for cherry-pick: ${target}`);

      console.log(
        `Fetching all the commits from the pull request: ${mainpr.commits + 1}`,
      );
      await this.git.fetch(
        `refs/pull/${pull_number}/head`,
        this.config.pwd,
        mainpr.commits + 1, // +1 in case this concerns a shallowly cloned repo
      );

      const commitShas = await this.github.getCommits(mainpr);

      let commitShasToCherryPick;

      const merge_commit_sha = await this.github.getMergeCommitSha(mainpr);

      // switch case to check if it is a squash, rebase, or merge commit
      switch (await this.github.mergeStrategy(mainpr, merge_commit_sha)) {
        case MergeStrategy.SQUASHED:
          // If merged via a squash merge_commit_sha represents the SHA of the squashed commit on
          // the base branch. We must fetch it and its parent in case of a shallowly cloned repo
          // To store the fetched commits indefinitely we save them to a remote ref using the sha
          await this.git.fetch(
            `+${merge_commit_sha}:refs/remotes/origin/${merge_commit_sha}`,
            this.config.pwd,
            2, // +1 in case this concerns a shallowly cloned repo
          );
          commitShasToCherryPick = [merge_commit_sha!];
          break;
        case MergeStrategy.REBASED:
          // If rebased merge_commit_sha represents the commit that the base branch was updated to
          // We must fetch it, its parents, and one extra parent in case of a shallowly cloned repo
          // To store the fetched commits indefinitely we save them to a remote ref using the sha
          await this.git.fetch(
            `+${merge_commit_sha}:refs/remotes/origin/${merge_commit_sha}`,
            this.config.pwd,
            mainpr.commits + 1, // +1 in case this concerns a shallowly cloned repo
          );
          const range = `${merge_commit_sha}~${mainpr.commits}..${merge_commit_sha}`;
          commitShasToCherryPick = await this.git.findCommitsInRange(
            range,
            this.config.pwd,
          );
          break;
        case MergeStrategy.MERGECOMMIT:
          commitShasToCherryPick = commitShas;
          break;
        case MergeStrategy.UNKNOWN:
          console.log(
            "Could not detect merge strategy. Using commits from the Pull Request.",
          );
          commitShasToCherryPick = commitShas;
          break;
        default:
          console.log(
            "Could not detect merge strategy. Using commits from the Pull Request.",
          );
          commitShasToCherryPick = commitShas;
          break;
      }
      console.log(`Found commits to backport: ${commitShasToCherryPick}`);

      console.log("Checking the merged pull request for merge commits");
      const mergeCommitShas = await this.git.findMergeCommits(
        commitShas,
        this.config.pwd,
      );
      console.log(
        `Encountered ${mergeCommitShas.length ?? "no"} merge commits`,
      );
      if (
        mergeCommitShas.length > 0 &&
        this.config.commits.merge_commits == "fail"
      ) {
        const message = dedent`Cherry-pick failed because this pull request contains merge commits. \
          You can either cherry-pick this pull request manually, or configure the action to skip merge commits.`;
        console.error(message);
        this.github.createComment({
          owner,
          repo,
          issue_number: pull_number,
          body: message,
        });
        return;
      }

      if (
        mergeCommitShas.length > 0 &&
        this.config.commits.merge_commits == "skip"
      ) {
        console.log("Skipping merge commits: " + mergeCommitShas);
        const nonMergeCommitShas = commitShas.filter(
          (sha) => !mergeCommitShas.includes(sha),
        );
        commitShasToCherryPick = nonMergeCommitShas;
      }
      console.log(
        "Will cherry-pick the following commits: " + commitShasToCherryPick,
      );

      const successByTarget = new Map<string, boolean>();

      // remote logic starts here
      console.log(
        `Cherry-picking to target branch '${target} to remote '${upstream_name}'`,
      );
      try {
        await this.git.add_remote(
          this.config.upstream_repo,
          upstream_name,
          this.config.pwd,
        );
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
          successByTarget.set(target, false);
          // TODO: This should not create a comment from the error itself.
          // as it potentially leaks information about the remote repo
          // (unless this is non-generic error)
          await this.github.createComment({
            owner,
            repo,
            issue_number: pull_number,
            body: error.message,
          });
        } else {
          core.setFailed(
            "An unexpected error occured. Please check the logs for details",
          );
          throw error;
        }
      }

      try {
        await this.git.fetch(target, this.config.pwd, 3, upstream_name);
        await this.git.fetch(target, this.config.pwd, 3, "origin");
      } catch (error) {
        if (error instanceof GitRefNotFoundError) {
          const message = this.composeMessageForFetchTargetFailure(error.ref);
          console.error(message);
          successByTarget.set(target, false);
          await this.github.createComment({
            owner,
            repo,
            issue_number: pull_number,
            body: message,
          });
        } else {
          core.setFailed(
            "An unexpected error occured. Please check the logs for details",
          );
          throw error;
        }
      }

      try {
        const branchname = `cherry-pick-${pull_number}-to-${target}-to-${upstream_name}`;

        console.log(`Start cherry-pick to ${branchname}`);
        try {
          await this.git.checkout(
            branchname,
            target,
            upstream_name,
            this.config.pwd,
          );
        } catch (error) {
          const message = this.composeMessageForCherryPickScriptFailure(
            target,
            3,
            baseref,
            headref,
            branchname,
            upstream_name,
            this.config.upstream_repo,
          );
          console.error(message);
          successByTarget.set(target, false);
          await this.github.createComment({
            owner,
            repo,
            issue_number: pull_number,
            body: message,
          });
          this.createOutput(successByTarget);
          return;
        }

        try {
          await this.git.cherryPick(commitShasToCherryPick, this.config.pwd);
        } catch (error) {
          const message = this.composeMessageForCherryPickScriptFailure(
            target,
            4,
            baseref,
            headref,
            branchname,
            upstream_name,
            this.config.upstream_repo,
          );
          console.error(message);
          successByTarget.set(target, false);
          await this.github.createComment({
            owner,
            repo,
            issue_number: pull_number,
            body: message,
          });
          this.createOutput(successByTarget);
          return;
        }

        console.info(`Push branch ${branchname} to remote ${upstream_name}`);
        const pushExitCode = await this.git.push(
          branchname,
          upstream_name,
          this.config.pwd,
        );
        if (pushExitCode != 0) {
          const message = this.composeMessageForGitPushFailure(
            branchname,
            pushExitCode,
            upstream_name,
          );
          console.error(message);
          successByTarget.set(target, false);
          await this.github.createComment({
            owner,
            repo,
            issue_number: pull_number,
            body: message,
          });
          this.createOutput(successByTarget);
          return;
        }

        const [upstream_owner, upstream_repo] =
          this.extractOwnerRepoFromUpstreamRepo(this.config.upstream_repo);

        console.info(`Create PR for ${branchname}`);
        const { title, body } = this.composePRContent(
          target,
          mainpr,
          owner,
          repo,
        );

        const new_pr_response = await this.github.createPR({
          owner: upstream_owner,
          repo: upstream_repo,
          title,
          body,
          head: branchname,
          base: target,
          maintainer_can_modify: true,
        });

        if (new_pr_response.status != 201) {
          console.error(JSON.stringify(new_pr_response));
          successByTarget.set(target, false);
          const message = this.composeMessageForCreatePRFailed(new_pr_response);
          await this.github.createComment({
            owner,
            repo,
            issue_number: pull_number,
            body: message,
          });
          this.createOutput(successByTarget);
          return;
        }
        const new_pr = new_pr_response.data;

        // get the merger of the main pr
        const merger = mainpr.merged_by ? mainpr.merged_by.login : null;

        // also copy the assigned reviewers over
        const requested_reviewers = mainpr.requested_reviewers?.map(
          (reviewer) => reviewer.login,
        );
        // merge reviewer and requested_reviewers
        const reviewers = [merger, ...(requested_reviewers || [])].filter(
          (reviewer): reviewer is string => typeof reviewer === "string",
        );

        if (reviewers) {
          console.info("Setting reviewers for the new PR");
          const reviewRequest = {
            owner: upstream_owner,
            repo: upstream_repo,
            pull_number: new_pr.number,
            reviewers: reviewers || [],
          };
          const set_reviewers_response =
            await this.github.requestReviewers(reviewRequest);
          if (set_reviewers_response.status != 201) {
            console.error(JSON.stringify(set_reviewers_response));
          }
        }

        const message = this.composeMessageForSuccess(
          new_pr.number,
          target,
          this.config.upstream_repo,
        );
        successByTarget.set(target, true);
        await this.github.createComment({
          owner,
          repo,
          issue_number: pull_number,
          body: message,
        });
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
          successByTarget.set(target, false);
          await this.github.createComment({
            owner,
            repo,
            issue_number: pull_number,
            body: error.message,
          });
          this.createOutput(successByTarget);
          return;
        } else {
          core.setFailed(
            "An unexpected error occured. Please check the logs for details",
          );
          throw error;
        }
      }

      this.createOutput(successByTarget);
    } catch (error) {
      if (error instanceof Error) {
        console.error(error.message);
        core.setFailed(error.message);
      } else {
        console.error(`An unexpected error occurred: ${JSON.stringify(error)}`);
        core.setFailed(
          "An unexpected error occured. Please check the logs for details",
        );
      }
    }
  }

  private extractOwnerRepoFromUpstreamRepo(
    upstream_repo: string,
  ): [string, string] {
    // split the `upstream_repo` into `owner` and `repo`
    const [owner, repo] = upstream_repo.split("/");
    console.debug(`owner: ${owner}, repo: ${repo}`);
    return [owner, repo];
  }

  private composePRContent(
    target: string,
    main: PullRequest,
    owner: string,
    repo: string,
  ): PRContent {
    const title = utils.replacePlaceholders(
      this.config.pull.title,
      main,
      target,
      owner,
      repo,
    );
    const body = utils.replacePlaceholders(
      this.config.pull.description,
      main,
      target,
      owner,
      repo,
    );
    return { title, body };
  }

  private composeMessageForFetchTargetFailure(target: string) {
    return dedent`Cherry-pick failed for \`${target}\`: couldn't find remote ref \`${target}\`.
                  Please ensure that this Github repo has a branch named \`${target}\`.`;
  }

  private composeMessageForCherryPickScriptFailure(
    target: string,
    exitcode: number,
    baseref: string,
    headref: string,
    branchname: string,
    remote: string = "origin",
    upstream_repo: string,
  ): string {
    const reasons: { [key: number]: string } = {
      1: "due to an unknown script error",
      2: "because it was unable to create/access the git worktree directory",
      3: "because it was unable to create a new branch",
      4: "because it was unable to cherry-pick the commit(s)",
      5: "because 1 or more of the commits are not available",
      6: "because 1 or more of the commits are not available",
    };
    const reason = reasons[exitcode] ?? "due to an unknown script error";

    const suggestion =
      exitcode <= 4
        ? dedent`\`\`\`bash
                git remote add ${remote} https://github.com/${upstream_repo}
                git fetch ${remote} ${target}
                git worktree add -d .worktree/${branchname} ${remote}/${target}
                cd .worktree/${branchname}
                git checkout -b ${branchname}
                ancref=$(git merge-base ${baseref} ${headref})
                git cherry-pick -x $ancref..${headref}
                \`\`\``
        : dedent`Note that rebase and squash merges are not supported at this time.`;

    return dedent`Cherry-pick failed for \`${target}\`, ${reason}.

                  Please cherry-pick the changes locally.
                  ${suggestion}`;
  }

  private composeMessageForGitPushFailure(
    target: string,
    exitcode: number,
    remote: string = "origin",
  ): string {
    //TODO better error messages depending on exit code
    return dedent`git push to ${remote} failed for ${target} with exitcode ${exitcode}`;
  }

  private composeMessageForCreatePRFailed(
    response: CreatePullRequestResponse,
  ): string {
    return dedent`Cherry-pick branch created but failed to create PR.
                Request to create PR rejected with status ${response.status}.

                (see action log for full response)`;
  }

  private composeMessageForSuccess(
    pr_number: number,
    target: string,
    upstream_repo: string,
  ) {
    return dedent`Successfully created cherry-pick PR for \`${target}\`:
                  - https://github.com/${upstream_repo}/pull/${pr_number}`;
  }

  private createOutput(successByTarget: Map<string, boolean>) {
    const anyTargetFailed = Array.from(successByTarget.values()).includes(
      false,
    );
    core.setOutput(Output.wasSuccessful, !anyTargetFailed);

    const byTargetOutput = Array.from(successByTarget.entries()).reduce<string>(
      (i, [target, result]) => `${i}${target}=${result}\n`,
      "",
    );
    core.setOutput(Output.wasSuccessfulByTarget, byTargetOutput);
  }
}
