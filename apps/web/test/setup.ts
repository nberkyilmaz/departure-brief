/*
 * The test browser has no WebGL, and says so loudly each time the map
 * library asks for a context. A browser without WebGL answers with nothing,
 * quietly; this one now does the same, and the map falls back to its words
 * as it would there.
 */
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
