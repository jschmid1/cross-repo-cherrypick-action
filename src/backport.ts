import * as core from "@actions/core";
import dedent from "dedent";

import { CreatePullRequestResponse, PullRequest } from "./github";
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
};

enum Output {
  wasSuccessful = "was_successful",
  wasSuccessfulByTarget = "was_successful_by_target",
}

export class Backport {
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
        const message = "Only merged pull requests can be backported.";
        this.github.createComment({
          owner,
          repo,
          issue_number: pull_number,
          body: message,
        });
        return;
      }

      //  Determines the target value based on the `baseref` key from the `branch_map` Map object.
      //  If `baseref` exists as a key in `branch_map`, the corresponding value is used.
      //  If `baseref` does not exist in `branch_map`, `baseref` itself is used as the target value.
      //  The result is stored in the `target` constant.
      console.log(branch_map);
      const target = branch_map.get(mainpr.base.ref) ?? mainpr.base.ref;

      console.log(
        `Fetching all the commits from the pull request: ${mainpr.commits + 1}`,
      );
      await this.git.fetch(
        `refs/pull/${pull_number}/head`,
        this.config.pwd,
        mainpr.commits + 1, // +1 in case this concerns a shallowly cloned repo
      );

      const commitShas = await this.github.getCommits(mainpr);
      console.log(`Found commits: ${commitShas}`);

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
        const message = dedent`Backport failed because this pull request contains merge commits. \
          You can either backport this pull request manually, or configure the action to skip merge commits.`;
        console.error(message);
        this.github.createComment({
          owner,
          repo,
          issue_number: pull_number,
          body: message,
        });
        return;
      }

      let commitShasToCherryPick = commitShas;
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
        `Backporting to target branch '${target} to remote '${upstream_name}'`,
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
          throw error;
        }
      }

      try {
        await this.git.fetch(target, this.config.pwd, 1, upstream_name);
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
          throw error;
        }
      }

      try {
        const branchname = `backport-${pull_number}-to-${target}-to-${upstream_name}`;

        console.log(`Start backport to ${branchname}`);
        try {
          await this.git.checkout(
            branchname,
            target,
            upstream_name,
            this.config.pwd,
          );
        } catch (error) {
          const message = this.composeMessageForBackportScriptFailure(
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
        }

        try {
          await this.git.cherryPick(commitShasToCherryPick, this.config.pwd);
        } catch (error) {
          const message = this.composeMessageForBackportScriptFailure(
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
        }
        const new_pr = new_pr_response.data;

        const reviewer = mainpr.merged_by.login;
        if (reviewer) {
          console.info("Setting reviewer " + reviewer);
          const reviewRequest = {
            owner: upstream_owner,
            repo: upstream_repo,
            pull_number: new_pr.number,
            reviewers: [reviewer],
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
        } else {
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
    return dedent`Backport failed for \`${target}\`: couldn't find remote ref \`${target}\`.
                  Please ensure that this Github repo has a branch named \`${target}\`.`;
  }

  private composeMessageForBackportScriptFailure(
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

    return dedent`Backport failed for \`${target}\`, ${reason}.

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
    return dedent`Backport branch created but failed to create PR.
                Request to create PR rejected with status ${response.status}.

                (see action log for full response)`;
  }

  private composeMessageForSuccess(
    pr_number: number,
    target: string,
    upstream_repo: string,
  ) {
    return dedent`Successfully created backport PR for \`${target}\`:
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
