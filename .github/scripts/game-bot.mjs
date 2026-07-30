/**
 * Profile Game Bot — Tic Tac Toe played through GitHub Issues.
 *
 * Trigger  : an issue titled `game/ttt: move <1-9>` or `game/ttt: reset`
 * Effect   : validates the move, replies with the bot move, rewrites the
 *            board block inside README.md, persists state, closes the issue.
 *
 * Design notes
 * - Untrusted input (issue title / author) is read from env only. It is never
 *   interpolated into a shell command by the workflow.
 * - The whole turn is a pure state transition: read state -> apply -> write.
 *   Nothing depends on the previous run except `state.json`.
 * - Every exit path is exit code 0 unless the runtime itself failed, so a
 *   malformed command from a stranger never shows up as a red workflow run.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const STATE_PATH = path.join(ROOT, ".github/game/state.json");
const README_PATH = path.join(ROOT, "README.md");

const BLOCK_START = "<!-- TTT:START -->";
const BLOCK_END = "<!-- TTT:END -->";

const HUMAN = "X";
const BOT = "O";
const EMPTY = "";

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

const env = {
  repo: process.env.GITHUB_REPOSITORY ?? "",
  token: process.env.GITHUB_TOKEN ?? "",
  issueNumber: Number(process.env.ISSUE_NUMBER ?? 0),
  issueTitle: process.env.ISSUE_TITLE ?? "",
  issueAuthor: process.env.ISSUE_AUTHOR ?? "",
  owner: process.env.REPO_OWNER ?? "",
  difficulty: (process.env.TTT_DIFFICULTY ?? "perfect").toLowerCase(),
};

/* ------------------------------------------------------------------ state */

function emptyState() {
  return {
    version: 1,
    board: Array(9).fill(EMPTY),
    turn: HUMAN,
    status: "active",
    result: null,
    winningLine: null,
    moves: 0,
    lastPlayer: null,
    updatedAt: null,
    score: { human: 0, bot: 0, draw: 0 },
  };
}

async function loadState() {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const base = emptyState();
    const state = { ...base, ...parsed };
    if (!Array.isArray(state.board) || state.board.length !== 9) state.board = base.board;
    state.score = { ...base.score, ...(parsed.score ?? {}) };
    return state;
  } catch {
    return emptyState();
  }
}

async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/* ------------------------------------------------------------------ rules */

function winnerOf(board) {
  for (const line of LINES) {
    const [a, b, c] = line;
    if (board[a] !== EMPTY && board[a] === board[b] && board[a] === board[c]) {
      return { mark: board[a], line };
    }
  }
  return null;
}

const isFull = (board) => board.every((cell) => cell !== EMPTY);
const legalMoves = (board) => board.flatMap((cell, i) => (cell === EMPTY ? [i] : []));

/* ---------------------------------------------------------------- ai */

/**
 * Negamax-style minimax with alpha-beta pruning.
 * Depth is folded into the score so the bot prefers the fastest win and the
 * slowest loss instead of treating all wins as equal.
 */
