const TOP_LEVEL = [
  'setup',
  'doctor',
  'config',
  'policy',
  'completion',
  'split',
  'stats',
  'metrics',
  '--help',
  '--version',
  '--lang',
  '--provider',
  '--split',
  '--split=staged',
  '--split=all',
  '--split-hunks',
  '--reasoning',
  '--no-reasoning',
  '--dry-run',
  '--yes',
  '--output',
  '--check',
  '--debug',
];

const BASH = `# bash completion for aicommit
_aicommit() {
  local cur prev command
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  command="\${COMP_WORDS[1]}"

  case "$command" in
    config) COMPREPLY=( $(compgen -W "show validate path --provider --output --debug" -- "$cur") ); return ;;
    policy) COMPREPLY=( $(compgen -W "template check --file --range --output --debug" -- "$cur") ); return ;;
    completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ); return ;;
    split) COMPREPLY=( $(compgen -W "plan apply --resume --scope --file --split-hunks --yes --output --debug" -- "$cur") ); return ;;
    stats|metrics) COMPREPLY=( $(compgen -W "show status clear enable disable" -- "$cur") ); return ;;
  esac
  case "$prev" in
    --lang|-l) COMPREPLY=( $(compgen -W "zh en" -- "$cur") ); return ;;
    --reasoning) COMPREPLY=( $(compgen -W "low medium high xhigh max" -- "$cur") ); return ;;
    --scope) COMPREPLY=( $(compgen -W "staged all" -- "$cur") ); return ;;
    --output) COMPREPLY=( $(compgen -W "text json" -- "$cur") ); return ;;
  esac
  COMPREPLY=( $(compgen -W "${TOP_LEVEL.join(' ')}" -- "$cur") )
}
complete -F _aicommit aicommit
`;

const ZSH = `#compdef aicommit
_aicommit() {
  local -a commands options
  commands=(
    'setup:interactive configuration wizard'
    'doctor:diagnose configuration and connectivity'
    'config:inspect or validate configuration'
    'policy:print or enforce a repository team policy'
    'completion:generate shell completion'
    'split:plan apply or resume split commits'
    'stats:show local quality trends'
    'metrics:manage local metrics'
  )
  options=(
    '--help[show help]'
    '--version[show version]'
    '--lang=[commit language]:language:(zh en)'
    '--provider=[provider name]:provider:'
    '--split=[split scope]:scope:(staged all)'
    '--split-hunks[experimental same-file hunk splitting]'
    '--file=[split plan or commit-message file]:path:_files'
    '--range=[Git range for policy check]:revision:'
    '--reasoning=[reasoning effort]:effort:(low medium high xhigh max)'
    '--no-reasoning[disable reasoning]'
    '--dry-run[review without committing]'
    '--yes[accept without prompts]'
    '--output=[output mode]:output:(text json)'
    '--check[check provider connectivity]'
    '--debug[show debug details]'
  )
  _arguments -C $options '*::argument:->args'
  case $state in
    args)
      case $words[2] in
        config) _values 'config action' show validate path ;;
        policy) _values 'policy action' template check ;;
        completion) _values 'shell' bash zsh fish ;;
        split) _values 'split action' plan apply --resume ;;
        stats|metrics) _values 'action' show status clear enable disable ;;
        *) _describe 'command' commands ;;
      esac
      ;;
  esac
}
_aicommit "$@"
`;

const FISH = `# fish completion for aicommit
complete -c aicommit -f
complete -c aicommit -n '__fish_use_subcommand' -a setup -d 'Interactive configuration wizard'
complete -c aicommit -n '__fish_use_subcommand' -a doctor -d 'Diagnose configuration and connectivity'
complete -c aicommit -n '__fish_use_subcommand' -a config -d 'Inspect or validate configuration'
complete -c aicommit -n '__fish_use_subcommand' -a policy -d 'Print or enforce a repository team policy'
complete -c aicommit -n '__fish_use_subcommand' -a completion -d 'Generate shell completion'
complete -c aicommit -n '__fish_use_subcommand' -a split -d 'Plan, apply, or resume split commits'
complete -c aicommit -n '__fish_use_subcommand' -a stats -d 'Show local quality trends'
complete -c aicommit -n '__fish_use_subcommand' -a metrics -d 'Manage local metrics'
complete -c aicommit -n '__fish_seen_subcommand_from config' -a 'show validate path'
complete -c aicommit -n '__fish_seen_subcommand_from policy' -a 'template check'
complete -c aicommit -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'
complete -c aicommit -n '__fish_seen_subcommand_from split' -a 'plan apply --resume'
complete -c aicommit -n '__fish_seen_subcommand_from stats metrics' -a 'show status clear enable disable'
complete -c aicommit -s h -l help -d 'Show help'
complete -c aicommit -s v -l version -d 'Show version'
complete -c aicommit -s l -l lang -x -a 'zh en' -d 'Commit language'
complete -c aicommit -s p -l provider -x -d 'Provider name'
complete -c aicommit -s s -l split -x -a 'staged all' -d 'Split scope'
complete -c aicommit -l split-hunks -d 'Experimental same-file hunk splitting'
complete -c aicommit -l scope -x -a 'staged all' -d 'Split plan scope'
complete -c aicommit -l file -r -d 'Split plan file'
complete -c aicommit -l range -r -d 'Git range for policy check'
complete -c aicommit -l reasoning -x -a 'low medium high xhigh max' -d 'Reasoning effort'
complete -c aicommit -l no-reasoning -d 'Disable reasoning'
complete -c aicommit -l dry-run -d 'Review without committing'
complete -c aicommit -s y -l yes -d 'Accept without prompts'
complete -c aicommit -l output -x -a 'text json' -d 'Output mode'
complete -c aicommit -s c -l check -d 'Check provider connectivity'
complete -c aicommit -l debug -d 'Show debug details'
`;

const SCRIPTS = { bash: BASH, zsh: ZSH, fish: FISH };

export function generateCompletion(shell) {
  const script = SCRIPTS[shell];
  if (!script) throw new Error(`Unsupported shell: ${shell}. Use bash, zsh, or fish.`);
  return script;
}
