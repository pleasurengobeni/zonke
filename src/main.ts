import Phaser from 'phaser';
import { ZonkeScene } from './scenes/ZonkeScene';
import { TimeAttackScene } from './scenes/TimeAttackScene';
import { track } from './analytics';

track('page_view');

function bootPhaser(): Phaser.Game {
  // innerWidth/Height is what correctly tracks the real CSS viewport in every case that
  // matters here, including Chrome DevTools' device emulation - visualViewport is meant for
  // tracking iOS Safari's dynamic toolbar and is unreliable as the initial boot size (it has
  // been seen reporting the real desktop window's size under device emulation instead of the
  // emulated one), so it is not used for this synchronous read.
  const width = window.innerWidth;
  const height = window.innerHeight;

  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: 'app',
    width,
    height,
    backgroundColor: '#2d2d2d',
    scale: {
      // RESIZE, not FIT: the canvas becomes exactly the container's size on every layout
      // change, so the board fills the real screen instead of being letterboxed to fit a
      // fixed design size. ZonkeScene derives its whole layout from this size at create time.
      mode: Phaser.Scale.RESIZE,
      autoRound: true,
    },
    scene: [ZonkeScene, TimeAttackScene],
  };

  const game = new Phaser.Game(config);

  // Dev-only handle for the browser-driven checks in scripts/ - they need to steer a real
  // match (force a landing on the split row, jump to the win screen) rather than press the
  // mouse at random and hope. Vite folds import.meta.env.DEV to false in a production
  // build, so this block is dropped from the shipped bundle entirely.
  if (import.meta.env.DEV) {
    (window as Window & { zonkeGame?: Phaser.Game }).zonkeGame = game;
  }
  return game;
}

const params = new URLSearchParams(location.search);

// A tab left open is not a player: after a couple of minutes without input the game asks
// whether anyone is there, and ends the session if nobody answers. Without it, every
// engagement figure is inflated by time when nobody was at the screen.
void import('./idle').then(({ IdleWatcher }) => {
  const idle = new IdleWatcher({
    // Overridable in dev only, so the browser-driven checks need not wait two minutes.
    idleMs: import.meta.env.DEV ? Number(params.get('idleMs')) || undefined : undefined,
    graceMs: import.meta.env.DEV ? Number(params.get('graceMs')) || undefined : undefined,
    onExpire: () => {
      // Free anyone who was waiting on this player.
      window.dispatchEvent(new CustomEvent('zonke:session-expired'));
    },
  });
  if (import.meta.env.DEV) (window as Window & { zonkeIdle?: unknown }).zonkeIdle = idle;
});

// The board everyone gets is the 2D one, with its ball and figures drawn as real lit 3D
// meshes on a transparent layer above it. The layout, the grid, the labels and every
// number on the board stay the flat game's own - the overlay replaces two things and
// nothing else, reading the scene's own pixel coordinates so there is no second layout
// that could drift from the first.
//
// It degrades rather than breaks. The board boots flat and playable, and the meshes take
// over only once they are actually drawing; a device with no WebGL, or a chunk that never
// arrives, simply keeps the flat ball and figures instead of ending up with a board that
// has nothing on it.
//
//   ?flat=1     keeps the wholly flat board.
//   ?r3d=table  the whole board rebuilt as a tilted 3D table, on the headless engine in
//               Match.ts. Parked - the flat layout reads better - but kept because that
//               engine is what online play already runs on.
const renderer3d = params.get('r3d');
if (renderer3d === 'table') {
  track('renderer_3d', { variant: 'table' });
  void import('./three/main3d').then((m) => m.start3D());
} else {
  const game = bootPhaser();
  if (!params.has('flat')) {
    void import('./three/actors')
      .then((m) => {
        const overlay = m.attach3DActors(game);
        track('renderer_3d', { variant: overlay ? 'actors' : 'flat-fallback' });
      })
      .catch((error) => {
        // Nothing to do but carry on flat - which is exactly what the board is already doing.
        track('renderer_3d', { variant: 'flat-fallback' });
        console.warn('3D actors failed to load, keeping the flat board', error);
      });
  }
  // ?online=1 goes straight to the waiting room; the mode picker gets there too.
  if (params.has('online')) void import('./online/online').then((m) => m.startOnline(game));
}
