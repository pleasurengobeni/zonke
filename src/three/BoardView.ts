// The 3D view of a Match.
//
// The board is the same flat plane the simulation works in - it is simply laid down in
// world space and tilted back towards the camera, so board coordinates map straight
// through: world.x = board.x, world.z = board.y. Depth comes from the tilt, the lighting
// and real shadows, not from changing an inch of the game underneath.
//
// The tilt is deliberately modest. This board is half arcade and half scoreboard: row
// numbers, column letters and bullet dashes have to stay readable, and a dramatic camera
// angle trades that away for very little.
import * as THREE from 'three';
import { BOARD_ROWS, FIGURE_PARTS, ROWS as LETTERS } from '../zonke/GameState';
import { BOARD_W, CELL_W, LAUNCH_Y, type Match } from '../zonke/Match';

// Near face-on, matching the original 2D board. The tilt is only enough for the shapes to
// catch the light and cast shadows - the layout itself is the flat board's, because that
// is what is actually readable: rows, columns and figures all sit where they always did.
const TILT_DEGREES = 18;
const P1_COLOR = 0x4caf50;
const P2_COLOR = 0x2196f3;
const BALL_COLOR = 0xffd54f;
const SPLIT_COLOR = 0x00e676;
const BONUS_COLOR = 0xffd54f;
const LIFELINE_COLOR = 0xff9800;
const DEAD_COLOR = 0xff5252;

const BOARD_DEPTH = BOARD_ROWS; // rows 0..10 along world z
// The 2D board's own proportions, in row units (its design is 1500x1160 with a 1056-wide
// grid and a row height of 88*0.92). Reusing them is what makes this the same layout:
// the grid keeps 70.4% of the width, the figures get the margins, the rows get the height.
const MARGIN = 222 / (88 * 0.92); // 2.74 - the 2D design's side margin
const HEADER_D = 101.2 / (88 * 0.92); // 1.25 - the ZONKE header strip above row 10
const TOTAL_W = BOARD_W + MARGIN * 2;
const CONTENT_H = HEADER_D + BOARD_ROWS;
const CONTENT_MID_Z = (BOARD_ROWS - HEADER_D) / 2;
const SLAB_H = 0.16; // how far a row slab stands proud of the table

