on run
  try
    set selectedFolder to choose folder with prompt "Choose the Git project to use with Relay"
  on error number -128
    return
  end try

  set projectPath to POSIX path of selectedFolder
  set relayExecutable to POSIX path of (path to home folder) & ".local/bin/relay"

  try
    do shell script "test -x " & quoted form of relayExecutable
  on error
    display alert "Relay is not installed" message "Run npm run install:local from the Relay project, then open this launcher again."
    return
  end try

  set projectArgument to quoted form of projectPath
  set relayArgument to quoted form of relayExecutable
  set terminalCommand to "cd " & projectArgument & "; clear; " & ¬
    "if [ -f .relay/config.json ]; then " & ¬
    "if [ -f .relay/state.json ]; then " & relayArgument & " status; " & ¬
    "else printf 'Relay is initialized in this project.\\nStart a task with: relay start YOUR_TASK\\n'; fi; " & ¬
    "else " & relayArgument & " init; fi; " & ¬
    "printf '\\nTerminal is ready in %s\\n' " & projectArgument & "; " & ¬
    "exec \"${SHELL:-/bin/zsh}\" -l"

  tell application "Terminal"
    activate
    do script terminalCommand
  end tell
end run
