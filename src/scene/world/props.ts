import {
  Matrix,
  Vector3,
  type AbstractMesh,
  type Node,
  type Scene,
  type TransformNode,
} from "@babylonjs/core";
import { PROPS } from "../config";

export type RoadSpec = {
  name: string;
  start: Vector3;
  end: Vector3;
  /** Stop line. Present on roodTwo only; a road without one never stops. */
  cross: Vector3 | null;
};

export type SceneProps = {
  /**
   * The glTF root node. Babylon parents the whole import under it and scales it
   * (1, 1, -1) to convert handedness, so it is also the space the authored car
   * models live in. Everything the traffic adds is parented here too, which
   * means the marker coordinates below can be used verbatim — no mirroring, no
   * conversions.
   */
  space: TransformNode;
  /** Marker positions, in `space`. */
  trafficLight: Vector3;
  roads: RoadSpec[];
};

/** Reads the authored markers, then hides the placeholder cubes they live on. */
export function readProps(scene: Scene): SceneProps {
  const group = scene.getNodeByName(PROPS.group);
  if (!group) throw new Error(`The .glb has no "${PROPS.group}" group`);

  let space = group as TransformNode;
  while (space.parent) space = space.parent as TransformNode;
  space.computeWorldMatrix(true);
  const toLocal = Matrix.Invert(space.getWorldMatrix());

  const hidden: AbstractMesh[] = [];

  const at = (node: Node): Vector3 => {
    const transform = node as TransformNode;
    transform.computeWorldMatrix(true);
    const mesh = transform as AbstractMesh;
    if (mesh.isVisible !== undefined) hidden.push(mesh);
    return Vector3.TransformCoordinates(transform.getAbsolutePosition(), toLocal);
  };

  const childOf = (parent: Node, name: string): Node => {
    const found = parent.getChildren((node) => node.name === name, true)[0];
    if (!found) throw new Error(`"${parent.name}" has no child named "${name}"`);
    return found;
  };

  const road = (name: string, withCross: boolean): RoadSpec => {
    const node = childOf(group, name);
    return {
      name,
      start: at(childOf(node, PROPS.start)),
      end: at(childOf(node, PROPS.end)),
      cross: withCross ? at(childOf(node, PROPS.cross)) : null,
    };
  };

  const props: SceneProps = {
    space,
    trafficLight: at(childOf(group, PROPS.trafficLight)),
    roads: [road(PROPS.roadOne, false), road(PROPS.roadTwo, true)],
  };

  // The markers are unit cubes. Keep them in the graph — their transforms are
  // the authoring data — but take them off screen.
  for (const mesh of hidden) {
    mesh.isVisible = false;
    mesh.isPickable = false;
  }

  return props;
}
