// The 2D board, with its ball and figures replaced by real 3D objects.
//
// The board itself - grid, ZONKE header, bullet dashes, crossed-out rows, every label and
// every layout number - is still drawn by ZonkeScene exactly as it always was. This module
// only adds a transparent WebGL layer on top, in which the ball and the figures are actual
// lit, shadow-casting meshes standing at the pixel positions the 2D scene reports.
//
// The camera is orthographic and set up in CSS pixel space: one world unit is one pixel,
// x runs right and y is flipped to run down the screen, so a position from the scene can
// be used unchanged. That is what guarantees the layout cannot drift - there is no second
// layout here to drift from, only the first one's coordinates.
import * as THREE from 'three';
import type Phaser from 'phaser';
import { set3DActors, type ActorLayout, type ZonkeScene } from '../scenes/ZonkeScene';

const P1_COLOR = 0x4caf50;
const P2_COLOR = 0x2196f3;
const BALL_COLOR = 0xffd54f;
const SPLIT_COLOR = 0x00e676;
const GUNMETAL = 0xe4e4e4;

/** Depth is only used for lighting and overlap, so a shallow slab of z is plenty. */
const Z_NEAR = -400;
const Z_FAR = 400;

interface FigureNode {
  group: THREE.Group;
  parts: THREE.Object3D[];
}

export class ActorOverlay {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(0, 1, 1, 0, Z_NEAR, Z_FAR);
  private readonly canvas: HTMLCanvasElement;
  private readonly ballGeometry = new THREE.SphereGeometry(1, 28, 20);
  private readonly ballMaterial: THREE.MeshStandardMaterial;
  private readonly splitMaterial: THREE.MeshStandardMaterial;
  readonly ballMeshes: THREE.Mesh[] = [];
  private readonly ballShadows: THREE.Mesh[] = [];
  private readonly shadowMaterial: THREE.MeshBasicMaterial;
  figures: FigureNode[][] = []; // [slot][side]
  private layoutKey = '';
  private layout: ActorLayout | null = null;

  constructor(host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    // Sits directly over the Phaser canvas and never eats a tap - all input still goes to
    // the game underneath.
    Object.assign(this.canvas.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      pointerEvents: 'none',
      zIndex: '2',
    } satisfies Partial<CSSStyleDeclaration>);
    host.appendChild(this.canvas);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // No shadow map: the only surface a shadow could fall on is the 2D board, which lives
    // in the other canvas entirely. The contact blobs below fake that far more cheaply.

    this.ballMaterial = new THREE.MeshStandardMaterial({
      color: BALL_COLOR,
      roughness: 0.22,
      metalness: 0.6,
      emissive: 0x2a1f00,
    });
    this.splitMaterial = new THREE.MeshStandardMaterial({
      color: SPLIT_COLOR,
      roughness: 0.3,
      metalness: 0.45,
      emissive: 0x00381a,
    });

