import { PgTty } from "./tty";
import { PgShellHistory } from "./shell-history";
import {
  ActiveCharPrompt,
  ActivePrompt,
  closestLeftBoundary,
  closestRightBoundary,
  collectAutocompleteCandidates,
  hasTrailingWhitespace,
  isIncompleteInput,
} from "./shell-utils";
import { PgTerminal } from "./terminal";
import { PgWallet } from "../wallet";
import { PgCommand } from "./commands";
import { PgPkg, PkgName } from "./pkg";
import { PgCommon } from "../common";
import { TerminalAction } from "../../../state";
import { Lang } from "../explorer";
import { EventName } from "../../../constants";

type AutoCompleteHandler = (index: number, tokens: string[]) => string[];
type ShellOptions = { historySize: number; maxAutocompleteEntries: number };

/**
 * A shell is the primary interface that is used to start other programs.
 * It's purpose to handle:
 * - Job control (control of child processes),
 * - Line editing and history
 * - Output text to the tty -> terminal
 * - Interpret text within the tty to launch processes and interpret programs
 */
export class PgShell {
  private _pgTty: PgTty;
  private _history: PgShellHistory;
  private _active: boolean;
  private _waitingForInput: boolean;
  private _processCount: number;
  private _maxAutocompleteEntries: number;
  private _autocompleteHandlers: AutoCompleteHandler[];
  private _loadedPkgs: { [pkgName: string]: boolean };
  private _activePrompt?: ActivePrompt;
  private _activeCharPrompt?: ActiveCharPrompt;

  constructor(
    pgTty: PgTty,
    options: ShellOptions = {
      historySize: 30,
      maxAutocompleteEntries: 100,
    }
  ) {
    this._pgTty = pgTty;
    this._history = new PgShellHistory(options.historySize);

    this._maxAutocompleteEntries = options.maxAutocompleteEntries;
    this._autocompleteHandlers = [
      (index, tokens) => {
        return this._history.getEntries();
      },
    ];
    this._active = false;
    this._waitingForInput = false;
    this._processCount = 0;
    this._loadedPkgs = {};
  }

  /**
   * @returns terminal history
   */
  getHistory() {
    return this._history;
  }

  /**
   * Disable shell
   */
  disable() {
    this._incrementProcessCount();
    this._active = false;
  }

  /**
   * Enable shell:
   *
   * - Prompt
   * - Enable history
   */
  enable() {
    setTimeout(() => {
      this._decrementProcessCount();
      if (!this._processCount) {
        this._active = true;
        this.prompt();
        this._pgTty.read(""); // Enables history
      }
    }, 10);
  }

  /**
   * Prompt terminal
   *
   * This function also helps with command history
   */
  async prompt() {
    // If we are already prompting, do nothing
    if (this._activePrompt && this._pgTty.getInputStartsWithPrompt()) {
      return;
    }

    try {
      const promptText = this._waitingForInput
        ? PgTerminal.WAITING_INPUT_PROMPT_PREFIX
        : PgTerminal.PROMPT_PREFIX;
      this._activePrompt = this._pgTty.read(promptText);
      this._active = true;

      if (this._history) {
        await this._activePrompt.promise;
        const input = this._pgTty.getInput().trim();
        this._history.push(input);
      }
    } catch (e: any) {
      this._pgTty.println(e.message);
      this.prompt();
    }
  }

  isPrompting() {
    return this._active;
  }

  /**
   * This function completes the current input, calls the given callback
   * and then re-displays the prompt.
   */
  printAndRestartPrompt(callback: () => Promise<any> | undefined) {
    // Complete input
    this._pgTty.setCursor(this._pgTty.getInput().length);
    this._pgTty.print("\r\n");

    // Prepare a function that will resume prompt
    const resume = () => {
      this._pgTty.setCursor(this._pgTty.getCursor());
      this._pgTty.setInput(this._pgTty.getInput());
    };

    // Call the given callback to echo something, and if there is a promise
    // returned, wait for the resolution before resuming prompt.
    const ret = callback();
    if (ret) {
      ret.then(resume);
    } else {
      resume();
    }
  }

  /**
   * @param clearCmd whether to clean the current line before parsing the command
   *
   * Handle input completion
   */
  handleReadComplete = (clearCmd?: boolean) => {
    const input = this._pgTty.getInput();
    if (this._activePrompt && this._activePrompt.resolve) {
      this._activePrompt.resolve(input);
      this._activePrompt = undefined;
    }

    if (clearCmd) this._pgTty.clearLine();
    else this._pgTty.print("\r\n");

    this._active = false;

    if (this._waitingForInput) {
      PgCommon.createAndDispatchCustomEvent(EventName.TERMINAL_WAIT_FOR_INPUT);
    } else {
      this._parseCommand(input);
    }
  };

