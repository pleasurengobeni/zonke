// Who is playing, for this browser session.
//
// sessionStorage, not localStorage: "ask once per session" is the actual requirement, so
// the name survives a reload or a scene restart in this tab but a fresh visit asks again.
// It is also per-tab, so two tabs can be two different players.
const NAME_KEY = 'zonke.playerName';
const MAX_NAME = 16;
export const DEFAULT_NAME = 'Player 1';

function readStored(): string | null {
  try {
    const v = sessionStorage.getItem(NAME_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    // Private-mode Safari throws on storage access - the game still has to start.
    return null;
  }
}

function writeStored(name: string): void {
  try {
    sessionStorage.setItem(NAME_KEY, name);
  } catch {
    // Not being able to remember the name is not a reason to fail the game.
  }
}

export function storedPlayerName(): string | null {
  return readStored();
}

export function clearPlayerName(): void {
  try {
    sessionStorage.removeItem(NAME_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Trims, strips control characters, and caps the length of whatever was typed. */
function sanitize(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_NAME);
  return cleaned.length > 0 ? cleaned : DEFAULT_NAME;
}

// A resize while the prompt is open (a phone keyboard opening, for instance) restarts the
// scene, which asks again - so the ask is a singleton: everyone who asks while one prompt
// is open waits on that same prompt rather than stacking a second one over it.
let pending: Promise<string> | null = null;

/**
 * The name, asking for it first if this session hasn't given one yet. Rendered as a DOM
 * overlay rather than inside the canvas: a real <input> gets the platform keyboard,
 * autocorrect and paste for free, none of which a Phaser text object has.
 */
export function ensurePlayerName(): Promise<string> {
  const stored = readStored();
  if (stored) return Promise.resolve(stored);
  if (pending) return pending;

  pending = new Promise<string>((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'name-gate';
    overlay.innerHTML = `
      <div class="ng-card">
        <div class="ng-title">ZONKE</div>
        <div class="ng-sub">What should we call you?</div>
        <input class="ng-input" type="text" maxlength="${MAX_NAME}" autocomplete="nickname"
               autocapitalize="words" spellcheck="false" placeholder="Your name" />
        <button class="ng-btn" type="button">Play</button>
        <div class="ng-hint">Used for your turn, the win screen and the leaderboard.</div>
      </div>`;

    const style = document.createElement('style');
    style.textContent = `
      #name-gate {
        position: fixed;
        inset: 0;
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(20, 20, 20, 0.94);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        touch-action: manipulation;
        padding: 16px;
        box-sizing: border-box;
      }
      #name-gate .ng-card {
        width: min(360px, 100%);
        box-sizing: border-box;
        background: #242424;
        border: 1px solid #3a3a3a;
        border-radius: 12px;
        padding: 24px 20px;
        text-align: center;
        line-height: 1.4;
      }
      #name-gate .ng-title { color: #ffd54f; font-size: 30px; font-weight: 700; letter-spacing: 3px; }
      #name-gate .ng-sub { color: #cccccc; font-size: 15px; margin: 10px 0 16px; }
      #name-gate .ng-input {
        width: 100%;
        box-sizing: border-box;
        /* 16px minimum, otherwise iOS Safari zooms the whole page in on focus. */
        font-size: 16px;
        padding: 12px;
        border-radius: 8px;
        border: 1px solid #4a4a4a;
        background: #1a1a1a;
        color: #ffffff;
        text-align: center;
        outline: none;
      }
      #name-gate .ng-input:focus { border-color: #ffd54f; }
      #name-gate .ng-btn {
        width: 100%;
        margin-top: 12px;
        padding: 12px;
        font-size: 16px;
        font-weight: 600;
        border: 0;
        border-radius: 8px;
        background: #ffd54f;
        color: #1a1a1a;
        cursor: pointer;
      }
      #name-gate .ng-btn:active { background: #ffc107; }
      #name-gate .ng-hint { color: #888888; font-size: 12px; margin-top: 14px; }`;

    document.head.appendChild(style);
    document.body.appendChild(overlay);

    const input = overlay.querySelector('.ng-input') as HTMLInputElement;
    const button = overlay.querySelector('.ng-btn') as HTMLButtonElement;

    const finish = (): void => {
      const name = sanitize(input.value);
      writeStored(name);
      overlay.remove();
      style.remove();
      pending = null;
      resolve(name);
    };

    button.addEventListener('click', finish);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish();
      // The game itself listens for SPACE/R/1-4 on the window; without this, typing a name
      // with a space in it would also charge a shot behind the overlay.
      e.stopPropagation();
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());

    // Focus is deliberately not forced on touch devices: an unprompted keyboard pop-up
    // resizes the viewport before the player has even read the question.
    if (!('ontouchstart' in window)) input.focus();
  });

  return pending;
}