    // One soft radial blob, reused for every contact shadow.
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = 64;
    shadowCanvas.height = 64;
    const sg = shadowCanvas.getContext('2d')!;
    const grad = sg.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    sg.fillStyle = grad;
    sg.fillRect(0, 0, 64, 64);
    this.shadowMaterial = new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(shadowCanvas),
      transparent: true,
      depthWrite: false,
    });

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    this.scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x202429, 1.0));
    // World +y is UP the screen here (pixel y is flipped on the way in), so a light meant
    // to come from the top-left has to be at POSITIVE y - the first version had it at -y
    // and was lighting everything from underneath.
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-0.45, 0.85, 1).multiplyScalar(500);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x9fc4ff, 0.75);
    fill.position.set(0.8, -0.3, 0.7).multiplyScalar(500);
    this.scene.add(fill);
  }

  /** Screen pixels in, world units out - y is flipped so the scene's coordinates just work. */
  private toWorldY(pixelY: number): number {
    return (this.layout?.canvasH ?? 0) - pixelY;
  }

  private applyLayout(layout: ActorLayout): void {
    this.layout = layout;
    const { canvasW, canvasH } = layout;
    this.canvas.style.width = `${canvasW}px`;
    this.canvas.style.height = `${canvasH}px`;
    this.renderer.setSize(canvasW, canvasH, false);
    this.camera = new THREE.OrthographicCamera(0, canvasW, canvasH, 0, Z_NEAR, Z_FAR);
    this.camera.position.z = 200;
    this.camera.lookAt(0, 0, 0);
    this.buildFigures(layout);
  }

  /**
   * The same figure the 2D board draws, from the same numbers.
   *
   * drawMiniFigure() in ZonkeScene works in design units around a centre point, scaled by
   * FIGURE_SCALE, with y running down the screen. Those exact offsets are reused here so
   * the 3D figure stands where the flat one stood, limb for limb - only built from solid
   * shapes that catch the light instead of strokes.
   */
  private buildFigures(layout: ActorLayout): void {
    this.figures.forEach((row) => row.forEach((f) => this.scene.remove(f.group)));
    this.figures = [];
    const v = layout.figureScale;

    for (let slot = 0; slot < 10; slot++) {
      const perSide: FigureNode[] = [];
      for (const side of [0, 1] as const) {
        const group = new THREE.Group();
        const m = side === 0 ? 1 : -1; // player 2's figure is a mirror image
        const mat = new THREE.MeshStandardMaterial({
          color: side === 0 ? P1_COLOR : P2_COLOR,
          roughness: 0.4,
          metalness: 0.3,
        });
        const parts: THREE.Object3D[] = [];

        // Design offsets -> local units. y is negated because the design's y runs down.
        const dx = (x: number): number => x * m * v;
        const dy = (y: number): number => -y * v;

        /** A limb, as a capsule laid between two design-space points. */
        const limb = (x1: number, y1: number, x2: number, y2: number, r: number): void => {
          const ax = dx(x1);
          const ay = dy(y1);
          const bx = dx(x2);
          const by = dy(y2);
          const len = Math.hypot(bx - ax, by - ay);
          const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r * v, len, 4, 10), mat);
          mesh.position.set((ax + bx) / 2, (ay + by) / 2, 0);
          mesh.rotation.z = -Math.atan2(bx - ax, by - ay);
          group.add(mesh);
          parts.push(mesh);
        };

        // FIGURE_PARTS order: head, spine, leftArm, rightArm, leftLeg, rightLeg, gun.
        const head = new THREE.Mesh(new THREE.SphereGeometry(5.2 * v, 18, 14), mat);
        head.position.set(0, dy(-13), 1.5 * v);
        group.add(head);
        parts.push(head);

        const spine = new THREE.Mesh(new THREE.BoxGeometry(5.2 * v, 15 * v, 4.2 * v), mat);
        spine.position.set(0, dy(0.5), 0);
        group.add(spine);
        parts.push(spine);

        limb(-1.6, -5, -9, 4, 1.5); // leftArm
        limb(1.6, -5, 10, -5, 1.5); // rightArm, the gun arm
        limb(-1.6, 8, -8, 19, 1.7); // leftLeg
        limb(1.6, 8, 8, 19, 1.7); // rightLeg

        // The pistol - barrel and grip, in gunmetal so it reads as a held object rather
        // than a bent arm, pointing the way this player shoots.
        const gun = new THREE.Group();
        const gunMat = new THREE.MeshStandardMaterial({ color: GUNMETAL, roughness: 0.25, metalness: 0.9 });
        const barrel = new THREE.Mesh(new THREE.BoxGeometry(13 * v, 3.4 * v, 3.2 * v), gunMat);
        barrel.position.set(dx(16.5), dy(-5), 0.5 * v);
        const grip = new THREE.Mesh(new THREE.BoxGeometry(3 * v, 6.4 * v, 3.2 * v), gunMat);
        grip.position.set(dx(10.5), dy(-1.8), 0.5 * v);
        gun.add(barrel, grip);
        group.add(gun);
        parts.push(gun);

        parts.forEach((part) => (part.visible = false));
        group.position.set(layout.figureX[side], 0, 0);
        group.visible = false;
        this.scene.add(group);
        perSide.push({ group, parts });
      }
      this.figures.push(perSide);
    }
  }

  /** One frame: read the scene's own state and put the meshes where it says. */
  sync(scene: ZonkeScene): void {
    const layout = scene.actorLayout();
    const key = `${layout.canvasW}x${layout.canvasH}x${Math.round(layout.figureScale * 100)}`;
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.applyLayout(layout);
    }

    const balls = scene.actorBalls();
    while (this.ballMeshes.length < balls.length) {
      const mesh = new THREE.Mesh(this.ballGeometry, this.ballMaterial);
      this.scene.add(mesh);
      this.ballMeshes.push(mesh);
      const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.shadowMaterial);
      this.scene.add(blob);
      this.ballShadows.push(blob);
    }
    this.ballMeshes.forEach((mesh, i) => {
      const ball = balls[i];
      const blob = this.ballShadows[i];
      if (!ball) {
        mesh.visible = false;
        if (blob) blob.visible = false;
        return;
      }
      // Offset down-right of the ball, matching the key light coming from the top-left.
      blob.visible = true;
      blob.scale.setScalar(ball.r * 3.4);
      blob.position.set(ball.x + ball.r * 0.35, this.toWorldY(ball.y) - ball.r * 0.35, -1);
      mesh.visible = true;
      mesh.material = ball.split ? this.splitMaterial : this.ballMaterial;
      mesh.scale.setScalar(ball.r);
      mesh.position.set(ball.x, this.toWorldY(ball.y), ball.r);
      // Rolled a little, so a sphere in flight reads as moving rather than sliding.
      mesh.rotation.x = -ball.y / Math.max(ball.r, 1);
      mesh.rotation.z = ball.x / Math.max(ball.r * 3, 1);
    });

    const drawn = new Map<string, number>();
    scene.actorFigures().forEach((f) => drawn.set(`${f.slot}:${f.side}`, f.parts));
    for (let slot = 0; slot < this.figures.length; slot++) {
      for (const side of [0, 1] as const) {
        const node = this.figures[slot][side];
        const count = drawn.get(`${slot}:${side}`) ?? 0;
        node.group.visible = count > 0;
        node.group.position.y = this.toWorldY(layout.logTop + slot * layout.rowH + layout.rowH / 2);
        node.parts.forEach((part, i) => (part.visible = i < count));
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.dispose();
    this.canvas.remove();
  }
}

