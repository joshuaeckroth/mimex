export const SUPPORTED_SHELLS = ["bash", "zsh", "fish"] as const;
export type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

const COMMANDS = [
  "workspace:info",
  "note:create",
  "note:get",
  "note:list",
  "note:archive",
  "note:restore",
  "body:add",
  "search",
  "follow",
  "import:notion",
  "links:hard",
  "links:resolve",
  "links:follow-hard",
  "links:soft",
  "completion"
];

const GLOBAL_OPTIONS = ["--workspace", "-w", "--json", "--porcelain"];

function bashCompletionBody(): string {
  const commands = COMMANDS.join(" ");
  const globalOptions = GLOBAL_OPTIONS.join(" ");

  return `
__mimex_cli_note_ids() {
  mimex-cli --porcelain note:list --all 2>/dev/null | awk -F'\\t' '$1=="NOTE" {print $2}'
}

__mimex_cli_hard_links() {
  local src="$1"
  [ -z "$src" ] && return
  mimex-cli --porcelain links:hard "$src" 2>/dev/null | awk -F'\\t' '$1=="HARDLINK" {print $2}'
}

__mimex_cli_command_index() {
  local i=1
  while [[ $i -lt \${#COMP_WORDS[@]} ]]; do
    local word="\${COMP_WORDS[$i]}"
    case "$word" in
      --workspace|-w)
        ((i+=2))
        continue
        ;;
      --json|--porcelain)
        ((i+=1))
        continue
        ;;
      -*)
        ((i+=1))
        continue
        ;;
      *)
        echo "$i"
        return 0
        ;;
    esac
  done
  echo "-1"
}

_mimex_cli_complete() {
  local cur prev cmd cmd_index arg_index
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd_index="$(__mimex_cli_command_index)"

  if [[ "$prev" == "--workspace" || "$prev" == "-w" ]]; then
    COMPREPLY=( $(compgen -d -- "$cur") )
    return 0
  fi

  if [[ "$prev" == "--markdown-file" || "$prev" == "-f" ]]; then
    COMPREPLY=( $(compgen -f -- "$cur") )
    return 0
  fi

  if [[ "$cmd_index" -lt 0 || "$COMP_CWORD" -le "$cmd_index" ]]; then
    if [[ "$cur" == -* ]]; then
      COMPREPLY=( $(compgen -W "${globalOptions}" -- "$cur") )
      return 0
    fi

    COMPREPLY=( $(compgen -W "${commands}" -- "$cur") )
    return 0
  fi

  cmd="\${COMP_WORDS[$cmd_index]}"
  arg_index=$((COMP_CWORD - cmd_index))

  if [[ "$cur" == -* ]]; then
    local opts="${globalOptions}"
    case "$cmd" in
      note:create) opts="$opts --markdown -m --markdown-file -f --label -l --alias -a" ;;
      note:list) opts="$opts --all" ;;
      body:add) opts="$opts --markdown -m --markdown-file -f --label -l" ;;
      search) opts="$opts --limit -l --all" ;;
      import:notion) opts="$opts --query -q --limit -l --dry-run --mcp-command --mcp-arg --strategy --planner-command --planner-timeout-ms" ;;
      links:resolve|links:follow-hard|links:soft) opts="$opts --limit -l" ;;
      completion) opts="$opts" ;;
    esac
    COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
    return 0
  fi

  case "$cmd" in
    note:get|note:archive|note:restore|links:hard|links:resolve|links:follow-hard|links:soft)
      if [[ "$arg_index" -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "$(__mimex_cli_note_ids)" -- "$cur") )
        return 0
      fi
      ;;
    body:add)
      if [[ "$arg_index" -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "$(__mimex_cli_note_ids)" -- "$cur") )
        return 0
      fi
      ;;
    follow)
      if [[ "$arg_index" -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "$(__mimex_cli_note_ids)" -- "$cur") )
        return 0
      fi
      if [[ "$arg_index" -eq 2 ]]; then
        local src="\${COMP_WORDS[$((cmd_index + 1))]}"
        COMPREPLY=( $(compgen -W "$(__mimex_cli_note_ids) $(__mimex_cli_hard_links "$src")" -- "$cur") )
        return 0
      fi
      ;;
    import:notion)
      if [[ "$prev" == "--strategy" ]]; then
        COMPREPLY=( $(compgen -W "heuristic llm" -- "$cur") )
        return 0
      fi
      ;;
    completion)
      if [[ "$arg_index" -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )
        return 0
      fi
      ;;
  esac
}
`;
}