  /**
   * Handle terminal -> tty input
   */
  handleTermData = (data: string) => {
    // Only Allow CTRL+C through
    if (!this._active && data !== "\x03") {
      return;
    }

    if (this._pgTty.getFirstInit() && this._activePrompt) {
      const line = this._pgTty
        .getBuffer()
        .getLine(
          this._pgTty.getBuffer().cursorY + this._pgTty.getBuffer().baseY
        );
      if (!line) return;

      const promptRead = line.translateToString(
        false,
        0,
        this._pgTty.getBuffer().cursorX
      );
      this._activePrompt.promptPrefix = promptRead;
      this._pgTty.setPromptPrefix(promptRead);
      this._pgTty.setFirstInit(false);
    }

    // If we have an active character prompt, satisfy it in priority
    if (this._activeCharPrompt && this._activeCharPrompt.resolve) {
      this._activeCharPrompt.resolve(data);
      this._activeCharPrompt = undefined;
      this._pgTty.print("\r\n");
      return;
    }

    // If this looks like a pasted input, expand it
    if (data.length > 3 && data.charCodeAt(0) !== 0x1b) {
      const normData = data.replace(/[\r\n]+/g, "\r");
      Array.from(normData).forEach((c) => this._handleData(c));
    } else {
      this._handleData(data);
    }
  };

  /**
   * Wait for user input
   *
   * @param msg Message to print to the terminal before prompting user
   * @returns user input
   */
  async waitForUserInput(msg: string): Promise<string> {
    return new Promise((res, rej) => {
      if (this._waitingForInput) rej("Already waiting for input.");
      else {
        this._waitingForInput = true;
        this._pgTty.clearLine();
        this._pgTty.println(
          PgTerminal.secondary(PgTerminal.WAITING_INPUT_MSG_PREFIX) + msg
        );
        this.enable();

        // This will happen once user submits the input
        const handleInput = () => {
          this._waitingForInput = false;
          document.removeEventListener(
            EventName.TERMINAL_WAIT_FOR_INPUT,
            handleInput
          );
          const input = this._pgTty.getInput();
          res(input);
        };

        document.addEventListener(
          EventName.TERMINAL_WAIT_FOR_INPUT,
          handleInput
        );
      }
    });
  }

  /**
   * Move cursor at given direction
   */
  private _handleCursorMove = (dir: number) => {
    if (dir > 0) {
      const num = Math.min(
        dir,
        this._pgTty.getInput().length - this._pgTty.getCursor()
      );
      this._pgTty.setCursorDirectly(this._pgTty.getCursor() + num);
    } else if (dir < 0) {
      const num = Math.max(dir, -this._pgTty.getCursor());
      this._pgTty.setCursorDirectly(this._pgTty.getCursor() + num);
    }
  };

  /**
   * Insert character at cursor location
   */
  private _handleCursorInsert = (data: string) => {
    const newInput =
      this._pgTty.getInput().substring(0, this._pgTty.getCursor()) +
      data +
      this._pgTty.getInput().substring(this._pgTty.getCursor());
    this._pgTty.setCursorDirectly(this._pgTty.getCursor() + data.length);
    this._pgTty.setInput(newInput);
  };

  /**
   * Erase a character at cursor location
   */
  private _handleCursorErase = (backspace: boolean) => {
    if (backspace) {
      if (this._pgTty.getCursor() <= 0) return;
      const newInput =
        this._pgTty.getInput().substring(0, this._pgTty.getCursor() - 1) +
        this._pgTty.getInput().substring(this._pgTty.getCursor());
      this._pgTty.clearInput();
      this._pgTty.setCursorDirectly(this._pgTty.getCursor() - 1);
      this._pgTty.setInput(newInput, true);
    } else {
      const newInput =
        this._pgTty.getInput().substring(0, this._pgTty.getCursor()) +
        this._pgTty.getInput().substring(this._pgTty.getCursor() + 1);
      this._pgTty.setInput(newInput);
    }
  };

