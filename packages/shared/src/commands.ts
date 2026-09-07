import { badRequest } from './errors.js';

/**
 * Turning a stored command string into `spawn(file, args)`.
 *
 * `install_command` is one string ("npm run build --if-present") because that
 * is how a human writes it, but it must reach `spawn` as a file plus an
 * argument array with `shell: false` — CLAUDE.md §8 forbids handing user input
 * to a shell. So we tokenise it ourselves.
 *
 * The tokeniser is deliberately *not* a shell: it understands whitespace and
 * quoting and nothing else. No expansion, no substitution, no globbing, no
 * operators. `commandSchema` already rejects every shell metacharacter at write
 * time, so anything that survives to here is a plain argv.
 */

/** A parsed command, ready for `spawn(file, args, { shell: false })`. */
export type ParsedCommand = {
  file: string;
  args: string[];
  /** The tokens joined back together — what we echo into the build log. */
  display: string;
};

/** Enough for any real build command; a longer one is a mistake or an attack. */
export const MAX_COMMAND_TOKENS = 64;

/**
 * Splits a command into argv.
 *
 * Quotes group a token (`node -e "a b"`), and a quote can only open at a token
 * boundary — `a"b"` is rejected rather than silently concatenated, because
 * accepting it would mean guessing at shell semantics we do not implement.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < command.length) {
    // Skip the run of whitespace between tokens.
    while (index < command.length && /\s/.test(command[index] as string)) index += 1;
    if (index >= command.length) break;

    const opener = command[index];
    if (opener === '"' || opener === "'") {
      const close = command.indexOf(opener, index + 1);
      if (close === -1) {
        throw badRequest('COMMAND_UNTERMINATED_QUOTE', `Unterminated ${opener} in "${command}"`);
      }
      tokens.push(command.slice(index + 1, close));
      index = close + 1;
      // A quoted token must end at a boundary: `"a"b` is ambiguous, so refuse.
      if (index < command.length && !/\s/.test(command[index] as string)) {
        throw badRequest(
          'COMMAND_BAD_QUOTE',
          `Quoted argument must be followed by a space in "${command}"`,
        );
      }
      continue;
    }

    let end = index;
    while (end < command.length && !/\s/.test(command[end] as string)) {
      const char = command[end] as string;
      if (char === '"' || char === "'") {
        throw badRequest(
          'COMMAND_BAD_QUOTE',
          `Quotes may only open an argument in "${command}"`,
        );
      }
      end += 1;
    }
    tokens.push(command.slice(index, end));
    index = end;
  }

  return tokens;
}

export function parseCommand(command: string): ParsedCommand {
  const tokens = tokenizeCommand(command);
  const [file, ...args] = tokens;
  if (file === undefined || file.length === 0) {
    throw badRequest('COMMAND_EMPTY', 'A command must name a program to run');
  }
  if (tokens.length > MAX_COMMAND_TOKENS) {
    throw badRequest('COMMAND_TOO_LONG', `A command may have at most ${MAX_COMMAND_TOKENS} tokens`);
  }
  // The program itself is looked up on PATH by `spawn`, so it must be a bare
  // name or a path — never something that only a shell could resolve.
  if (file.startsWith('-')) {
    throw badRequest('COMMAND_BAD_PROGRAM', `"${file}" is an option, not a program`);
  }
  return { file, args, display: tokens.join(' ') };
}

/** True when a command string parses to a runnable argv — used by validation. */
export function isRunnableCommand(command: string): boolean {
  try {
    parseCommand(command);
    return true;
  } catch {
    return false;
  }
}
