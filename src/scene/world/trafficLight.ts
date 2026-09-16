import {
  Color3,
  MeshBuilder,
  PointLight,
  StandardMaterial,
  TransformNode,
  Vector3,
  type DynamicTexture,
  type Mesh,
  type Scene,
} from "@babylonjs/core";
import { LIGHT } from "../config";
import type { Disposable } from "../core/types";
import { radialTexture, unlit } from "../core/visuals";

export type TrafficLight = Disposable & {
  /** The lamps and halos, for opting into a restricted glow layer. */
  glowing: Mesh[];
  isGreen: () => boolean;
  toggle: () => void;
  update: (dt: number, elapsed: number) => void;
};

type Lamp = {
  box: Mesh;
  material: StandardMaterial;
  halo: Mesh;
  haloMaterial: StandardMaterial;
  colour: Color3;
};

/**
 * A chunky cartoon signal: two glowing lamp boxes on a head that always turns to
 * face the camera, so the player can read the state from any orbit angle.
 */
export function createTrafficLight(scene: Scene, position: Vector3): TrafficLight {
  const root = new TransformNode("trafficLight", scene);
  root.position.copyFrom(position);

  const dark = plastic(scene, "trafficLight.darkMat", new Color3(0.045, 0.05, 0.075));

  const pole = MeshBuilder.CreateCylinder(
    "trafficLight.pole",
    { height: LIGHT.poleHeight, diameter: 0.2, tessellation: 12 },
    scene,
  );
  pole.parent = root;
  pole.position.y = LIGHT.poleHeight / 2;
  pole.isPickable = false;
  pole.material = dark;

  const foot = MeshBuilder.CreateCylinder(
    "trafficLight.foot",
    { height: 0.3, diameterTop: 0.44, diameterBottom: 0.66, tessellation: 14 },
    scene,
  );
  foot.parent = root;
  foot.position.y = 0.15;
  foot.isPickable = false;
  foot.material = dark;

  // The head turns to face the camera — that is what keeps both lamps readable
  // however the player orbits. Babylon points the node's -Z at the viewer, so
  // everything mounted on the face sits at negative z.
  const head = new TransformNode("trafficLight.head", scene);
  head.parent = root;
  const restY = LIGHT.poleHeight + LIGHT.head.height / 2 - 0.5;
  head.position.y = restY;
  head.billboardMode = TransformNode.BILLBOARDMODE_ALL;

  const housing = MeshBuilder.CreateBox(
    "trafficLight.housing",
    { width: LIGHT.head.width, height: LIGHT.head.height, depth: LIGHT.head.depth },
    scene,
  );
  housing.parent = head;
  housing.isPickable = false;
  housing.material = dark;

  const glow = softDot(scene);
  const red = lamp(scene, head, "red", LIGHT.red, LIGHT.lampGap, dark, glow);
  const green = lamp(scene, head, "green", LIGHT.green, -LIGHT.lampGap, dark, glow);

  // Coloured spill on the asphalt. Built up front so the material recompile it
  // forces lands during loading rather than on the player's first click.
  const spill = new PointLight("trafficLight.spill", position.add(new Vector3(0, 2.8, 0)), scene);
  spill.range = LIGHT.spill.range;
  spill.intensity = LIGHT.spill.intensity;
  spill.specular.set(0, 0, 0);
  spill.shadowEnabled = false;

  let isGreen = LIGHT.startsGreen;
  /** Drives the squash-and-stretch pop: 1 right after a switch, decaying to 0. */
  let pop = 0;

  return {
    glowing: [red.box, green.box, red.halo, green.halo],
    isGreen: () => isGreen,
    toggle: () => {
      isGreen = !isGreen;
      pop = 1;
    },
    update: (dt, elapsed) => {
      pop = Math.max(0, pop - dt * 3.2);

      // Overshoot on the way back to rest, so the switch lands with a bounce.
      const spring = Math.sin(pop * Math.PI * 2.2) * pop;
      head.scaling.set(1 - spring * 0.2, 1 + spring * 0.28, 1);
      head.position.y = restY + Math.sin(elapsed * 1.6) * 0.04;

      const breathe = 0.9 + Math.sin(elapsed * 3.2) * 0.1;
      setLamp(red, !isGreen, breathe, pop);
      setLamp(green, isGreen, breathe, pop);

      spill.diffuse = isGreen ? LIGHT.green : LIGHT.red;
      spill.intensity = LIGHT.spill.intensity * breathe;
    },
    dispose: () => {
      spill.dispose();
      root.dispose(false, true);
      glow.dispose();
    },
  };
}

