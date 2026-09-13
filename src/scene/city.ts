import {
  Color3,
  LoadAssetContainerAsync,
  PBRMaterial,
  Texture,
  Vector3,
  type AbstractMesh,
  type AssetContainer,
  type Node,
  type Scene,
  type TransformNode,
} from "@babylonjs/core";
import {
  ASSET_URL,
  CARS_GROUP,
  CROSSROAD,
  CROSSROAD_MARKERS,
  EMISSIVE_REVIVE,
  EMISSIVE_STRENGTH,
  PROPS,
} from "./config";

export type City = {
  container: AssetContainer;
  /** World-space centre of the intersection the game is played on. */
  crossroad: Vector3;
  /** The `Cars` group, kept hidden — the traffic clones its models. */
  cars: TransformNode | null;
  meshes: AbstractMesh[];
  stats: { meshes: number; vertices: number };
};

export type LoadProgress = (fraction: number | null, label: string) => void;

/**
 * Groups that are not part of the static city: the hidden model library the
 * traffic clones from, and the authored marker cubes.
 *
 * Note on why nothing here is welded together: Babylon's glTF loader already
 * instances this asset. Of the 1572 meshes only 384 carry geometry; the other
 * 1188 are InstancedMesh copies that share it and render through hardware
 * instancing. Merging by material would have to bake every instance into real
 * vertices — roughly tripling the vertex memory and throwing away the
 * instancing — so the draw calls are attacked through the shadow map and the
 * glow layer instead, which is where they are actually multiplied.
 */
const PROTECTED = new Set<string>([CARS_GROUP, PROPS.group]);

/**
 * Streams the city in, dresses it, and only then hands it to the scene.
 *
 * Everything happens on the detached container, so the first frame the player
 * sees is already finished — no pop-in of cars, no flash of unlit materials.
 */
export async function loadCity(scene: Scene, onProgress: LoadProgress): Promise<City> {
  onProgress(0, "Downloading city");

  const container = await LoadAssetContainerAsync(ASSET_URL, scene, {
    onProgress: (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total, "Downloading city");
      } else {
        onProgress(null, "Downloading city");
      }
    },
  });

  onProgress(1, "Dressing materials");
  polishMaterials(container);

  onProgress(1, "Parking the traffic");
  const cars = container.transformNodes.find((node) => node.name === CARS_GROUP) ?? null;
  // The authored traffic stays off screen; it is the model library the live
  // traffic clones from, so it is disabled rather than removed.
  cars?.setEnabled(false);

  onProgress(1, "Building the block");
  container.addAllToScene();

  // Read the junction before anything is merged — the markers it keys off are
  // ordinary city meshes and will be folded away in the next step.
  const crossroad = findCrossroad(scene);

  const meshes = container.meshes.filter(
    (mesh) => mesh.getTotalVertices() > 0 && !isProtected(mesh),
  );

  for (const mesh of meshes) {
    mesh.isPickable = false;
    // freezeWorldMatrix() computes the matrix and world bounds one last time,
    // so it has to run before we stop syncing bounds.
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
  }

  return {
    container,
    crossroad,
    cars,
    meshes,
    stats: {
      meshes: meshes.length,
      vertices: meshes.reduce((total, mesh) => total + mesh.getTotalVertices(), 0),
    },
  };
}

function isProtected(node: Node): boolean {
  for (let current: Node | null = node; current; current = current.parent) {
    if (PROTECTED.has(current.name)) return true;
  }
  return false;
}

/**
 * Unity's glTF exporter writes `emissiveFactor: [0,0,0]` alongside a perfectly
 * good emissive atlas, which multiplies every lit window and neon sign down to
 * black. Putting the factor back is what gives the block its glow — and what
 * the bloom and glow layers then have to work with.
 */
function polishMaterials(container: AssetContainer): void {
  for (const material of container.materials) {
    if (!(material instanceof PBRMaterial)) continue;

    material.ambientColor = Color3.White();
    material.maxSimultaneousLights = 6;

    if (material.emissiveTexture) {
      material.emissiveColor = EMISSIVE_REVIVE;
      material.emissiveIntensity = EMISSIVE_STRENGTH;
    }

    // Billboards light themselves up: the ad atlas doubles as its own emissive.
    if (material.name === "Billboard_Mat" && material.albedoTexture) {
      material.emissiveTexture = material.albedoTexture;
      material.emissiveColor = new Color3(0.45, 0.45, 0.45);
      material.emissiveIntensity = 1;
    }

    // Glass reads as a flat grey plane straight out of the exporter. Making it
    // properly reflective is what sells the sky in the tower windows.
    if (material.name.includes("Glass")) {
      material.metallic = 0.85;
      material.roughness = 0.06;
      material.useRadianceOverAlpha = true;
      material.useSpecularOverAlpha = true;
      material.backFaceCulling = true;
    }

    // Textures are a stylised atlas: crisp mips keep the road lines readable at
    // a glancing angle without shimmering.
    for (const texture of material.getActiveTextures()) {
      if (texture instanceof Texture) {
        texture.anisotropicFilteringLevel = 8;
        texture.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);
      }
    }
  }
}

/**
 * Locates the junction from the four pedestrian crossing poles that stand at
 * its corners, so the framing follows the asset rather than a magic number.
 */
function findCrossroad(scene: Scene): Vector3 {
  for (const marker of CROSSROAD_MARKERS) {
    const corners = scene.meshes.filter(
      (mesh) => mesh.name.startsWith(marker) && mesh.getTotalVertices() > 0,
    );
    if (corners.length < 2) continue;

    const centre = corners.reduce(
      (sum, mesh) => sum.addInPlace(mesh.getBoundingInfo().boundingBox.centerWorld),
      Vector3.Zero(),
    );
    return centre.scaleInPlace(1 / corners.length).multiplyByFloats(1, 0, 1);
  }
  return CROSSROAD.clone();
}
