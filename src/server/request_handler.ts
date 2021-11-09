import { PIECE_LOOKUP } from "../../docs/tetrominoes";
import { getBoardAndLinesClearedAfterPlacement } from "./board_helper";
import { engineLookup } from "./engine_lookup";
import { rateSurface } from "./evaluator";
import { DISABLE_LOGGING, LINE_CAP, SHOULD_LOG } from "./params";
import { PreComputeManager } from "./precompute";
import {
  formatPossibility,
  formatPossibilities,
  getSurfaceArrayAndHoles,
  logBoard,
  parseBoard,
} from "./utils";

const mainApp = require("./main");
const params = require("./params");

export class RequestHandler {
  preComputeManager: PreComputeManager;
  asyncCallInProgress: boolean;
  asyncResult: string;
  partialResult: any;
  partialResultsUsed: number;
  computationsFinished: number;

  constructor(precomputeManager) {
    this.preComputeManager = precomputeManager;
    this.asyncCallInProgress = false;
    this.asyncResult = null;
    this.partialResult = null;
    this.partialResultsUsed = 0;
    this.computationsFinished = 0;

    this.routeRequest = this.routeRequest.bind(this);
    this._wrapAsync = this._wrapAsync.bind(this);
  }

  routeRequest(req): [string, number] {
    const requestArgs = req.url.split("/").slice(1);
    const requestType = requestArgs[0];

    switch (requestType) {
      case "ping":
        return ["pong", 200];

      case "async-result":
        console.log("FAILED:", this.partialResultsUsed);
        // If a previous async request has now completed, send that.
        if (this.asyncResult !== null) {
          return [this.asyncResult, 200];
        } else if (this.partialResult !== null) {
          for (let i = 0; i < 10; i++) {
            console.log(
              "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n"
            );
          }
          this.partialResultsUsed += 1;
          return [this.partialResult, 200];
        } else if (this.asyncCallInProgress) {
          return ["Still calculating", 504]; // Gateway timeout
        } else {
          return ["No previous async request has been made", 404]; // Not found
        }

      case "lookup":
        return [this.handleRankLookup(requestArgs), 200];

      case "engine":
        return [this.handleEngineLookup(requestArgs), 200];

      case "async-nb":
        return this._wrapAsync(() =>
          this.handleRequestSyncWithNextBox(requestArgs, 1)
        );

      case "async-nnb":
        return this._wrapAsync(() =>
          this.handleRequestSyncNoNextBox(requestArgs)
        );

      case "research-nb":
        return [this.handleRequestSyncWithNextBox(requestArgs, 3), 200];

      case "sync-nb":
        return [this.handleRequestSyncWithNextBox(requestArgs, 1), 200];
    
      case "sync-nb-all":
        return [this.handleRequestSyncWithNextBoxAll(requestArgs, 1), 200];

      case "sync-nnb":
        return [this.handleRequestSyncNoNextBox(requestArgs), 200];

      case "sync-nnb-all":
        return [this.handleRequestSyncNoNextBoxAll(requestArgs), 200];

      case "precompute":
        return this._wrapAsync(() => this.handlePrecomputeRequest(requestArgs));

      default:
        return [
          "Please specify the request type, e.g. 'sync-nnb' or 'async-nb'. Received: " +
            requestType,
          200,
        ];
    }
  }

  /**
   * Parses and validates the inputs
   * @returns {Object} an object with all the parsed arguments
   */
  _parseArguments(requestArgs): [SearchState, string] {
    // Parse and validate inputs
    let [
      requestType,
      boardStr,
      currentPieceId,
      nextPieceId,
      level,
      lines,
      existingXOffset,
      existingYOffset,
      existingRotation,
      framesAlreadyElapsed,
      reactionTime,
      inputFrameTimeline,
      canFirstFrameShift,
    ] = requestArgs;
    level = parseInt(level);
    lines = parseInt(lines);
    existingXOffset = parseInt(existingXOffset) || 0;
    existingYOffset = parseInt(existingYOffset) || 0;
    framesAlreadyElapsed = parseInt(framesAlreadyElapsed) || 0;
    reactionTime = parseInt(reactionTime) || 0;
    existingRotation = parseInt(existingRotation) || 0;
    canFirstFrameShift = canFirstFrameShift.toLowerCase() === "true";

    // console.log({
    //   boardStr,
    //   currentPieceId,
    //   nextPieceId,
    //   level,
    //   lines,
    //   existingXOffset,
    //   existingYOffset,
    //   existingRotation,
    //   reactionTime,
    //   framesAlreadyElapsed,
    //   inputFrameTimeline,
    //   canFirstFrameShift,
    // });

    // Validate inputs
    currentPieceId = currentPieceId.toUpperCase();
    nextPieceId = nextPieceId.toUpperCase();
    if (!["I", "O", "L", "J", "T", "S", "Z"].includes(currentPieceId)) {
      throw new Error("Unknown current piece:" + currentPieceId);
    }
    if (!["I", "O", "L", "J", "T", "S", "Z", "NULL"].includes(nextPieceId)) {
      throw new Error("Unknown next piece: '" + nextPieceId + "'");
    }
    if (level < 0) {
      throw new Error("Illegal level: " + level);
    }
    if (lines === undefined || lines < 0) {
      throw new Error("Illegal line count: " + lines);
    }
    if (existingRotation < 0 || existingRotation > 3) {
      throw new Error("Illegal existing rotation: " + existingRotation);
    }
    if (level < 18 || level > 30) {
      console.log("WARNING - Unusual level:", level);
    }
    if (
      requestType !== "engine" &&
      lines < 10 &&
      level !== 18 &&
      level !== 19 &&
      level !== 29
    ) {
      throw new Error(
        `Unsupported starting level: ${level}. Supported starts: 18, 19, 29`
      );
    }
    for (const char of inputFrameTimeline) {
      if (char !== "X" && char !== ".") {
        throw new Error("Invalid input frame timeline: " + inputFrameTimeline);
      }
    }
    if (nextPieceId === "NULL") {
      nextPieceId = null;
    }

    // Decode the board
    const board = parseBoard(boardStr);

    if (!DISABLE_LOGGING) {
      logBoard(
        getBoardAndLinesClearedAfterPlacement(
          board,
          PIECE_LOOKUP[currentPieceId][0][existingRotation],
          existingXOffset + 3,
          existingYOffset + (currentPieceId === "I" ? -2 : -1)
        )[0]
      );
    }

    // Manually top out if past line cap
    if (lines >= LINE_CAP) {
      inputFrameTimeline = "."; // Manually top out
    }

    return [
      {
        board,
        currentPieceId,
        nextPieceId,
        level,
        lines,
        existingXOffset,
        existingYOffset,
        existingRotation,
        reactionTime,
        framesAlreadyElapsed,
        canFirstFrameShift,
      },
      inputFrameTimeline,
    ];
  }

