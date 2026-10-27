# Contributing to Zarvis

Thanks for helping. Fork the repo, branch, and open a pull request against `main`; direct pushes to `main` are not used.

## Run it and test it

```bash
npm start      # the dashboard
npm test       # node --test, no test dependencies
```

Needs Node >= 22.13. See [Run](README.md#run) and [Test](README.md#test) in the README. CI runs `npm test` on every PR.

## Rules

- **Zero dependencies.** No `dependencies`, `devDependencies`, bundlers or CDN scripts. Use Node built-ins and plain browser JS.
- **Tests use temp dirs only.** Never read or write the real `~/.zarvis`, `~/.claude/settings.json` or `~/.claude` transcripts. Create a dir with `fs.mkdtemp` under `os.tmpdir()` and pass it in (`ZARVIS_HOME` etc., or an explicit `--settings` path). New code that touches those locations must take the path as a parameter or env override so it can be tested this way.
- **No personal data in the repo.** No real home paths, usernames, emails, session ids, tokens or transcripts, in code, tests, fixtures or docs. Use placeholders like `/opt/zarvis/...` or `/home/user/...`.
- **Hooks must never break a session.** The hook is fail-safe and fast; keep it that way. How hooks and the installer work: [The hook](README.md#the-hook). Skills, roles and the roster: [Roles](README.md#roles) and [Roster](README.md#roster).

## UI rules (`public/`)

- `render()` rewrites `#list`. Effects, overlays and decoration live outside it so a re-render never wipes them.
- Animate `transform` and `opacity` only.
- Honour `prefers-reduced-motion`.
- Keep the key map and its tests (`test/keys.test.mjs`) intact; update both together when a key changes. See [Keys](README.md#keys).
- Text contrast must meet WCAG AA (4.5:1 body text).

## Pull request checklist

- [ ] `npm test` passes, with tests for new behaviour
- [ ] No new dependencies
- [ ] Tests use temp dirs only
- [ ] No personal paths, emails or tokens
- [ ] UI changes follow the rules above
- [ ] README updated if behaviour, env vars or commands changed

## Reporting security issues

Do not open a public issue. Use GitHub's private vulnerability reporting (the repo's **Security** tab, then **Report a vulnerability**). See [SECURITY.md](SECURITY.md).