  /**
   * Handle a single piece of information from the terminal -> tty.
   */
  private _handleData = (data: string) => {
    // Only Allow CTRL+C Through
    if (!this._active && data !== "\x03") {
      return;
    }

    const ord = data.charCodeAt(0);
    let ofs;

    // Handle ANSI escape sequences
    if (ord === 0x1b) {
      switch (data.substring(1)) {
        case "[A": // Up arrow
          if (this._history) {
            let value = this._history.getPrevious();
            if (value) {
              this._pgTty.setInput(value);
              this._pgTty.setCursor(value.length);
            }
          }
          break;

        case "[B": // Down arrow
          if (this._history) {
            let value = this._history.getNext();
            if (!value) value = "";
            this._pgTty.setInput(value);
            this._pgTty.setCursor(value.length);
          }
          break;

        case "[D": // Left Arrow
          this._handleCursorMove(-1);
          break;

        case "[C": // Right Arrow
          this._handleCursorMove(1);
          break;

        case "[3~": // Delete
          this._handleCursorErase(false);
          break;

        case "[F": // End
          this._pgTty.setCursor(this._pgTty.getInput().length);
          break;

        case "[H": // Home
          this._pgTty.setCursor(0);
          break;

        case "b": // ALT + LEFT
          ofs = closestLeftBoundary(
            this._pgTty.getInput(),
            this._pgTty.getCursor()
          );
          if (ofs) this._pgTty.setCursor(ofs);
          break;

        case "f": // ALT + RIGHT
          ofs = closestRightBoundary(
            this._pgTty.getInput(),
            this._pgTty.getCursor()
          );
          if (ofs) this._pgTty.setCursor(ofs);
          break;

        case "\x7F": // CTRL + BACKSPACE
          ofs = closestLeftBoundary(
            this._pgTty.getInput(),
            this._pgTty.getCursor()
          );
          if (ofs) {
            this._pgTty.setInput(
              this._pgTty.getInput().substring(0, ofs) +
                this._pgTty.getInput().substring(this._pgTty.getCursor())
            );
            this._pgTty.setCursor(ofs);
          }
          break;
      }
    }
    // Handle special characters
    else if (ord < 32 || ord === 0x7f) {
      switch (data) {
        case "\r": // ENTER
          if (isIncompleteInput(this._pgTty.getInput())) {
            this._handleCursorInsert("\n");
          } else {
            this.handleReadComplete();
          }
          break;

        case "\x7F": // BACKSPACE
        case "\x08": // CTRL+H
        case "\x04": // CTRL+D
          this._handleCursorErase(true);
          break;

        case "\t": // TAB
          if (this._autocompleteHandlers.length > 0) {
            const inputFragment = this._pgTty
              .getInput()
              .substring(0, this._pgTty.getCursor());
            const hasTrailingSpace = hasTrailingWhitespace(inputFragment);
            const candidates = collectAutocompleteCandidates(
              this._autocompleteHandlers,
              inputFragment
            );

            // Sort candidates
            candidates.sort();

            // Depending on the number of candidates, we are handing them in
            // a different way.
            if (candidates.length === 0) {
              // No candidates? Just add a space if there is none already
              if (!hasTrailingSpace) {
                this._handleCursorInsert(" ");
              }
            } else if (candidates.length === 1) {
              // Set the input
              this._pgTty.setInput(candidates[0]);

              // Move the cursor to the end
              this._pgTty.setCursor(candidates[0].length);
            } else if (candidates.length <= this._maxAutocompleteEntries) {
              // If we are less than maximum auto-complete candidates, print
              // them to the user and re-start prompt
              this.printAndRestartPrompt(() => {
                this._pgTty.printWide(candidates);
                return undefined;
              });
            } else {
              // If we have more than maximum auto-complete candidates, print
              // them only if the user acknowledges a warning
              this.printAndRestartPrompt(() =>
                this._pgTty
                  .readChar(
                    `Display all ${candidates.length} possibilities? (y or n)`
                  )
                  .promise.then((yn: string) => {
                    if (yn === "y" || yn === "Y") {
                      this._pgTty.printWide(candidates);
                    }
                  })
              );
            }
          } else {
            this._handleCursorInsert("    ");
          }
          break;

        case "\x01": // CTRL+A
          this._pgTty.setCursor(0);
          break;

        case "\x02": // CTRL+B
          this._handleCursorMove(-1);
          break;

        // TODO: implement stopping commands
        // case "\x03": // CTRL+C

        case "\x05": // CTRL+E
          this._pgTty.setCursor(this._pgTty.getInput().length);
          break;

        case "\x06": // CTRL+F
          this._handleCursorMove(1);
          break;

        case "\x07": // CTRL+G
          if (this._history) this._history.getPrevious();
          this._pgTty.setInput("");
          break;

        case "\x0b": // CTRL+K
          this._pgTty.setInput(
            this._pgTty.getInput().substring(0, this._pgTty.getCursor())
          );
          this._pgTty.setCursor(this._pgTty.getInput().length);
          break;

        case "\x0e": // CTRL+N
          if (this._history) {
            let value = this._history.getNext();
            if (!value) value = "";
            this._pgTty.setInput(value);
            this._pgTty.setCursor(value.length);
          }
          break;

        case "\x10": // CTRL+P
          if (this._history) {
            let value = this._history.getPrevious();
            if (value) {
              this._pgTty.setInput(value);
              this._pgTty.setCursor(value.length);
            }
          }
          break;

        case "\x15": // CTRL+U
          this._pgTty.setInput(
            this._pgTty.getInput().substring(this._pgTty.getCursor())
          );
          this._pgTty.setCursor(0);
          break;
      }

      // Handle visible characters
    } else {
      this._handleCursorInsert(data);
    }
  };