/** Canvas-drawn texture for the board face: grid lines, row numbers, column letters. */
function makeBoardTexture(): THREE.CanvasTexture {
  const pxPerUnit = 72;
  const w = Math.round(BOARD_W * pxPerUnit);
  const h = Math.round(BOARD_DEPTH * pxPerUnit);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#1f2327';
  g.fillRect(0, 0, w, h);

  // Row bands, alternating just enough to be countable at a glance.
  for (let r = 0; r < BOARD_ROWS; r++) {
    g.fillStyle = r % 2 === 0 ? '#23282d' : '#1f2327';
    g.fillRect(0, (r * h) / BOARD_ROWS, w, h / BOARD_ROWS);
  }
  g.strokeStyle = 'rgba(255,255,255,0.22)';
  g.lineWidth = 2;
  for (let r = 0; r <= BOARD_ROWS; r++) {
    const y = (r * h) / BOARD_ROWS;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
  }
  for (let c = 0; c <= LETTERS.length; c++) {
    const x = (c * w) / LETTERS.length;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
  }

  // Row numbers down the left edge only - where the 2D board puts them.
  g.fillStyle = 'rgba(255,255,255,0.42)';
  g.font = `bold ${Math.round(pxPerUnit * 0.34)}px ui-monospace, monospace`;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  for (let r = 0; r < BOARD_ROWS; r++) {
    g.fillText(String(BOARD_ROWS - r), 9, (r * h) / BOARD_ROWS + h / BOARD_ROWS / 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** The ZONKE header strip that sits above row 10, plus the A-H column letters. */
function makeHeaderTexture(): THREE.CanvasTexture {
  const w = 1024;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#16181b';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#ffd54f';
  g.font = 'bold 96px ui-monospace, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('ZONKE', w / 2, h * 0.32);
  g.font = 'bold 54px ui-monospace, monospace';
  LETTERS.forEach((letter, i) => {
    g.fillStyle = i === LETTERS.length - 1 ? '#ff5252' : '#ffffff';
    g.fillText(letter, ((i + 0.5) * w) / LETTERS.length, h * 0.75);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface FigureMeshes {
  group: THREE.Group;
  parts: THREE.Mesh[];
  cross: THREE.Group;
}

export class BoardView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  // The board hangs off a stage so the whole thing can be squeezed horizontally on narrow
  // screens without moving off centre - scaling the board group directly would scale its
  // own centring offset too and shove it sideways.
  private readonly stage = new THREE.Group();
  private readonly board = new THREE.Group();
  private xSqueeze = 1;
  private readonly ballMeshes = new Map<number, THREE.Mesh>();
  private readonly ballGeometry: THREE.SphereGeometry;
  private readonly ballMaterial: THREE.MeshStandardMaterial;
  private readonly splitBallMaterial: THREE.MeshStandardMaterial;
  private readonly rowSlabs: THREE.Mesh[] = [];
  private readonly rowSlabMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly figures: FigureMeshes[][] = []; // [slot][player]
  private readonly bulletDots: THREE.Mesh[][][] = []; // [slot][player][step]
  private framedSize = new THREE.Vector3(1, 1, 1);
  private confetti: THREE.InstancedMesh | null = null;
  private confettiVel: THREE.Vector3[] = [];
  private splitFlash: THREE.Mesh | null = null;
  private splitFlashUntil = 0;

  constructor(canvas: HTMLCanvasElement, private readonly match: Match) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color(0x14161a);

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);

    this.buildLights();
    this.buildTable();
    this.buildRowSlabs();
    this.buildFigures();
    this.buildBulletDots();

    this.ballGeometry = new THREE.SphereGeometry(0.34, 24, 18);
    this.ballMaterial = new THREE.MeshStandardMaterial({
      color: BALL_COLOR,
      roughness: 0.25,
      metalness: 0.55,
      emissive: 0x3a2c00,
    });
    this.splitBallMaterial = new THREE.MeshStandardMaterial({
      color: SPLIT_COLOR,
      roughness: 0.3,
      metalness: 0.4,
      emissive: 0x004d22,
    });

    this.scene.add(this.stage);
    this.stage.add(this.board);
    // Board space runs x across and y DOWN the board. Standing the group up by
    // (90 - tilt) maps that local +z onto world "down and towards the viewer", so row 1
    // sits low and near, the ZONKE band high and far, and the face leans back by the tilt.
    this.board.rotation.x = THREE.MathUtils.degToRad(90 - TILT_DEGREES);

    // Then centre it on the origin from its own measured bounds rather than by working the
    // trigonometry out by hand - which is exactly what put the first version off-screen.
    this.board.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(this.board);
    const centre = bounds.getCenter(new THREE.Vector3());
    this.board.position.sub(centre);
    this.board.updateMatrixWorld(true);
    this.framedSize = new THREE.Box3().setFromObject(this.board).getSize(new THREE.Vector3());

    this.syncSpecialRows();
    this.syncBoard();
  }

  private buildLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x20242a, 1.6));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-9, 14, 18);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 60;
    const s = 16;
    key.shadow.camera.left = -s;
    key.shadow.camera.right = s;
    key.shadow.camera.top = s;
    key.shadow.camera.bottom = -s;
    key.shadow.bias = -0.0015;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x88b4ff, 0.9);
    rim.position.set(11, 4, 6);
    this.scene.add(rim);
  }

  private buildTable(): void {
    // The playfield itself, face up, textured with the grid.
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(BOARD_W, BOARD_DEPTH),
      new THREE.MeshStandardMaterial({ map: makeBoardTexture(), roughness: 0.85, metalness: 0.05 })
    );
    face.rotation.x = -Math.PI / 2;
    face.position.set(BOARD_W / 2, 0.01, BOARD_DEPTH / 2);
    face.receiveShadow = true;
    this.board.add(face);

    // A slab under it so the board reads as a physical object with thickness.
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(TOTAL_W, 0.7, CONTENT_H + 1.5),
      new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.7, metalness: 0.15 })
    );
    body.position.set(BOARD_W / 2, -0.36, CONTENT_MID_Z + 0.45);
    body.receiveShadow = true;
    this.board.add(body);

    // The ZONKE header above row 10 - the band the ball has to stop in to jackpot.
    const header = new THREE.Mesh(
      new THREE.PlaneGeometry(BOARD_W, HEADER_D),
      new THREE.MeshStandardMaterial({ map: makeHeaderTexture(), roughness: 0.8 })
    );
    header.rotation.x = -Math.PI / 2;
    header.position.set(BOARD_W / 2, 0.02, -HEADER_D / 2);
    header.receiveShadow = true;
    this.board.add(header);

    // Side rails the ball bounces off, and the wall above ZONKE.
    const railMat = new THREE.MeshStandardMaterial({ color: 0x3d4650, roughness: 0.4, metalness: 0.6 });
    const railGeo = new THREE.BoxGeometry(0.16, 0.42, CONTENT_H);
    [0, BOARD_W].forEach((x) => {
      const rail = new THREE.Mesh(railGeo, railMat);
      rail.position.set(x, 0.17, CONTENT_MID_Z);
      rail.castShadow = true;
      this.board.add(rail);
    });
    const topRail = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W + 0.16, 0.42, 0.16), railMat);
    topRail.position.set(BOARD_W / 2, 0.17, -HEADER_D);
    topRail.castShadow = true;
    this.board.add(topRail);

    // The launcher pad, below row 1, marking where the ball is parked between shots.
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.62, 0.1, 28),
      new THREE.MeshStandardMaterial({ color: 0x3a4149, roughness: 0.6, metalness: 0.3 })
    );
    pad.position.set(BOARD_W / 2, 0.03, LAUNCH_Y);
    pad.receiveShadow = true;
    this.board.add(pad);
  }

  /** One thin slab per row - normally flush and dark, lit up when a row turns special. */
  private buildRowSlabs(): void {
    for (let r = 0; r < BOARD_ROWS; r++) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0x000000,
        transparent: true,
        opacity: 0,
        roughness: 0.5,
      });
      const slab = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, SLAB_H, 1), mat);
      slab.position.set(BOARD_W / 2, SLAB_H / 2 + 0.015, r + 0.5);
      this.board.add(slab);
      this.rowSlabs.push(slab);
      this.rowSlabMaterials.push(mat);
    }
  }

  /** A stick figure per row per side, standing in the margin beside its own row. */
  private buildFigures(): void {
    for (let r = 0; r < BOARD_ROWS; r++) {
      const perPlayer: FigureMeshes[] = [];
      for (const player of [0, 1] as const) {
        const group = new THREE.Group();
        const colour = player === 0 ? P1_COLOR : P2_COLOR;
        const mat = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.45, metalness: 0.2 });
        const mirror = player === 0 ? 1 : -1;
        const parts: THREE.Mesh[] = [];
        const add = (geo: THREE.BufferGeometry, x: number, y: number, z = 0, rotZ = 0): THREE.Mesh => {
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.set(x * mirror, y, z);
          mesh.rotation.z = rotZ * mirror;
          mesh.castShadow = true;
          group.add(mesh);
          parts.push(mesh);
          return mesh;
        };
        // Order matches FIGURE_PARTS: head, spine, arms, legs, gun.
        add(new THREE.SphereGeometry(0.2, 14, 12), 0, 0.98);
        add(new THREE.CapsuleGeometry(0.11, 0.42, 4, 10), 0, 0.6);
        add(new THREE.CapsuleGeometry(0.06, 0.34, 4, 8), -0.2, 0.62, 0, 0.9);
        add(new THREE.CapsuleGeometry(0.06, 0.34, 4, 8), 0.22, 0.7, 0, 1.45);
        add(new THREE.CapsuleGeometry(0.07, 0.36, 4, 8), -0.11, 0.2, 0, 0.25);
        add(new THREE.CapsuleGeometry(0.07, 0.36, 4, 8), 0.11, 0.2, 0, -0.25);
        const gun = new THREE.Mesh(
          new THREE.BoxGeometry(0.34, 0.09, 0.09),
          new THREE.MeshStandardMaterial({ color: 0xdadada, roughness: 0.3, metalness: 0.8 })
        );
        gun.position.set(0.42 * mirror, 0.72, 0);
        gun.castShadow = true;
        group.add(gun);
        parts.push(gun);

        // The red cross that marks a row this player has lost.
        const cross = new THREE.Group();
        const crossMat = new THREE.MeshStandardMaterial({ color: DEAD_COLOR, emissive: 0x5a0000 });
        [-1, 1].forEach((dir) => {
          const bar = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 0.08), crossMat);
          bar.rotation.z = (dir * Math.PI) / 4;
          bar.position.y = 0.6;
          cross.add(bar);
        });
        cross.visible = false;
        group.add(cross);

        const x = player === 0 ? -MARGIN / 2 - 0.05 : BOARD_W + MARGIN / 2 + 0.05;
        group.position.set(x, 0.06, r + 0.97);
        group.userData.baseScale = 0.8;
        group.scale.setScalar(0.8);
        // Local +Y becomes "up the board", so the figures stand upright when the board is
        // read face-on, with their own thickness giving them relief off the surface.
        group.rotation.x = -Math.PI / 2;
        this.board.add(group);
        perPlayer.push({ group, parts, cross });
      }
      this.figures.push(perPlayer);
    }
  }

  /** A dash per letter the bullet has reached, laid along the row's own sub-line. */
  private buildBulletDots(): void {
    const geo = new THREE.BoxGeometry(CELL_W * 0.42, 0.06, 0.1);
    for (let r = 0; r < BOARD_ROWS; r++) {
      const perPlayer: THREE.Mesh[][] = [];
      for (const player of [0, 1] as const) {
        const mat = new THREE.MeshStandardMaterial({
          color: player === 0 ? P1_COLOR : P2_COLOR,
          emissive: player === 0 ? 0x123d16 : 0x0c2a44,
        });
        const dots: THREE.Mesh[] = [];
        for (let i = 0; i < LETTERS.length; i++) {
          const col = player === 0 ? i : LETTERS.length - 1 - i;
          const dot = new THREE.Mesh(geo, mat);
          dot.position.set((col + 0.5) * CELL_W, 0.06, r + (player === 0 ? 0.3 : 0.72));
          dot.visible = false;
          dot.castShadow = true;
          this.board.add(dot);
          dots.push(dot);
        }
        perPlayer.push(dots);
      }
      this.bulletDots.push(perPlayer);
    }
  }

  // ---- per-frame ------------------------------------------------------------------

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    // Pull back until the board fits BOTH fields of view, with a margin - that is what
    // keeps a phone in portrait from cropping the outer columns and a wide desktop from
    // cropping the top and bottom. Measured, not guessed.
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    // A ~1.5:1 board on a 0.46:1 phone screen fits the width and wastes most of the
    // height. So the cells get narrower as the screen does, exactly as the 2D board's do -
    // the grid keeps its share of the width while the rows keep their share of the height.
    // Only the picture is squeezed; the simulation still works in square board units.
    const boardAspect = this.framedSize.x / this.framedSize.y;
    this.xSqueeze = THREE.MathUtils.clamp(this.camera.aspect / boardAspect, 0.42, 1);
    this.stage.scale.x = this.xSqueeze;
    this.compensateSqueeze();

    const padW = 1.03;
    const padH = 1.24; // the HUD owns a strip at the top and another at the bottom
    const fitH = (this.framedSize.y * padH) / 2 / Math.tan(vFov / 2);
    const fitW = (this.framedSize.x * this.xSqueeze * padW) / 2 / Math.tan(hFov / 2);
    const distance = Math.max(fitH, fitW) + this.framedSize.z / 2;

    // Slightly above centre, looking at it - enough to see the slabs and the figures stand
    // off the surface, not so much that the board turns into a sliver.
    this.camera.position.set(0, distance * 0.17, distance);
    this.camera.lookAt(0, -this.framedSize.y * 0.02, 0);
    this.scene.fog = new THREE.Fog(0x14161a, distance * 0.9, distance * 2.6);
  }

  /** Undoes the horizontal squeeze on the things that must not look stretched. */
  private compensateSqueeze(): void {
    const inv = 1 / this.xSqueeze;
    this.figures.flat().forEach(({ group }) => {
      const base = group.userData.baseScale as number;
      group.scale.set(base * inv, base, base);
    });
    this.ballMeshes.forEach((mesh) => {
      const base = mesh.userData.baseScale as number;
      mesh.scale.set(base * inv, base, base);
    });
  }

  render(nowMs: number): void {
    this.syncBalls();
    this.pulseSpecialRows(nowMs);
    this.stepConfetti();
    if (this.splitFlash && nowMs > this.splitFlashUntil) {
      this.splitFlash.visible = false;
    }
    this.renderer.render(this.scene, this.camera);
  }

  /** Board coordinates straight through: x across, y down the table into world z. */
  private syncBalls(): void {
    const live = new Set<number>();
    for (const ball of this.match.balls) {
      live.add(ball.id);
      let mesh = this.ballMeshes.get(ball.id);
      if (!mesh) {
        mesh = new THREE.Mesh(this.ballGeometry, ball.fromSplit ? this.splitBallMaterial : this.ballMaterial);
        mesh.castShadow = true;
        const base = ball.fromSplit ? 0.78 : 1;
        mesh.userData.baseScale = base;
        mesh.scale.set(base / this.xSqueeze, base, base);
        this.board.add(mesh);
        this.ballMeshes.set(ball.id, mesh);
      }
      mesh.position.set(ball.x, 0.34, ball.y);
      // Roll it in the direction of travel, so a fast ball reads as moving rather than sliding.
      mesh.rotation.x += ball.vy * 2.2;
      mesh.rotation.z -= ball.vx * 2.2;
    }
    for (const [id, mesh] of this.ballMeshes) {
      if (live.has(id)) continue;
      this.board.remove(mesh);
      this.ballMeshes.delete(id);
    }
  }

  private pulseSpecialRows(nowMs: number): void {
    const pulse = 0.5 + 0.5 * Math.sin(nowMs / 320);
    this.rowSlabMaterials.forEach((mat, r) => {
      let colour: number | null = null;
      let strength = 0.35;
      if (r === this.match.splitRow) {
        colour = SPLIT_COLOR;
        strength = 0.6;
      } else if (r === this.match.bonusRow) {
        colour = BONUS_COLOR;
      } else if (r === this.match.lifelineRow) {
        colour = LIFELINE_COLOR;
      }
      if (colour === null) {
        mat.opacity = 0;
        mat.emissiveIntensity = 0;
        return;
      }
      mat.color.setHex(colour);
      mat.emissive.setHex(colour);
      mat.opacity = 0.16 + pulse * strength * 0.45;
      mat.emissiveIntensity = 0.25 + pulse * strength;
    });
  }

  /** The row itself turning green, for the moment a ball lands on it. */
  flashSplitRow(slot: number, nowMs: number): void {
    if (!this.splitFlash) {
      this.splitFlash = new THREE.Mesh(
        new THREE.BoxGeometry(BOARD_W, 0.22, 1),
        new THREE.MeshStandardMaterial({
          color: SPLIT_COLOR,
          emissive: SPLIT_COLOR,
          emissiveIntensity: 2.4,
          transparent: true,
          opacity: 0.85,
        })
      );
      this.board.add(this.splitFlash);
    }
    this.splitFlash.position.set(BOARD_W / 2, 0.12, slot + 0.5);
    this.splitFlash.visible = true;
    this.splitFlashUntil = nowMs + 650;
  }

  /** Figures, bullet dashes and crossed-out rows, redrawn from the match's own state. */
  syncBoard(): void {
    for (let r = 0; r < BOARD_ROWS; r++) {
      for (const player of [0, 1] as const) {
        const drawn = this.match.rowFigureParts[r][player];
        const fig = this.figures[r][player];
        fig.parts.forEach((part, i) => {
          part.visible = i < drawn;
        });
        fig.cross.visible = this.match.players[player].deadRows[r];
        const steps = this.match.rowBullets[r][player];
        this.bulletDots[r][player].forEach((dot, i) => {
          dot.visible = i < steps;
        });
      }
    }
  }

  syncSpecialRows(): void {
    // Emissive state is driven per frame in pulseSpecialRows; nothing to do here beyond
    // letting a view that wants to react to the change hook in.
  }

  /** Paper over the table when someone wins. */
  celebrate(celebratory: boolean): void {
    const count = 220;
    const palette = celebratory
      ? [0xffd54f, 0x4caf50, 0x2196f3, 0xff5252, 0xffffff, SPLIT_COLOR]
      : [0x777777, 0x999999];
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.22, 0.02, 0.12),
      new THREE.MeshStandardMaterial({ roughness: 0.6, vertexColors: false }),
      count
    );
    const colours = new Float32Array(count * 3);
    const dummy = new THREE.Object3D();
    this.confettiVel = [];
    for (let i = 0; i < count; i++) {
      dummy.position.set(
        (Math.random() - 0.5) * (BOARD_W + MARGIN * 2),
        8 + Math.random() * 10,
        (Math.random() - 0.5) * BOARD_DEPTH + BOARD_DEPTH / 2
      );
      dummy.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      const c = new THREE.Color(palette[i % palette.length]);
      colours.set([c.r, c.g, c.b], i * 3);
      this.confettiVel.push(new THREE.Vector3((Math.random() - 0.5) * 0.02, -0.04 - Math.random() * 0.05, 0));
    }
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colours, 3);
    this.board.add(mesh);
    this.confetti = mesh;
  }

  private stepConfetti(): void {
    const mesh = this.confetti;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, dummy.matrix);
      dummy.matrix.decompose(dummy.position, dummy.quaternion, dummy.scale);
      const v = this.confettiVel[i];
      dummy.position.addScaledVector(v, 1);
      dummy.rotation.setFromQuaternion(dummy.quaternion);
      dummy.rotation.x += 0.06;
      dummy.rotation.y += 0.04;
      if (dummy.position.y < -0.5) {
        dummy.position.y = 10 + Math.random() * 8;
      }
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.renderer.dispose();
  }
}

export const FIGURE_PART_COUNT = FIGURE_PARTS.length;
