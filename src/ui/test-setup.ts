// Browser APIs jsdom lacks and the editor (or the diagram library) touches.
// Loaded for every test file; a no-op where there is no window.
if (typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>
  if (!w.ResizeObserver) {
    w.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  if (!w.DOMMatrixReadOnly) {
    w.DOMMatrixReadOnly = class {
      m22 = 1
      constructor(transform?: string) {
        const scale = transform?.match(/scale\(([1-9.])\)/)?.[1]
        this.m22 = scale !== undefined ? +scale : 1
      }
    }
  }
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
  if (!window.requestAnimationFrame) window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0)) as unknown as typeof window.requestAnimationFrame
}