function minimax(board, mark, depth, alpha, beta) {
  const win = winnerOf(board);
  if (win) return win.mark === mark ? 10 - depth : depth - 10;
  if (isFull(board)) return 0;

  let best = -Infinity;
  for (const move of legalMoves(board)) {
    board[move] = mark;
    const score = -minimax(board, mark === HUMAN ? BOT : HUMAN, depth + 1, -beta, -alpha);
    board[move] = EMPTY;

    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function bestMove(board, mark) {
  let best = -Infinity;
  let choice = legalMoves(board)[0];

  for (const move of legalMoves(board)) {
    board[move] = mark;
    const score = -minimax(board, mark === HUMAN ? BOT : HUMAN, 1, -Infinity, Infinity);
    board[move] = EMPTY;
    if (score > best) {
      best = score;
      choice = move;
    }
  }
  return choice;
}

/**
 * `perfect` never loses. `casual` plays optimally most of the time and
 * otherwise picks a random legal cell, so a human can actually win.
 * The randomness is seeded from the move count + issue number, which keeps a
 * single turn reproducible when the workflow is re-run.
 */
function chooseBotMove(board, moves, seed) {
  const moveList = legalMoves(board);
  if (moveList.length === 0) return -1;
  if (env.difficulty !== "casual") return bestMove(board, BOT);

  const noise = Math.abs(Math.sin((seed + moves) * 12.9898) * 43758.5453) % 1;
  if (noise < 0.25) return moveList[Math.floor(noise * 4 * moveList.length) % moveList.length];
  return bestMove(board, BOT);
}

/* -------------------------------------------------------------- commands */

function parseCommand(title) {
  const normalized = title.trim().toLowerCase().replace(/\s+/g, " ");
  const move = normalized.match(/^game\/ttt:\s*move\s*([1-9])$/);
  if (move) return { kind: "move", cell: Number(move[1]) - 1 };
  if (/^game\/ttt:\s*reset$/.test(normalized)) return { kind: "reset" };
  return { kind: "unknown" };
}

/* ------------------------------------------------------------ rendering */

const issueUrl = (title, body) =>
  `https://github.com/${env.repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;

const moveUrl = (cell) =>
  issueUrl(
    `game/ttt: move ${cell + 1}`,
    "Submit this issue to play the move. The bot replies, updates the board in the README, then closes the issue.",
  );

const resetUrl = () => issueUrl("game/ttt: reset", "Submit this issue to start a new board.");

/* `&` is legal in an href but ambiguous in raw HTML, so encode it explicitly. */
const attr = (url) => url.replace(/&/g, "&amp;");

function renderBoard(state) {
  const rows = [];
  for (let r = 0; r < 3; r += 1) {
    const cells = [];
    for (let c = 0; c < 3; c += 1) {
      const i = r * 3 + c;
      const mark = state.board[i];
      const playable = mark === EMPTY && state.status === "active";
      const inWin = state.winningLine?.includes(i);

      if (playable) {
        cells.push(`<td align="center" width="76" height="60"><a href="${attr(moveUrl(i))}"><code>${i + 1}</code></a></td>`);
      } else if (mark === EMPTY) {
        cells.push(`<td align="center" width="76" height="60"><code>&#183;</code></td>`);
      } else {
        const label = inWin ? `<b><ins>${mark}</ins></b>` : `<b>${mark}</b>`;
        cells.push(`<td align="center" width="76" height="60">${label}</td>`);
      }
    }
    rows.push(`    <tr>\n      ${cells.join("\n      ")}\n    </tr>`);
  }
  return `  <table>\n${rows.join("\n")}\n  </table>`;
}

function statusLine(state) {
  if (state.status === "won") return "Bot wins. Click <b>New board</b> for a rematch.";
  if (state.status === "lost") return "You win. That means the bot is running in <code>casual</code> mode.";
  if (state.status === "draw") return "Draw. Perfect play from both sides ends here.";
  return "Your turn — you are <b>X</b>, the bot answers as <b>O</b>. Click a number to submit your move.";
}

function renderBlock(state) {
  const { human, bot, draw } = state.score;
  return [
    BLOCK_START,
    "<div align=\"center\">",
    "",
    renderBoard(state),
    "",
    `<sub>${statusLine(state)}</sub>`,
    "",
    `<sub>Wins ${human} &#183; Losses ${bot} &#183; Draws ${draw} &#183; Moves ${state.moves} &#183; <a href="${attr(resetUrl())}">New board</a></sub>`,
    "",
    "</div>",
    BLOCK_END,
  ].join("\n");
}

async function writeReadme(state) {
  let readme;
  try {
    readme = await readFile(README_PATH, "utf8");
  } catch {
    console.log("README.md not found, skipping board render.");
    return false;
  }

  const start = readme.indexOf(BLOCK_START);
  const end = readme.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) {
    console.log(`Board markers ${BLOCK_START} / ${BLOCK_END} missing, skipping board render.`);
    return false;
  }

  const next = readme.slice(0, start) + renderBlock(state) + readme.slice(end + BLOCK_END.length);
  if (next === readme) return false;

  await writeFile(README_PATH, next, "utf8");
  return true;
}

