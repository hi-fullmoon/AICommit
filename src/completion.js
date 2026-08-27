const TOP_LEVEL = [
  'setup',
  'doctor',
  'config',
  'policy',
  'preset',
  'completion',
  'split',
  'stats',
  '--help',
  '--version',
  '--lang',
  '--provider',
  '--split-hunks',
  '--scope',
  '--reasoning',
  '--no-reasoning',
  '--dry-run',
  '--yes',
  '--output',
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
    preset) COMPREPLY=( $(compgen -W "show validate path install rollback --file --output --debug" -- "$cur") ); return ;;
    completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ); return ;;
    split) COMPREPLY=( $(compgen -W "run plan apply resume abort --scope --file --split-hunks --yes --output --debug" -- "$cur") ); return ;;
    stats) COMPREPLY=( $(compgen -W "show clear enable disable" -- "$cur") ); return ;;
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
    'preset:manage versioned provider preset manifests'
    'completion:generate shell completion'
    'split:run, plan, apply, resume, or abort split commits'
    'stats:show local quality trends'
  )
  options=(
    '--help[show help]'
    '--version[show version]'
    '--lang=[commit language]:language:(zh en)'
    '--provider=[provider name]:provider:'
    '--split-hunks[experimental same-file hunk splitting]'
    '--scope=[split scope]:scope:(staged all)'
    '--file=[split plan or commit-message file]:path:_files'
    '--range=[Git range for policy check]:revision:'
    '--reasoning=[reasoning effort]:effort:(low medium high xhigh max)'
    '--no-reasoning[disable reasoning]'
    '--dry-run[review without committing]'
    '--yes[accept without prompts]'
    '--output=[output mode]:output:(text json)'
    '--debug[show debug details]'
  )
  _arguments -C $options '*::argument:->args'
  case $state in
    args)
      case $words[2] in
        config) _values 'config action' show validate path ;;
        policy) _values 'policy action' template check ;;
        preset) _values 'preset action' show validate path install rollback ;;
        completion) _values 'shell' bash zsh fish ;;
        split) _values 'split action' run plan apply resume abort ;;
        stats) _values 'action' show clear enable disable ;;
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
complete -c aicommit -n '__fish_use_subcommand' -a preset -d 'Manage versioned provider preset manifests'
complete -c aicommit -n '__fish_use_subcommand' -a completion -d 'Generate shell completion'
complete -c aicommit -n '__fish_use_subcommand' -a split -d 'Run, plan, apply, resume, or abort split commits'
complete -c aicommit -n '__fish_use_subcommand' -a stats -d 'Show local quality trends'
complete -c aicommit -n '__fish_seen_subcommand_from config' -a 'show validate path'
complete -c aicommit -n '__fish_seen_subcommand_from policy' -a 'template check'
complete -c aicommit -n '__fish_seen_subcommand_from preset' -a 'show validate path install rollback'
complete -c aicommit -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'
complete -c aicommit -n '__fish_seen_subcommand_from split' -a 'run plan apply resume abort'
complete -c aicommit -n '__fish_seen_subcommand_from stats' -a 'show clear enable disable'
complete -c aicommit -s h -l help -d 'Show help'
complete -c aicommit -s v -l version -d 'Show version'
complete -c aicommit -s l -l lang -x -a 'zh en' -d 'Commit language'
complete -c aicommit -s p -l provider -x -d 'Provider name'
complete -c aicommit -l split-hunks -d 'Experimental same-file hunk splitting'
complete -c aicommit -l scope -x -a 'staged all' -d 'Split plan scope'
complete -c aicommit -l file -r -d 'Split plan file'
complete -c aicommit -l range -r -d 'Git range for policy check'
complete -c aicommit -l reasoning -x -a 'low medium high xhigh max' -d 'Reasoning effort'
complete -c aicommit -l no-reasoning -d 'Disable reasoning'
complete -c aicommit -l dry-run -d 'Review without committing'
complete -c aicommit -s y -l yes -d 'Accept without prompts'
complete -c aicommit -l output -x -a 'text json' -d 'Output mode'
complete -c aicommit -l debug -d 'Show debug details'
`;

const SCRIPTS = { bash: BASH, zsh: ZSH, fish: FISH };

export function generateCompletion(shell) {
  const script = SCRIPTS[shell];
  if (!script) throw new Error(`Unsupported shell: ${shell}. Use bash, zsh, or fish.`);
  return script;
}
