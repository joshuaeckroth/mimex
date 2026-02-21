import { describe, expect, it } from "vitest";
import { renderCompletionScript } from "../src/completion.js";

describe("completion scripts", () => {
  it("renders bash completion", () => {
    const script = renderCompletionScript("bash");
    expect(script).toContain("_mimex_cli_complete");
    expect(script).toContain("__mimex_cli_command_index");
    expect(script).toContain("complete -F _mimex_cli_complete mimex-cli");
    expect(script).toContain("note:archive");
  });

  it("renders zsh completion", () => {
    const script = renderCompletionScript("zsh");
    expect(script).toContain("#compdef mimex-cli");
    expect(script).toContain("bashcompinit");
  });

  it("renders fish completion", () => {
    const script = renderCompletionScript("fish");
    expect(script).toContain("complete -c mimex-cli");
    expect(script).toContain("__fish_use_subcommand");
    expect(script).toContain("note:create");
    expect(script).toContain("-l markdown");
  });

  it("rejects unsupported shells", () => {
    expect(() => renderCompletionScript("powershell")).toThrow("unsupported shell");
  });
});
