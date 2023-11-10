import dedent from "dedent";
import { replacePlaceholders } from "../utils";
describe("compose body/title", () => {
  const main_default = {
    number: 123,
    body: "foo-body",
    user: { login: "foo-author" },
    title: "some pr title",
  };
  const target = "foo-target";

  describe("returns same value as provided template", () => {
    it("for an empty template", () => {
      expect(replacePlaceholders("", main_default, target)).toEqual("");
    });

    it("for a template without placeholders", () => {
      const template = text({});
      expect(replacePlaceholders(template, main_default, target)).toEqual(
        template,
      );
    });

    it("for a template with unknown placeholders", () => {
      const template = text({
        start: "${abc}",
        middle: "${def}",
        end: "${ghi}",
        part: "${jkl}",
      });
      expect(replacePlaceholders(template, main_default, target)).toEqual(
        template,
      );
    });
  });

  describe("returns evaluated templated", () => {
    it("for a template with target_branch placeholder", () => {
      const template = "Backport of some-title to `${target_branch}`";
      expect(replacePlaceholders(template, main_default, target)).toEqual(
        "Backport of some-title to `foo-target`",
      );
    });

    it("for a template with pull_number placeholder", () => {
      const template = "Backport of #${pull_number} to some-target";
      expect(replacePlaceholders(template, main_default, target)).toEqual(
        "Backport of #123 to some-target",
      );
    });

    it("for a template with pull_title placeholder", () => {
      const template = "Backport of ${pull_title} to some-target";
      expect(replacePlaceholders(template, main_default, target)).toEqual(
        "Backport of some pr title to some-target",
      );
    });

    describe("for a template with issue_refs placeholder", () => {
      const template = "Backport that refers to: ${issue_refs}";

      it("and body has no referred issues", () => {
        expect(replacePlaceholders(template, main_default, target)).toEqual(
          "Backport that refers to: ",
        );
      });

      it("and body has a referred issue", () => {
        expect(
          replacePlaceholders(
            template,
            {
              ...main_default,
              body: "Body mentions #123 and that's it.",
            },
            target,
          ),
        ).toEqual("Backport that refers to: #123");
      });

      it("and body has some referred issues", () => {
        expect(
          replacePlaceholders(
            template,
            {
              ...main_default,
              body: "This body refers to #123 and foo/bar#456",
            },
            target,
          ),
        ).toEqual("Backport that refers to: #123 foo/bar#456");
      });
    });

    it("for a template with pull_author placeholder", () => {
      const template = "Backport of pull made by @${pull_author}";
      expect(replacePlaceholders(template, main_default, target)).toEqual(
        "Backport of pull made by @foo-author",
      );
    });
  });
});

function text({
  start = "",
  middle = "",
  end = "",
  part = "",
}: {
  start?: string;
  middle?: string;
  end?: string;
  part?: string;
}) {
  return dedent`${start ?? ""} foo bar
                bar bar ${middle ?? ""} bar

                foo/${part ?? ""} foo${part ?? ""}foo ${part ?? ""}foo

                foo bar bar foo ${end ?? ""}`;
}