  /**
   * Increments active process count
   */
  private _incrementProcessCount() {
    this._processCount++;
  }

  /**
   * Decrements active process count if process count is gt 0
   */
  private _decrementProcessCount() {
    if (this._processCount) {
      this._processCount--;
    }
  }

  // TODO: Move this to `PgCommands` and keep state for cmd and pkg management
  /**
   * Runs after pressesing `Enter` in terminal
   */
  private _parseCommand(cmd: string) {
    // This guarantees command only start with the specified command name
    // solana-keygen would not count for cmdName === "solana"
    const cmdName = cmd.trim().split(" ")?.at(0);

    switch (cmdName) {
      case PgCommand.BUILD: {
        PgTerminal.setTerminalState(TerminalAction.buildStart);
        return;
      }

      case PgCommand.CLEAR: {
        // Move first line to the top(doesn't remove all xterm buffer)
        this._pgTty.clearTty();
        // Clear all
        this._pgTty.clear();
        this.prompt();
        return;
      }

      case PgCommand.CONNECT: {
        PgTerminal.setTerminalState(TerminalAction.walletConnectOrSetupStart);
        return;
      }

      case PgCommand.DEPLOY: {
        if (PgWallet.checkIsPgConnected()) {
          PgTerminal.setTerminalState(TerminalAction.deployStart);
        }
        return;
      }

      case PgCommand.HELP: {
        PgTerminal.logWasm(PgCommand.help());
        this.enable();
        return;
      }

      case PgCommand.PRETTIER: {
        PgCommon.createAndDispatchCustomEvent(EventName.EDITOR_FORMAT, {
          lang: Lang.TYPESCRIPT,
          fromTerminal: true,
        });
        return;
      }

      // Special command
      case PgCommand.RUN_LAST_CMD: {
        // Run the last command
        const entries = this._history.getEntries();
        if (!entries.length) {
          this._pgTty.println("No previous command.");
          this.enable();
        } else {
          const lastCmd = entries[entries.length - 1];
          this._parseCommand(lastCmd);
        }

        return;
      }

      case PgCommand.RUN:
      case PgCommand.TEST: {
        const regex = new RegExp(/^\w+\s?(.*)/);
        const match = regex.exec(cmd);
        PgCommon.createAndDispatchCustomEvent(EventName.CLIENT_RUN, {
          isTest: cmd.startsWith(PgCommand.TEST),
          path: match && match[1],
        });

        return;
      }

      case PgCommand.RUSTFMT: {
        PgCommon.createAndDispatchCustomEvent(EventName.EDITOR_FORMAT, {
          lang: Lang.RUST,
          fromTerminal: true,
        });
        return;
      }

      case PgCommand.SOLANA: {
        if (PgWallet.checkIsPgConnected()) {
          (async () => {
            const initial = !this._loadedPkgs[PkgName.SOLANA_CLI];
            if (initial) {
              this._loadedPkgs[PkgName.SOLANA_CLI] = true;
            }
            const { runSolana } = await PgPkg.loadPkg(PgPkg.SOLANA_CLI, {
              log: initial,
            });

            runSolana!(cmd, ...PgCommand.getCmdArgs(PkgName.SOLANA_CLI)!);
          })();
        }

        return;
      }

      case PgCommand.SPL_TOKEN: {
        if (PgWallet.checkIsPgConnected()) {
          (async () => {
            const initial = !this._loadedPkgs[PkgName.SPL_TOKEN_CLI];
            if (initial) {
              this._loadedPkgs[PkgName.SPL_TOKEN_CLI] = true;
            }
            const { runSplToken } = await PgPkg.loadPkg(PgPkg.SPL_TOKEN_CLI, {
              log: initial,
            });

            runSplToken!(cmd, ...PgCommand.getCmdArgs(PkgName.SPL_TOKEN_CLI)!);
          })();
        }

        return;
      }

      case PgCommand.SUGAR: {
        PgTerminal.runCmd(async () => {
          if (PgWallet.checkIsPgConnected()) {
            const initial = !this._loadedPkgs[PkgName.SUGAR_CLI];
            if (initial) {
              this._loadedPkgs[PkgName.SUGAR_CLI] = true;
            }
            const { runSugar } = await PgPkg.loadPkg(PgPkg.SUGAR_CLI, {
              log: initial,
            });

            await runSugar!(cmd);
          }
        });

        return;
      }
    }

    // Only new prompt after invalid command, other commands will automatically
    // generate new prompt
    if (cmdName) {
      this._pgTty.println(`Command '${PgTerminal.italic(cmd)}' not found.\n`);
    }

    this.enable();
  }
}
