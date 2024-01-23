import { PullRequest } from "./github";

/**
 * @param template The template potentially containing placeholders
 * @param main The main pull request that is cherry-picked
 * @param target The target branchname
 * @returns Description that can be used in the cherry-picked pull request
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
    .replace("${pull_description}", main.body ?? "")
    .replace("${target_branch}", target)
    .replace("${repo}", repo)
    .replace("${owner}", owner);
}