/**
 * Attaches the overlay to a running game. Polls for the board scene rather than assuming
 * it is up, since a restart (a resize, or Play again) tears the scene down and rebuilds it.
 */
export function attach3DActors(game: Phaser.Game): ActorOverlay | null {
  const host = (game.canvas.parentElement ?? document.body) as HTMLElement;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

  // A device with no WebGL context available throws here. That is not a reason to break
  // the game: the board keeps its own flat ball and figures and plays exactly as before.
  let overlay: ActorOverlay;
  try {
    overlay = new ActorOverlay(host);
  } catch (error) {
    console.warn('3D actors unavailable, keeping the flat board', error);
    set3DActors(false);
    return null;
  }

  let handedOver = false;
  const frame = (): void => {
    const scene = game.scene.getScene('ZonkeScene') as ZonkeScene | null;
    if (scene && scene.scene.isActive() && typeof scene.actorLayout === 'function') {
      overlay.sync(scene);
      // Only once a frame has actually been drawn does the board stop drawing its own.
      if (!handedOver) {
        handedOver = true;
        set3DActors(true);
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // Dev-only handle for scripts/check-3d.mjs, which asserts the meshes land on the 2D
  // board's own coordinates. Dropped from production by import.meta.env.DEV.
  if (import.meta.env.DEV) {
    (window as Window & { zonkeActors?: ActorOverlay }).zonkeActors = overlay;
  }
  return overlay;
}
