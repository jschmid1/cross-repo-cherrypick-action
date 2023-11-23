/**
 * Github module
 *
 * Used to isolate the boundary between the code of this project and the github
 * api. Handy during testing, because we can easily mock this module's functions.
 * Properties are harder to mock, so this module just offers functions to retrieve
 * those properties.
 */

import * as github from "@actions/github";

export interface GithubApi {
  getRepo(): { owner: string; repo: string };
  getPayload(): Payload;
  getPullNumber(): number;
  createComment(comment: Comment): Promise<{}>;
  getPullRequest(pull_number: number): Promise<PullRequest>;
  isMerged(pull: PullRequest): Promise<boolean>;
  getCommits(pull: PullRequest): Promise<string[]>;
  createPR(pr: CreatePullRequest): Promise<CreatePullRequestResponse>;
  requestReviewers(request: ReviewRequest): Promise<RequestReviewersResponse>;
  isSquashed(pull: PullRequest): Promise<boolean>;
  getMergeCommitSha(pull: PullRequest): Promise<string | null>;
}

export class Github implements GithubApi {
  #octokit;
  #context;

  constructor(token: string) {
    this.#octokit = github.getOctokit(token);
    this.#context = github.context;
  }

  public getRepo() {
    return this.#context.repo;
  }

  public getPayload() {
    return this.#context.payload;
  }

  public getPullNumber() {
    if (this.#context.payload.pull_request) {
      return this.#context.payload.pull_request.number;
    }

    // if the pr is not part of the payload
    // the number can be taken from the issue
    return this.#context.issue.number;
  }

  public async createComment(comment: Comment) {
    console.log(`Create comment: ${comment.body}`);
    return this.#octokit.rest.issues.createComment(comment);
  }

  public async getPullRequest(pull_number: number) {
    console.log(`Retrieve pull request data for #${pull_number}`);
    return this.#octokit.rest.pulls
      .get({
        ...this.getRepo(),
        pull_number,
      })
      .then((response) => response.data as PullRequest);
  }

  public async isMerged(pull: PullRequest) {
    console.log(`Check whether pull request ${pull.number} is merged`);
    return this.#octokit.rest.pulls
      .checkIfMerged({ ...this.getRepo(), pull_number: pull.number })
      .then(() => true /* status is always 204 */)
      .catch((error) => {
        if (error?.status == 404) return false;
        else throw error;
      });
  }

  public async getFirstAndLastCommitSha(
    pull: PullRequest,
  ): Promise<{ firstCommitSha: string; lastCommitSha: string | null }> {
    const commits = await this.getCommits(pull);
    return {
      firstCommitSha: commits[0],
      lastCommitSha: commits.length > 1 ? commits[commits.length - 1] : null,
    };
  }

  public async getCommits(pull: PullRequest) {
    console.log(`Retrieving the commits from pull request ${pull.number}`);

    const commits: string[] = [];

    const getCommitsPaged = (page: number) =>
      this.#octokit.rest.pulls
        .listCommits({
          ...this.getRepo(),
          pull_number: pull.number,
          per_page: 100,
          page: page,
        })
        .then((commits) => commits.data.map((commit) => commit.sha));

    for (let page = 1; page <= Math.ceil(pull.commits / 100); page++) {
      const commitsOnPage = await getCommitsPaged(page);
      commits.push(...commitsOnPage);
    }

    return commits;
  }

  public async getMergeCommitSha(pull: PullRequest) {
    return pull.merge_commit_sha;
  }