/* ------------------------------------------------------------- github api */

async function github(pathname, method, body) {
  if (!env.token || !env.issueNumber) return;
  const response = await fetch(`https://api.github.com/repos/${env.repo}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    console.log(`GitHub API ${method} ${pathname} -> ${response.status} ${await response.text()}`);
  }
}

const comment = (markdown) => github(`/issues/${env.issueNumber}/comments`, "POST", { body: markdown });
const closeIssue = (reason) => github(`/issues/${env.issueNumber}`, "PATCH", { state: "closed", state_reason: reason });

async function reject(message) {
  await comment(`${message}\n\nValid commands: \`game/ttt: move 1\` … \`game/ttt: move 9\`, or \`game/ttt: reset\`.`);
  await closeIssue("not_planned");
}

/* ------------------------------------------------------------------- main */

async function main() {
  if (env.issueAuthor.endsWith("[bot]")) {
    console.log("Issue opened by a bot account, ignoring.");
    return;
  }

  const command = parseCommand(env.issueTitle);
  if (command.kind === "unknown") {
    await reject("That command was not recognised, so the board was left untouched.");
    return;
  }

  const state = await loadState();
  const cellLabel = (i) => `**${i + 1}**`;
  let reply;

  if (command.kind === "reset") {
    const fresh = emptyState();
    fresh.score = state.score;
    Object.assign(state, fresh);
    reply = `Board cleared. You are **X** and you move first — pick a cell in the [README](https://github.com/${env.repo}#tic-tac-toe-against-the-bot).`;
  } else {
    if (state.status !== "active") {
      await reject("This board is already finished. Use `game/ttt: reset` to start a new one.");
      return;
    }
    if (state.board[command.cell] !== EMPTY) {
      await reject(`Cell ${command.cell + 1} is already taken.`);
      return;
    }

    state.board[command.cell] = HUMAN;
    state.moves += 1;
    state.lastPlayer = env.issueAuthor;

    let humanWin = winnerOf(state.board);
    if (humanWin) {
      state.status = "lost";
      state.result = HUMAN;
      state.winningLine = humanWin.line;
      state.score.human += 1;
      reply = `You played ${cellLabel(command.cell)} and won. Well played.`;
    } else if (isFull(state.board)) {
      state.status = "draw";
      state.result = "draw";
      state.score.draw += 1;
      reply = `You played ${cellLabel(command.cell)}. Board full — draw.`;
    } else {
      const botCell = chooseBotMove(state.board, state.moves, env.issueNumber);
      state.board[botCell] = BOT;
      state.moves += 1;

      const botWin = winnerOf(state.board);
      if (botWin) {
        state.status = "won";
        state.result = BOT;
        state.winningLine = botWin.line;
        state.score.bot += 1;
        reply = `You played ${cellLabel(command.cell)}, the bot answered ${cellLabel(botCell)} and closed the line.`;
      } else if (isFull(state.board)) {
        state.status = "draw";
        state.result = "draw";
        state.score.draw += 1;
        reply = `You played ${cellLabel(command.cell)}, the bot answered ${cellLabel(botCell)}. Draw.`;
      } else {
        reply = `You played ${cellLabel(command.cell)}, the bot answered ${cellLabel(botCell)}. Your move.`;
      }
    }
  }

  state.turn = HUMAN;
  await saveState(state);
  const rendered = await writeReadme(state);

  await comment(
    `${reply}\n\n${rendered ? "The board in the README has been updated." : "State saved, but the README board block was not found."}`,
  );
  await closeIssue("completed");
}

/* Only auto-run when executed as a script, so the pure logic stays testable. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { LINES, emptyState, winnerOf, isFull, legalMoves, bestMove, chooseBotMove, parseCommand, renderBlock, main };
