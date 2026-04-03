/**
 * Lightweight touch gesture detector for mobile interactions.
 * Tracks swipe-left, swipe-right, and pull-down gestures on a target element.
 */

export type GestureCallbacks = {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onPullDown?: () => void;
};

export type GestureOptions = {
  /** Minimum horizontal distance in px to qualify as a swipe (default 50). */
  minDistance?: number;
  /** Minimum velocity in px/ms to qualify as a swipe (default 0.3). */
  minVelocity?: number;
};

const INTERACTIVE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"]);

export class GestureDetector {
  private target: HTMLElement;
  private callbacks: GestureCallbacks;
  private minDistance: number;
  private minVelocity: number;

  private startX = 0;
  private startY = 0;
  private startTime = 0;
  private tracking = false;

  constructor(target: HTMLElement, callbacks: GestureCallbacks, options?: GestureOptions) {
    this.target = target;
    this.callbacks = callbacks;
    this.minDistance = options?.minDistance ?? 50;
    this.minVelocity = options?.minVelocity ?? 0.3;
  }

  attach(): void {
    this.target.addEventListener("touchstart", this.onTouchStart, { passive: true });
    this.target.addEventListener("touchmove", this.onTouchMove, { passive: false });
    this.target.addEventListener("touchend", this.onTouchEnd, { passive: true });
  }

  detach(): void {
    this.target.removeEventListener("touchstart", this.onTouchStart);
    this.target.removeEventListener("touchmove", this.onTouchMove);
    this.target.removeEventListener("touchend", this.onTouchEnd);
    this.tracking = false;
  }

  private onTouchStart = (e: TouchEvent): void => {
    const touch = e.touches[0];
    if (!touch) return;

    // Ignore gestures originating from interactive elements
    const origin = e.target as HTMLElement | null;
    if (origin && INTERACTIVE_TAGS.has(origin.tagName)) return;

    // Ignore touches near screen edges to avoid conflicting with iOS back gesture
    if (touch.clientX < 20 || touch.clientX > window.innerWidth - 20) return;

    this.startX = touch.clientX;
    this.startY = touch.clientY;
    this.startTime = Date.now();
    this.tracking = true;
  };

  private onTouchMove = (e: TouchEvent): void => {
    if (!this.tracking) return;
    const touch = e.touches[0];
    if (!touch) return;

    const dx = touch.clientX - this.startX;
    const dy = touch.clientY - this.startY;

    // If horizontal movement dominates, prevent vertical scroll to avoid jank
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
      e.preventDefault();
    }
  };

  private onTouchEnd = (e: TouchEvent): void => {
    if (!this.tracking) return;
    this.tracking = false;

    const touch = e.changedTouches[0];
    if (!touch) return;

    const dx = touch.clientX - this.startX;
    const dy = touch.clientY - this.startY;
    const elapsed = Date.now() - this.startTime;
    if (elapsed === 0) return;

    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const velocity = absDx / elapsed;

    // Horizontal swipe: must be primarily horizontal and meet thresholds
    if (absDx > absDy && absDx >= this.minDistance && velocity >= this.minVelocity) {
      if (dx > 0) {
        this.callbacks.onSwipeRight?.();
      } else {
        this.callbacks.onSwipeLeft?.();
      }
      return;
    }

    // Pull-down: must be primarily vertical downward and meet distance threshold
    if (dy > 0 && absDy > absDx && absDy >= this.minDistance) {
      this.callbacks.onPullDown?.();
    }
  };
}