  public async getCommit(sha: string) {
    const commit = this.#octokit.rest.repos.getCommit({
      ...this.getRepo(),
      ref: sha,
    });
    return commit;
  }

  /**
   * Retrieves the parent commit SHA of a given commit.
   * If the commit is a merge commit, it returns the SHA of the first parent commit.
   * @param sha - The SHA of the commit.
   * @returns The SHA of the parent commit.
   */
  public async getParent(sha: string) {
    const commit = await this.getCommit(sha);
    // a commit has a parent. If it has more than one parent it is an indication
    // that it is a merge commit. The first parent is the commit that was merged
    // we can safely ignore the second parent as we're checking if the commit isn't a
    // merge commit before.
    return commit.data.parents[0].sha;
  }

  /**
   * Retrieves the pull requests associated with a specific commit.
   * @param sha The SHA of the commit.
   * @returns A promise that resolves to the pull requests associated with the commit.
   */
  public async getPullRequestsAssociatedWithCommit(sha: string) {
    const pr = this.#octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      ...this.getRepo(),
      commit_sha: sha,
    });
    return pr;
  }

  /**
   * Checks if a given SHA is associated with a specific pull request.
   * @param sha - The SHA of the commit.
   * @param pull - The pull request to check against.
   * @returns A boolean indicating whether the SHA is associated with the pull request.
   */
  public async isShaAssociatedWithPullRequest(sha: string, pull: PullRequest) {
    const assoc_pr = await this.getPullRequestsAssociatedWithCommit(sha);
    const assoc_pr_data = assoc_pr.data;
    // commits can be associated with multiple PRs
    // checks if any of the assoc_prs is the same as the pull
    return assoc_pr_data.some((pr) => pr.number == pull.number);
  }

  /**
   * Checks if a pull request is "squashed and merged"
   * or "rebased and merged"
   * @param pull - The pull request to check.
   * @returns A promise that resolves to a boolean indicating whether the pull request is squashed and merged.
   */
  public async isSquashed(pull: PullRequest): Promise<boolean> {
    const merge_commit_sha = await this.getMergeCommitSha(pull);
    if (!merge_commit_sha) {
      console.log("likely not merged yet.");
      return false;
    }
    // To detect if this was a rebase and merge, we can verify
    // that the parent of the merge commit is associated with the pull request
    // if it is, we have a "rebase and merge".
    // if it is not, we have a "squash and merge".
    const parent_commit = await this.getParent(merge_commit_sha);
    const is_associated =
      (await this.isShaAssociatedWithPullRequest(parent_commit, pull)) &&
      (await this.isShaAssociatedWithPullRequest(merge_commit_sha, pull));
    if (is_associated) {
      return false;
    }
    return true;
  }

  public async createPR(pr: CreatePullRequest) {
    console.log(`Create PR: ${pr.body}`);
    return this.#octokit.rest.pulls.create(pr);
  }

  public async requestReviewers(request: ReviewRequest) {
    console.log(`Request reviewers: ${request.reviewers}`);
    return this.#octokit.rest.pulls.requestReviewers(request);
  }
}

export type PullRequest = {
  number: number;
  title: string;
  body: string | null;
  merge_commit_sha: string | null;
  head: {
    sha: string;
    ref: string;
  };
  base: {
    sha: string;
    ref: string;
  };
  user: {
    login: string;
  };
  labels: {
    name: string;
  }[];
  requested_reviewers: {
    login: string;
  }[];
  commits: number;
  milestone: {
    number: number;
    id: number;
    title: string;
  };
  assignees: {
    login: string;
    id: number;
  }[];
  merged_by: {
    login: string;
  };
};
export type CreatePullRequestResponse = {
  status: number;
  data: {
    number: number;
    requested_reviewers?: ({ login: string } | null)[] | null;
  };
};
export type RequestReviewersResponse = CreatePullRequestResponse;

export type GenericResponse = {
  status: number;
};

export type LabelPullRequestResponse = {
  status: number;
};

export type Comment = {
  owner: string;
  repo: string;
  issue_number: number;
  body: string;
};

export type CreatePullRequest = {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  maintainer_can_modify: boolean;
};

export type ReviewRequest = {
  owner: string;
  repo: string;
  pull_number: number;
  reviewers: string[];
};

type Payload = {
  repository?: {
    name: string;
  };
};
