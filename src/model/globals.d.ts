// The model runs anywhere modern JavaScript runs (browsers, Node 17+, workers)
// and type-checks without the DOM or Node libraries, so the one host global it
// uses is declared here.
declare function structuredClone<T>(value: T): T
