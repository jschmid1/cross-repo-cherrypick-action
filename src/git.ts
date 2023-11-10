export type Execa = (typeof import("execa"))["execa"];

export class GitRefNotFoundError extends Error {
  ref: string;
  constructor(message: string, ref: string) {
    super(message);
    this.ref = ref;
  }
}

export class Git {
  constructor(
    private execa: Execa,
    private token: string,
  ) {}

  private async git(command: string, args: string[], pwd: string) {
    console.log(`git ${command} ${args.join(" ")}`);
    const child = this.execa("git", [command, ...args], {
      cwd: pwd,
      env: {
        GIT_COMMITTER_NAME: "github-actions[bot]",
        GIT_COMMITTER_EMAIL: "github-actions[bot]@users.noreply.github.com",
      },
      reject: false,
    });
    child.stderr?.pipe(process.stderr);
    return child;
  }

  /**
   * Fetches a ref from origin
   *
   * @param ref the sha, branchname, etc to fetch
   * @param pwd the root of the git repository
   * @param depth the number of commits to fetch
   * @param remote the remote to fetch from
   * @throws GitRefNotFoundError when ref not found
   * @throws Error for any other non-zero exit code
   */
  public async fetch(
    ref: string,
    pwd: string,
    depth: number,
    remote: string = "origin",
  ) {
    const { exitCode } = await this.git(
      "fetch",
      [`--depth=${depth}`, remote, ref],
      pwd,
    );
    if (exitCode === 128) {
      throw new GitRefNotFoundError(
        `Expected to fetch '${ref}', but couldn't find it`,
        ref,
      );
    } else if (exitCode !== 0) {
      throw new Error(
        `'git fetch origin ${ref}' failed with exit code ${exitCode}`,
      );
    }
  }

  public async findMergeCommits(
    commitShas: string[],
    pwd: string,
  ): Promise<string[]> {
    const range = `${commitShas[0]}^..${commitShas[commitShas.length - 1]}`;
    const { exitCode, stdout } = await this.git(
      "rev-list",
      ["--merges", range],
      pwd,
    );
    if (exitCode !== 0) {
      throw new Error(
        `'git rev-list --merges ${range}' failed with exit code ${exitCode}`,
      );
    }
    const mergeCommitShas = stdout
      .split("\n")
      .filter((sha) => sha.trim() !== "");
    return mergeCommitShas;
  }

  public async push(
    branchname: string,
    remote: string = "origin",
    pwd: string,
  ) {
    const { exitCode } = await this.git(
      "push",
      ["--set-upstream", remote, branchname],
      pwd,
    );
    if (exitCode !== 0) {
      throw new Error(
        `'git push --set-upstream ${remote} ${branchname}' failed with exit code ${exitCode}`,
      );
    }
    return exitCode;
  }

  /**
   * Adds a new remote to the Git repository at the specified path.
   * @param repo The URL of the remote repository to add.
   * @param remote_name The name to give to the new remote. Defaults to "upstream".
   * @param pwd The path to the Git repository.
   * @throws An error if the 'git remote add' command fails.
   */
  public async add_remote(
    repo: string,
    remote_name: string = "origin",
    pwd: string,
  ) {
    // https://[TOKEN]@github.com/[REPO-OWNER]/[REPO-NAME]
    // TODO: will the token get leaked when someone enables debug logging?
    var remote_url = `https://${this.token}@github.com/${repo}`;
    const { exitCode } = await this.git(
      "remote",
      ["add", remote_name, remote_url],
      pwd,
    );
    // TODO: when defaulting to remote, we can skip this and ignore the errror
    if (exitCode !== 0) {
      throw new Error(
        `'git remote add ${remote_name} ${repo}' failed with exit code ${exitCode}`,
      );
    }
    return exitCode;
  }

  public async checkout(
    branch: string,
    start: string,
    remote: string = "origin",
    pwd: string,
  ) {
    const { exitCode } = await this.git(
      "switch",
      ["-c", branch, `${remote}/${start}`],
      pwd,
    );
    if (exitCode !== 0) {
      throw new Error(
        `'git switch -c ${branch} ${remote}/${start}' failed with exit code ${exitCode}`,
      );
    }
    return exitCode;
  }

  public async cherryPick(commitShas: string[], pwd: string) {
    const { exitCode } = await this.git(
      "cherry-pick",
      ["-x", ...commitShas],
      pwd,
    );
    if (exitCode !== 0) {
      await this.git("cherry-pick", ["--abort"], pwd);
      throw new Error(
        `'git cherry-pick -x ${commitShas}' failed with exit code ${exitCode}`,
      );
    }
    return exitCode;
  }
}
