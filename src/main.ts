import Phaser from 'phaser';
import { ZonkeScene } from './scenes/ZonkeScene';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'app',
  width: 900,
  height: 940,
  backgroundColor: '#2d2d2d',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [ZonkeScene],
};

new Phaser.Game(config);
