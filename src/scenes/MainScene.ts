import Phaser from 'phaser';

export class MainScene extends Phaser.Scene {
  private player!: Phaser.Physics.Arcade.Sprite;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private coins!: Phaser.Physics.Arcade.Group;
  private score = 0;
  private scoreText!: Phaser.GameObjects.Text;

  constructor() {
    super('MainScene');
  }

  preload(): void {
    // Generate simple textures at runtime so no external art assets are needed yet.
    this.makeRectTexture('player', 32, 32, 0x4caf50);
    this.makeCircleTexture('coin', 16, 0xffd54f);
  }

  create(): void {
    this.cursors = this.input.keyboard!.createCursorKeys();

    this.player = this.physics.add.sprite(400, 300, 'player');
    this.player.setCollideWorldBounds(true);

    this.coins = this.physics.add.group();
    for (let i = 0; i < 8; i++) {
      const x = Phaser.Math.Between(40, 760);
      const y = Phaser.Math.Between(40, 560);
      this.coins.create(x, y, 'coin');
    }

    this.physics.add.overlap(this.player, this.coins, (_player, coin) => {
      (coin as Phaser.Physics.Arcade.Sprite).destroy();
      this.score += 10;
      this.scoreText.setText(`Score: ${this.score}`);

      if (this.coins.countActive(true) === 0) {
        for (let i = 0; i < 8; i++) {
          const x = Phaser.Math.Between(40, 760);
          const y = Phaser.Math.Between(40, 560);
          this.coins.create(x, y, 'coin');
        }
      }
    });

    this.scoreText = this.add.text(16, 16, 'Score: 0', {
      fontSize: '20px',
      color: '#ffffff',
    });
  }

  update(): void {
    const speed = 220;
    this.player.setVelocity(0);

    if (this.cursors.left.isDown) {
      this.player.setVelocityX(-speed);
    } else if (this.cursors.right.isDown) {
      this.player.setVelocityX(speed);
    }

    if (this.cursors.up.isDown) {
      this.player.setVelocityY(-speed);
    } else if (this.cursors.down.isDown) {
      this.player.setVelocityY(speed);
    }
  }

  private makeRectTexture(key: string, width: number, height: number, color: number): void {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(color, 1);
    g.fillRect(0, 0, width, height);
    g.generateTexture(key, width, height);
    g.destroy();
  }

  private makeCircleTexture(key: string, radius: number, color: number): void {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(color, 1);
    g.fillCircle(radius, radius, radius);
    g.generateTexture(key, radius * 2, radius * 2);
    g.destroy();
  }
}
