# Windfall — Regression Check Pack

A fast safety net that catches the kinds of bugs that have actually broken
Windfall before: **buttons that silently do nothing, handlers wired to nothing,
typo'd element IDs, and calls to API endpoints that don't exist.**

It is pure static analysis — no browser, no server, no Redis, no installs.
It runs in under a second.

## How to run it

From the project folder:

```
npm test
```

or directly:

```
node test/regression-check.js
```

- **Exit code 0** + "ALL CHECKS PASSED" → safe to push.
- **Exit code 1** + red ✗ lines → fix those before pushing.

**Run it after every change, before you `git push`.**

## What it checks

| # | Check | Catches |
|---|-------|---------|
| 0 | JavaScript syntax | Typos, unclosed brackets in `app.js`, `server.js`, `sw.js` |
| A | Inline handler attributes are well-formed | The `JSON.stringify` quote bug that silently killed the Delete button |
| B | Inline handlers point at real global functions | A button calling a function that was renamed, removed, or never `window.`-exported |
| C | `getElementById` targets exist | Code looking for an element ID that isn't in the HTML (typo or deleted element) |
| D | Frontend API calls have matching server routes | `fetch("/api/...")` to an endpoint that doesn't exist (renamed on one side only) |
| E | Bottom-nav buttons are all handled | A `data-view` nav button with no click handler |

**Errors (✗)** fail the run — these are almost always real bugs.
**Warnings (!)** are worth a look but may be fine (e.g. an element built dynamically the checker couldn't see).

## What it does NOT check

This is a wiring/integrity check, not a full behavioural test. It does **not**
log in, click through real flows, or talk to the database. It won't catch logic
mistakes (e.g. "pickup adds the wrong kg"). It *will* catch the dead-button class
of bug that keeps biting.

If you want true click-through testing later, the next step would be a small
Playwright end-to-end suite that drives a real browser against a test server —
ask and it can be added.

## Adding your own checks

Open `test/regression-check.js` — each check is a clearly labelled section.
Copy the pattern of an existing one, increment `errors` (hard fail) or
`warnings` (soft) when something looks wrong, and print with `fail()` / `warn()`.
