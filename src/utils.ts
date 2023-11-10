import { PullRequest } from "./github";

/**
 * @param template The template potentially containing placeholders
 * @param main The main pull request that is backported
 * @param target The target branchname
 * @returns Description that can be used in the backport pull request
 */
export function replacePlaceholders(
  template: string,
  main: Pick<PullRequest, "body" | "user" | "number" | "title">,
  target: string,
  owner: string = "",
  repo: string = "",
): string {
  return template
    .replace("${pull_author}", main.user.login)
    .replace("${pull_number}", main.number.toString())
    .replace("${pull_title}", main.title)
    .replace("${target_branch}", target)
    .replace("${repo}", repo)
    .replace("${owner}", owner);
}
