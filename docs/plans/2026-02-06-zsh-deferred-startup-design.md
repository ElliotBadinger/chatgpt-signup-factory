# Zsh Deferred Startup Design (2026-02-06)

## Goal
Make the Zsh prompt appear immediately while keeping all existing features (Oh My Zsh, completions, fzf, nvm, OpenClaw, brew, starship). “Instant” refers to perceived prompt speed; heavy initialization is deferred to run immediately after the first prompt draw.

## Constraints
- No feature removal.
- Safe fallback if the defer helper is missing or fails.
- Keep configuration maintainable and reversible.

## Approach
- Introduce a tiny local `zsh-defer` helper (`~/.zsh-defer/zsh-defer.plugin.zsh`).
- Defer heavy initialization to after the first prompt using `zle -F` and a one-shot pipe trigger.
- Keep prompt-critical settings and light environment setup in the fast path.

## Deferred Items
- `source $ZSH/oh-my-zsh.sh` (compinit + plugins)
- fzf keybindings/completion
- nvm initialization
- OpenClaw completion (cached)
- brew shellenv

## Safety & Fallback
- Each deferred init is guarded: if `zsh-defer` is unavailable, the init runs immediately.
- `nvm_init` is idempotent and can be called on demand (used by the `pi` wrapper).

## Verification
- Measure `zsh -i -c 'exit'` before/after to confirm reduced startup time.
- Open a new interactive shell and confirm:
  - Prompt appears immediately.
  - Completions, autosuggestions, and fzf are ready shortly after prompt.
  - `pi` works even if nvm was not yet loaded.