function renderBashCompletion(): string {
  return `${bashCompletionBody()}\ncomplete -F _mimex_cli_complete mimex-cli\n`;
}

function renderZshCompletion(): string {
  return `#compdef mimex-cli\nautoload -U +X bashcompinit && bashcompinit\n${bashCompletionBody()}\ncomplete -F _mimex_cli_complete mimex-cli\n`;
}

function renderFishCompletion(): string {
  const commandLines = COMMANDS.map((cmd) => `complete -c mimex-cli -f -n '__fish_use_subcommand' -a '${cmd}'`).join("\n");

  return `
function __mimex_cli_note_ids
  mimex-cli --porcelain note:list --all 2>/dev/null | awk -F'\\t' '$1=="NOTE" {print $2}'
end

complete -c mimex-cli -l workspace -s w -r
complete -c mimex-cli -l json
complete -c mimex-cli -l porcelain

${commandLines}

complete -c mimex-cli -n '__fish_seen_subcommand_from note:get note:archive note:restore links:hard links:resolve links:follow-hard links:soft body:add follow' -f -a '(__mimex_cli_note_ids)'
complete -c mimex-cli -n '__fish_seen_subcommand_from note:create' -l markdown -s m -r
complete -c mimex-cli -n '__fish_seen_subcommand_from note:create' -l markdown-file -s f -r
complete -c mimex-cli -n '__fish_seen_subcommand_from note:create' -l label -s l -r
complete -c mimex-cli -n '__fish_seen_subcommand_from note:create' -l alias -s a -r
complete -c mimex-cli -n '__fish_seen_subcommand_from note:list' -l all
complete -c mimex-cli -n '__fish_seen_subcommand_from body:add' -l markdown -s m -r
complete -c mimex-cli -n '__fish_seen_subcommand_from body:add' -l markdown-file -s f -r
complete -c mimex-cli -n '__fish_seen_subcommand_from body:add' -l label -s l -r
complete -c mimex-cli -n '__fish_seen_subcommand_from search' -l limit -s l -r
complete -c mimex-cli -n '__fish_seen_subcommand_from search' -l all
complete -c mimex-cli -n '__fish_seen_subcommand_from import:notion' -l query -s q -r
complete -c mimex-cli -n '__fish_seen_subcommand_from import:notion' -l limit -s l -r
complete -c mimex-cli -n '__fish_seen_subcommand_from import:notion' -l dry-run
complete -c mimex-cli -n '__fish_seen_subcommand_from import:notion' -l mcp-command -r
complete -c mimex-cli -n '__fish_seen_subcommand_from import:notion' -l mcp-arg -r
complete -c mimex-cli -n '__fish_seen_subcommand_from import:notion' -l strategy -a 'heuristic llm'
complete -c mimex-cli -n '__fish_seen_subcommand_from import:notion' -l planner-command -r
complete -c mimex-cli -n '__fish_seen_subcommand_from import:notion' -l planner-timeout-ms -r
complete -c mimex-cli -n '__fish_seen_subcommand_from links:resolve links:follow-hard links:soft' -l limit -s l -r
complete -c mimex-cli -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'
`;
}

export function renderCompletionScript(shell: string): string {
  const normalized = shell.trim().toLowerCase();

  if (normalized === "bash") {
    return renderBashCompletion();
  }

  if (normalized === "zsh") {
    return renderZshCompletion();
  }

  if (normalized === "fish") {
    return renderFishCompletion();
  }

  throw new Error(`unsupported shell: ${shell}`);
}
