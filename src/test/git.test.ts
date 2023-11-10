import { Git, GitRefNotFoundError } from "../git";
import { execa } from "execa";

const git = new Git(execa, "1234");
let response = { exitCode: 0, stdout: "" };

jest.mock("execa", () => ({
  execa: jest.fn(() => response),
}));

describe("git.fetch", () => {
  describe("throws GitRefNotFoundError", () => {
    it("when fetching an unknown ref, i.e. exit code 128", async () => {
      response.exitCode = 128;
      expect.assertions(3);
      await git.fetch("unknown", "", 1).catch((error) => {
        expect(error).toBeInstanceOf(GitRefNotFoundError);
        expect(error).toHaveProperty(
          "message",
          "Expected to fetch 'unknown', but couldn't find it",
        );
        expect(error).toHaveProperty("ref", "unknown");
      });
    });
  });

  describe("throws Error", () => {
    it("when failing with an unexpected non-zero exit code", async () => {
      response.exitCode = 1;
      await expect(git.fetch("unknown", "", 1)).rejects.toThrowError(
        `'git fetch origin unknown' failed with exit code 1`,
      );
    });
  });
});

describe("git.cherryPick", () => {
  describe("throws Error", () => {
    it("when failing with an unexpected non-zero exit code", async () => {
      response.exitCode = 1;
      await expect(git.cherryPick(["unknown"], "")).rejects.toThrowError(
        `'git cherry-pick -x unknown' failed with exit code 1`,
      );
    });
  });
});

describe("git.findMergeCommits", () => {
  describe("throws Error", () => {
    it("when failing with an unpexected non-zero exit code", async () => {
      response.exitCode = 1;
      await expect(git.findMergeCommits(["unknown"], "")).rejects.toThrowError(
        `'git rev-list --merges unknown^..unknown' failed with exit code 1`,
      );
    });
  });

  describe("returns all merge commits", () => {
    it("when git rev-list outputs them", async () => {
      response.exitCode = 0;
      response.stdout = "two\nfour";
      expect(
        await git.findMergeCommits(["one", "two", "three", "four"], ""),
      ).toEqual(["two", "four"]);
    });
  });
});
