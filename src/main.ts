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

// 3D is opt-in while it is being built out, and comes in two shapes:
//
//   ?r3d=1      the ORIGINAL 2D board, with the ball and figures replaced by real 3D
//               meshes on a transparent layer above it. The board, its layout and every
//               number on it are the 2D game's own - only those two things are 3D.
//   ?r3d=table  the full 3D table: the whole board rebuilt as a tilted surface. Parked.
//
// Both load dynamically, so Three.js costs nothing to anyone who does not ask for it.
const params = new URLSearchParams(location.search);
const renderer3d = params.get('r3d');
if (renderer3d === 'table') {
  track('renderer_3d', { variant: 'table' });
  void import('./three/main3d').then((m) => m.start3D());
} else if (renderer3d !== null) {
  track('renderer_3d', { variant: 'actors' });
  const game = bootPhaser();
  // The board boots flat and playable; the overlay takes over the ball and the figures
  // once it is actually drawing, and never if Three or WebGL cannot start.
  void import('./three/actors')
    .then((m) => m.attach3DActors(game))
    .catch((error) => console.warn('3D actors failed to load, keeping the flat board', error));
  if (params.has('online')) void import('./online/online').then((m) => m.startOnline(game));
} else {
  const game = bootPhaser();
  // ?online=1 goes straight to the waiting room; the mode picker gets there too.
  if (params.has('online')) void import('./online/online').then((m) => m.startOnline(game));
}
