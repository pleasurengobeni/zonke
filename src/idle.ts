// "Are you still there?"
//
// A tab left open is not a player. Without this, someone who wanders off mid-match keeps
// a session (and, online, an opponent) waiting indefinitely, and every engagement number
// drawn from it is inflated by the time nobody was there.
//
// So: after a stretch with no input, ask - with a visible countdown. Answering keeps the
// session going. Not answering ends it: the visit is closed off in the analytics, any
// online match is left so the other player is freed, and the screen says plainly that the
// session ended and how to start another.
import { record, startNewSession, track } from './analytics';
import { swallowPointerEvents } from './domOverlay';

/** How long without a pointer or a key before we ask. */
const DEFAULT_IDLE_MS = 2 * 60 * 1000;
/** How long the question stays up before the session is called over. */
const DEFAULT_GRACE_MS = 30 * 1000;

const STYLE = `
.idle { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center;
  background: rgba(10,12,15,0.92); padding: 16px; box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #fff; }
.idle .box { width: min(360px, 100%); box-sizing: border-box; background: #1c2025; border: 1px solid #3a424b;
  border-radius: 12px; padding: 24px 20px; text-align: center; }
.idle h2 { margin: 0 0 8px; font-size: 20px; color: #ffd54f; }
.idle p { margin: 0 0 18px; font-size: 14px; color: #aeb4bb; line-height: 1.5; }
.idle .count { font-size: 40px; font-weight: 700; color: #fff; margin-bottom: 14px; font-variant-numeric: tabular-nums; }
.idle button { width: 100%; font: inherit; font-size: 16px; font-weight: 700; border: 0; border-radius: 9px;
  padding: 13px; background: #ffd54f; color: #14161a; cursor: pointer; }
.idle button.ghost { background: #2c333a; color: #dfe3e8; margin-top: 8px; }
`;

export interface IdleOptions {
  idleMs?: number;
  graceMs?: number;
  /** Called when the session is declared over - used to leave an online match. */
  onExpire?: () => void;
  /** Called when the player says they are still there. */
  onResume?: () => void;
}

export class IdleWatcher {
  private readonly idleMs: number;
  private readonly graceMs: number;
  private lastActivity = Date.now();
  private prompt: HTMLElement | null = null;
  private countdownTimer: number | null = null;
  private checkTimer: number | null = null;
  private expired = false;

  constructor(private readonly options: IdleOptions = {}) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;

    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    const touch = (): void => this.noteActivity();
    ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'].forEach((type) =>
      window.addEventListener(type, touch, { passive: true })
    );
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.noteActivity();
    });

    this.checkTimer = window.setInterval(() => this.check(), 5000);
  }

  private noteActivity(): void {
    // Activity while the question is up does NOT answer it: the player has to say so.
    // A stray pointermove from a sleeping laptop is not somebody being there.
    if (this.prompt || this.expired) return;
    this.lastActivity = Date.now();
  }

  private check(): void {
    if (this.prompt || this.expired) return;
    if (Date.now() - this.lastActivity < this.idleMs) return;
    this.ask();
  }

  private ask(): void {
    const overlay = document.createElement('div');
    overlay.className = 'idle';
    const box = document.createElement('div');
    box.className = 'box';

    const heading = document.createElement('h2');
    heading.textContent = 'Are you still there?';
    const text = document.createElement('p');
    text.textContent = 'The session will end if nobody answers.';
    const count = document.createElement('div');
    count.className = 'count';
    const stay = document.createElement('button');
    stay.textContent = "I'm here";

    let left = Math.ceil(this.graceMs / 1000);
    count.textContent = `${left}`;
    stay.addEventListener('click', () => this.resume());

    box.append(heading, text, count, stay);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    swallowPointerEvents(overlay);
    this.prompt = overlay;
    record('idle_prompt_shown', { afterMs: this.idleMs });

    this.countdownTimer = window.setInterval(() => {
      left -= 1;
      count.textContent = `${Math.max(0, left)}`;
      if (left <= 0) this.expire();
    }, 1000);
  }

  private clearPrompt(): void {
    if (this.countdownTimer !== null) window.clearInterval(this.countdownTimer);
    this.countdownTimer = null;
    this.prompt?.remove();
    this.prompt = null;
  }

  private resume(): void {
    this.clearPrompt();
    this.lastActivity = Date.now();
    record('idle_resumed');
    this.options.onResume?.();
  }

  /** The visit is over: closed off in the analytics, and anyone waiting on them is freed. */
  private expire(): void {
    this.clearPrompt();
    this.expired = true;
    track('session_expired', { idleMs: this.idleMs, graceMs: this.graceMs });
    this.options.onExpire?.();

    const overlay = document.createElement('div');
    overlay.className = 'idle';
    const box = document.createElement('div');
    box.className = 'box';
    const heading = document.createElement('h2');
    heading.textContent = 'Session ended';
    const text = document.createElement('p');
    text.textContent = 'You were away for a while, so we stopped the clock.';
    const again = document.createElement('button');
    again.textContent = 'Start a new session';
    again.addEventListener('click', () => {
      overlay.remove();
      this.expired = false;
      this.lastActivity = Date.now();
      // A genuinely new visit, so the next one is measured from here rather than being
      // glued onto the time the player spent away.
      startNewSession();
      track('session_resumed');
      this.options.onResume?.();
    });
    box.append(heading, text, again);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    swallowPointerEvents(overlay);
  }

  /** For the browser-driven checks: how long is left, and is the question up. */
  get state(): { prompted: boolean; expired: boolean } {
    return { prompted: Boolean(this.prompt), expired: this.expired };
  }

  stop(): void {
    if (this.checkTimer !== null) window.clearInterval(this.checkTimer);
    this.clearPrompt();
  }
}
