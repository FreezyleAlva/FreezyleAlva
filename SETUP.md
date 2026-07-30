# Deployment

Target repository: `FreezAlva/FreezAlva` (the special profile repository — its README renders on your GitHub profile). It must be **public**, otherwise the profile README does not show and the issue-based game is unreachable.

## 1. File layout

```
FreezAlva/
  README.md
  SETUP.md
  assets/
    banner-dark.svg
    banner-light.svg
  .github/
    game/
      state.json
    scripts/
      game-bot.mjs
    workflows/
      game-bot.yml
      snake.yml
```

Commit all of it to the default branch. If your default branch is not `main`, change the `push.branches` filter in `snake.yml`.

## 2. Repository settings

| Setting | Value | Why |
| --- | --- | --- |
| Settings → Actions → General → Workflow permissions | Read and write permissions | The bot commits the updated board and closes issues. |
| Settings → General → Features → Issues | Enabled | The game protocol runs on issues. |
| Settings → Actions → General → Allow actions | Allow all, or allow `Platane/*` and `crazy-max/*` | Required by the snake workflow. |

No secrets to create. Both workflows use the automatic `GITHUB_TOKEN`.

## 3. First run

1. Run **profile-contribution-snake** manually from the Actions tab. It creates the `output` branch containing `snake-light.svg` and `snake-dark.svg`. Until that branch exists, the contribution graph section shows a broken image.
2. Open an issue titled `game/ttt: move 5` to smoke-test the bot. Expected result: a bot comment, the issue closed, and a commit named `chore(game): update tic-tac-toe board`.

## 4. Tuning

| What | Where |
| --- | --- |
| Bot difficulty | `TTT_DIFFICULTY` in `game-bot.yml`. `casual` (default here) is beatable, `perfect` is not. |
| Snake schedule | `cron` in `snake.yml`, currently 03:17 UTC daily. |
| Banner text and colours | `assets/banner-*.svg`. Tokens: accent `#FFB245` / `#B4650A`, ink `#E8EEF9` / `#0A1120`, hairline `#1C2740` / `#D6DEEA`. |
| Stats card colours | Query parameters in the Metrics section of `README.md`, already matched to the banner tokens. |

## 5. Known trade-offs

- **Commit noise.** Every completed turn is one commit on the profile repository. If that bothers you, point the game state and rendering at a separate repository and embed the board through an image instead of markdown.
- **Third-party stats cards.** `github-readme-stats.vercel.app` and `streak-stats.demolab.com` are shared public instances and are rate limited. `cache_seconds` softens it; a private deployment removes the dependency entirely.
- **SVG fonts.** The banner uses system font stacks because external fonts cannot be loaded inside an SVG rendered through GitHub's image proxy. The name uses `textLength`, so it stays inside its rule regardless of which font a visitor resolves.
- **Anyone can play.** The board is public and any GitHub user can submit a move. Invalid commands are rejected without touching state, but if you want it locked down, gate on `github.event.issue.user.login == github.repository_owner` in the workflow `if:` condition.
