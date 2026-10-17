# toasts — message stack and history
`web/features/toasts.js` · loads 24th (after wizard)

## Purpose
`SV.flash(msg)` messages appear at the bottom centre. A message still on screen when the next one arrives stays above
it until its own time is up (at most three), so quick successions are not lost. Every message goes into a history
(newest first, 100 kept), opened from **Messages** in the status bar (the badge counts unseen ones). The history panel
has the preference **Show for: Short (2.5 s, default) / Long (6 s)** and Clear.

`#flash` stays the newest message (tests and old callers read it). Messages carry a kind (`info`, `ok`, `warn`, `err`)
shown as a coloured edge: `SV.flash(msg, { kind, ms })`, else guessed from the text ("Could not…", "… failed" → err;
"No …" → warn).

## Owns
- `#svToasts` (holds `#flash` and `.svt-old`), `#svToastBtn`, `#svToastPop` (`#svToastMs`, `#svToastClear`).
- `SV.toasts`: `history()`, `clear()`, `open()`, `close()`, `isOpen()`, `duration()`, `setDuration(ms)`, pure
  `createHistory`, `guessKind`.
- localStorage `scoreview.toasts.ms`.
- Core hook used: `SV.flash(msg, opts)` dispatches `sv-flash` (`{msg, kind, ms}`) and hides `#flash` after `SV.flash.ms`.

## Hooks
None (the `sv-flash` window event).

## Tests
`test/gui-test.mjs` (history ring, kinds), `test/gui-e2e.mjs` (stack, history order, unseen count, preference, Clear).