  _wrapAsync(func): [string, number] {
    const execute = async function () {
      // Wait 1ms to ensure that this is called async
      await new Promise((resolve) => setTimeout(resolve, 1));
      const result = func();
      if (result !== undefined) {
        this.asyncResult = result;
        this.asyncCallInProgress = false;
      }
    }.bind(this);

    this.asyncCallInProgress = true;
    this.asyncResult = null;
    this.partialResult = null;
    execute();
    return ["Request accepted.", 200];
  }

  /**
   * Synchronously choose the best placement, with no next box and no search.
   * @returns {string} the API response
   */
  handleRequestSyncNoNextBox(requestArgs) {
    console.time("NoNextBox");
    let [searchState, inputFrameTimeline] = this._parseArguments(requestArgs);

    // Get the best move
    const bestMove = mainApp.getBestMove(
      searchState,
      SHOULD_LOG,
      params.getParams(),
      params.getParamMods(),
      inputFrameTimeline,
      /* searchDepth= */ 1,
      /* hypotheticalSearchDepth= */ 0
    );

    console.timeEnd("NoNextBox");
    if (!bestMove) {
      return "No legal moves";
    }
    return formatPossibility(bestMove);
  }

    handleRequestSyncNoNextBoxAll(requestArgs) {
    console.time("NoNextBox");
    let [searchState, inputFrameTimeline] = this._parseArguments(requestArgs);

    // Get the best move
    const allMoves: PossibilityChain[] = mainApp.getAllMoves(
      searchState,
      SHOULD_LOG,
      params.getParams(),
      params.getParamMods(),
      inputFrameTimeline,
      /* searchDepth= */ 1,
      /* hypotheticalSearchDepth= */ 0
    );

    console.timeEnd("NoNextBox");
    if (!allMoves) {
      return "No legal moves";
    }
    return formatPossibilities(allMoves);
  }

  /**
   * Synchronously choose the best placement, with next piece & 1-depth search.
   * @returns {string} the API response
   */
  handleRequestSyncWithNextBox(requestArgs, hypotheticalSearchDepth) {
    let [searchState, inputFrameTimeline] = this._parseArguments(requestArgs);

    // Get the best move
    const bestMove = mainApp.getBestMove(
      searchState,
      SHOULD_LOG,
      params.getParams(),
      params.getParamMods(),
      inputFrameTimeline,
      /* searchDepth= */ 2,
      hypotheticalSearchDepth
    );

    if (!bestMove) {
      return "No legal moves";
    }
    return formatPossibility(bestMove);
  }

  handleRequestSyncWithNextBoxAll(requestArgs, hypotheticalSearchDepth) {
    let [searchState, inputFrameTimeline] = this._parseArguments(requestArgs);

    // Get the best move
    const allMoves: PossibilityChain[] = mainApp.getAllMoves(
      searchState,
      SHOULD_LOG,
      params.getParams(),
      params.getParamMods(),
      inputFrameTimeline,
      /* searchDepth= */ 2,
      hypotheticalSearchDepth
    );

    if (!allMoves) {
      return "No legal moves";
    }
    return formatPossibilities(allMoves);
  }

  /**
   * Pre-compute both an initial placement and all possible adjustments for the upcoming piece.
   * @returns {string} the API response
   */
  handlePrecomputeRequest(requestArgs) {
    if (!this.preComputeManager) {
      return;
    }
    let [searchState, inputFrameTimeline] = this._parseArguments(requestArgs);

    this.preComputeManager.finessePrecompute(
      searchState,
      SHOULD_LOG,
      params.getParams(),
      params.getParamMods(),
      inputFrameTimeline,
      function (result) {
        this.partialResult = result;
      }.bind(this),
      function (result) {
        this.asyncResult = result;
        this.asyncCallInProgress = false;
      }.bind(this)
    );
  }

  handleRankLookup(requestArgs: Array<string>) {
    const [boardStr] = requestArgs;
    // Decode the board
    const board = boardStr
      .match(/.{1,10}/g) // Select groups of 10 characters
      .map((rowSerialized) => rowSerialized.split("").map((x) => parseInt(x)));
    logBoard(board);
    const surfaceArray = getSurfaceArrayAndHoles(board)[0];
    console.log(surfaceArray);
    return rateSurface(surfaceArray);
  }

  handleEngineLookup(requestArgs: Array<string>) {
    let [searchState, inputFrameTimeline] = this._parseArguments(requestArgs);

    return JSON.stringify(
      engineLookup(
        searchState,
        params.getParams(),
        params.getParamMods(),
        inputFrameTimeline
      )
    );
  }
}
