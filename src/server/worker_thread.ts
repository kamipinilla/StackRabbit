console.time("loading");
import * as process from "process";
import { getBestMove, getSortedMoveList } from "./main";
const cModule = require("../../../build/Release/cRabbit");

console.timeEnd("loading");
process.send({ type: "ready" }); // Let the main process know that it's loaded the ranks file

/**
 * Compute adjustment for the given piece
 */
function performComputation(args): PossibilityChain {
  console.time(args.piece);
  const result: PossibilityChain = getBestMove(
    args.newSearchState,
    /* shouldLog= */ false,
    args.initialAiParams,
    args.paramMods,
    args.inputFrameTimeline,
    /* searchDepth= */ 2,
    /* hypotheticalSearchDepth= */ 1
  );
  console.timeEnd(args.piece);
  return result;
}

/**
 * Compute adjustment for the given piece
 */
function performComputationFinesseCpp(args: WorkerDataArgs): Object {
  console.time(args.piece);

  const boardStr = args.newSearchState.board.map((x) => x.join("")).join("");
  const pieceLookup = ["I", "O", "L", "J", "T", "S", "Z"];
  const curPieceIndex = pieceLookup.indexOf(args.newSearchState.currentPieceId);
  const nextPieceIndex = pieceLookup.indexOf(args.newSearchState.nextPieceId);
  const encodedInputString = `${boardStr}|${args.newSearchState.level}|${args.newSearchState.lines}|${curPieceIndex}|${nextPieceIndex}|${args.inputFrameTimeline}|`;

  const lockPositionValueLookup = JSON.parse(
    cModule.precompute(encodedInputString)
  );
  console.timeEnd(args.piece);
  return lockPositionValueLookup;
}

/**
 * Compute adjustment for the given piece
 */
function performComputationFinesse(args): Object {
  console.time(args.piece);

  // Query for the possible moves for the previous piece
  const originalPieceSearchState = args.newSearchState;
  const [bestMoves, prunedMoves]: MoveSearchResult = getSortedMoveList(
    originalPieceSearchState,
    /* shouldLog= */ false,
    args.initialAiParams,
    args.paramMods,
    args.inputFrameTimeline,
    /* searchDepth= */ 2,
    /* hypotheticalSearchDepth= */ 1
  );

  // Store the highest value for each lock position
  const lockPositionValueLookup = {};
  for (const possibility of bestMoves) {
    const lockPos = possibility.lockPositionEncoded;
    // Highest value will occur first since list is sorted. So if we've seen it before, we have the best already.
    if (!lockPositionValueLookup.hasOwnProperty(lockPos)) {
      lockPositionValueLookup[lockPos] = possibility.expectedValue;
    }
  }
  // Store values for all the other lock positions from the pruned possibilities
  for (const prunedPossibility of prunedMoves) {
    const lockPos = prunedPossibility.lockPositionEncoded;
    const unsearchedPenalty = 50; // Favor choosing placements where the futures are known
    // Store the highest value for each lock position (will occur first since list is sorted)
    if (
      !lockPositionValueLookup.hasOwnProperty(lockPos) ||
      prunedPossibility.totalValue - unsearchedPenalty >
        lockPositionValueLookup[lockPos]
    ) {
      lockPositionValueLookup[lockPos] =
        prunedPossibility.totalValue - unsearchedPenalty;
    }
  }

  console.timeEnd(args.piece);
  return lockPositionValueLookup;
}

process.on("message", (args: WorkerDataArgs) => {
  const result =
    args.computationType == "finesse"
      ? performComputationFinesse(args)
      : performComputation(args);
  process.send({
    type: args.computationType == "finesse" ? "result-finesse" : "result",
    piece: args.piece,
    result: result,
  });
});
