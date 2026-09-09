import Phaser from 'phaser';
import { ZonkeScene } from './scenes/ZonkeScene';

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
  scene: [ZonkeScene],
};

new Phaser.Game(config);