function lamp(
  scene: Scene,
  parent: TransformNode,
  name: string,
  colour: Color3,
  y: number,
  dark: StandardMaterial,
  glow: DynamicTexture,
): Lamp {
  const box = MeshBuilder.CreateBox(
    `trafficLight.${name}`,
    { width: LIGHT.lampSize, height: LIGHT.lampSize, depth: LIGHT.lampSize * 0.5 },
    scene,
  );
  box.parent = parent;
  box.position.set(0, y, -LIGHT.head.depth * 0.7);
  box.isPickable = false;

  // Not frozen: both of these change colour every frame as the lamp breathes.
  const material = unlit(scene, `trafficLight.${name}Mat`, {
    colour: colour.clone(),
    depthWrite: true,
    frozen: false,
  });
  box.material = material;

  // A stubby cartoon visor, so the head reads as a signal and not two stickers.
  const visor = MeshBuilder.CreateBox(
    `trafficLight.${name}Visor`,
    { width: LIGHT.lampSize * 1.3, height: 0.11, depth: LIGHT.lampSize * 0.72 },
    scene,
  );
  visor.parent = parent;
  visor.position.set(0, y + LIGHT.lampSize * 0.62, -LIGHT.head.depth * 1.1);
  visor.isPickable = false;
  visor.material = dark;

  // One halo per lamp rather than one for the whole head: the bloom then sits on
  // whichever lamp is actually lit, which is what makes the state readable.
  const halo = MeshBuilder.CreatePlane(`trafficLight.${name}Halo`, { size: LIGHT.haloSize }, scene);
  halo.parent = parent;
  halo.position.set(0, y, -LIGHT.head.depth * 1.25);
  halo.isPickable = false;

  const haloMaterial = unlit(scene, `trafficLight.${name}HaloMat`, {
    texture: glow,
    glow: true,
    frozen: false,
  });
  halo.material = haloMaterial;

  return { box, material, halo, haloMaterial, colour };
}

function setLamp(lamp: Lamp, on: boolean, breathe: number, pop: number): void {
  // Written into the colours the materials already hold, rather than replacing
  // them: this runs every frame, and a new Color3 twice a frame is litter.
  lamp.colour.scaleToRef(on ? LIGHT.onGlow * breathe : LIGHT.offGlow, lamp.material.emissiveColor);

  // The dark lamp has no halo at all; the lit one flares on each switch.
  const strength = on ? 0.5 * breathe + pop * 0.45 : 0;
  lamp.colour.scaleToRef(strength, lamp.haloMaterial.emissiveColor);
  lamp.halo.isVisible = on;
  lamp.halo.scaling.setAll(0.85 + pop * 0.4);
}

/** Dark moulded plastic: the only lit material in the signal. */
function plastic(scene: Scene, name: string, colour: Color3): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = colour;
  material.specularColor = new Color3(0.1, 0.1, 0.12);
  return material;
}

/** Soft radial falloff, generated rather than downloaded. */
function softDot(scene: Scene): DynamicTexture {
  return radialTexture(
    scene,
    "trafficLight.glow",
    [
      [0, 1],
      [0.3, 0.38],
      [1, 0],
    ],
    undefined,
    1,
    128,
  );
}
