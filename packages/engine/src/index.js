/**
 * @wax/engine — pure, deterministic alert rule matching and evaluation.
 *
 * No I/O here. The polling loop and delivery providers live outside this
 * package; this is the part that must be exactly right, so it is exactly
 * testable.
 */

export * from './types.js';
export {
  matchPriceDrop,
  matchNewPressing,
  matchRestock,
  matchMerch,
  byPriority,
} from './matchers.js';
export { evaluate, blankMemory, MAX_DISPATCHES_PER_DAY } from './evaluate.js';
export {
  ChannelAdapter,
  RecordingAdapter,
  ConsoleAdapter,
  dispatch,
  FixtureSource,
} from './adapters.js';
export {
  makeListing,
  makePressing,
  makeMerchItem,
  makeSnapshot,
  makeRule,
} from './fixtures.js';
