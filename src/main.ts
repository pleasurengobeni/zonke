import Phaser from 'phaser';
import { ZonkeScene } from './scenes/ZonkeScene';

// visualViewport tracks the real visible area (excludes iOS Safari's address/tab bars),
// falling back to innerWidth/Height on browsers that lack it.
const width = window.visualViewport?.width ?? window.innerWidth;
const height = window.visualViewport?.height ?? window.innerHeight;

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
