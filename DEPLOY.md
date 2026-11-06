# Deploying

The app is static files served by Firebase Hosting. There is no build step:
what is on disk in this folder is what gets uploaded.

## Where it goes

One Firebase project, `time-trial-timer-e19dd`, with two hosting sites that
always get the same files:

| Target   | URL                                     |
| -------- | --------------------------------------- |
| `main`   | https://gl-timer.web.app                |
| `legacy` | https://time-trial-timer-e19dd.web.app  |

Both are deployed together so neither serves stale code.

## One-time setup

1. Install the Firebase CLI under an arm64 Node (this Mac is Apple Silicon
   with no Rosetta). It is already installed under nvm's Node 20.19.0.
2. Sign in once:

```bash
firebase login
```

3. Make sure `firebase.js` exists in the folder. It is gitignored, so a fresh
   clone will not have it. See the next section to get it back.

## If `firebase.js` is missing

It holds the project's web config (API key, database URL, app id). That config
is not a secret: every visitor's browser downloads it, and access is enforced
by `database.rules.json`, not by hiding the file. So it can be recovered from
three places, quickest first:

1. **From the live site.** The deployed copy is identical to the local one:

   ```bash
   curl -s https://gl-timer.web.app/firebase.js -o firebase.js
   ```

2. **From the CLI**, which prints the same values. Paste them into a copy of
   `firebase.example.js`, keeping the two lines at the bottom:

   ```bash
   PATH="$HOME/.nvm/versions/node/v20.19.0/bin:$PATH" firebase apps:sdkconfig web
   ```

3. **From the console.** Firebase console → Project settings → Your apps →
   the web app → "SDK setup and configuration" → Config.

Keep it out of git. Deploying with a wrong or missing `firebase.js` ships a
site that cannot reach the database.

## Deploy

From the repo folder, with the work committed:

```bash
PATH="$HOME/.nvm/versions/node/v20.19.0/bin:$PATH" firebase deploy --only hosting
```

The `PATH` prefix matters. The `firebase` command runs on whatever `node` is
first on your PATH, and several older nvm versions here are Intel builds.
Without the prefix you get:

```
env: node: Bad CPU type in executable
```

A successful run ends with `Deploy complete!` and both hosting URLs.

## Check it

Phones can hold an old copy for a moment. Pages are sent with `no-cache`, so a
reload is enough. To confirm from the terminal, look for something you just
changed in the live file:

```bash
curl -s https://gl-timer.web.app/styles.css | grep -c 'some-new-class'
```

A `0` right after a deploy is usually the CDN edge; try again in ten seconds.

## Good to know

- **Hosting uploads the working tree, not git.** Anything in the folder ships
  unless it matches the `ignore` list in `firebase.json`. That list already
  excludes dotfiles, the Firebase config files and `design-review/`. If you
  add scratch folders, add them there too.
- **Database rules are separate.** `--only hosting` leaves them alone. To push
  `database.rules.json`:

  ```bash
  PATH="$HOME/.nvm/versions/node/v20.19.0/bin:$PATH" firebase deploy --only database
  ```

  A bare `firebase deploy` does both.
- **Add the changelog line first.** Each user-visible change gets one line in
  `CHANGELOG.md` under today's date, in the same commit as the change.
- **Rolling back:** Firebase console → Hosting → the site → release history →
  "Rollback" on the previous version. No command needed.
