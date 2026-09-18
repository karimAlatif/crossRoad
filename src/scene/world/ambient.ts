import {
  Color3,
  RawCubeTexture,
  SphericalHarmonics,
  SphericalPolynomial,
  Texture,
  Vector3,
  type BaseTexture,
  type Scene,
} from "@babylonjs/core";
import { AMBIENT } from "../config";
import { mobileLift } from "../quality";

/**
 * The light the world itself gives off.
 *
 * Every PBR surface in the city takes most of its light from the environment —
 * the sky overhead, the glow of the city along the horizon, the dark bounce off
 * the asphalt. Without it a night scene collapses to the handful of things that
 * light themselves: windows, signs, headlamps. The buildings glow and the street
 * goes black.
 *
 * This used to be baked by pointing a `ReflectionProbe` at the sky dome, and it
 * was silently broken. Babylon derives the *diffuse* half of an environment —
 * the spherical harmonics every lit surface actually samples — by reading the
 * cube's pixels back off the GPU, and reading back a render target is exactly
 * the kind of operation that works on one driver and returns zeros on the next.
 * Where it returned zeros the harmonics came out zero, the ambient term vanished
 * and the city went dark: the same build, bright on one device and black on
 * another, which is the hardest kind of bug to be told about.
 *
 * So the environment is built here instead, on the CPU, from three colours:
 *
 *   sky      straight up — the night sky itself
 *   horizon  the warm band where a city's lights hit the haze. A flat road's
 *            normal points at the sky, so this and `sky` are what actually make
 *            the streets legible
 *   ground   straight down — what bounces back off the asphalt
 *
 * The cube is tiny (a few kilobytes) and its harmonics are worked out from the
 * same numbers, in JavaScript, before anything is drawn. Nothing is rendered,
 * nothing is read back, and there is no device on which it can come out black.
 */
export function createAmbient(scene: Scene): BaseTexture {
  const { size, sky, horizon, ground, intensity } = AMBIENT;
  const faces: Uint8Array[] = [];

  // The harmonics are accumulated from the same texels that go into the cube, so
  // what a surface receives and what it reflects can never disagree.
  const harmonics = new SphericalHarmonics();
  let solidAngle = 0;

  const direction = new Vector3();
  const colour = new Color3();

  for (let face = 0; face < 6; face++) {
    const pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Texel centre in [-1, 1], then the cube-map direction it stands for.
        const u = (2 * (x + 0.5)) / size - 1;
        const v = 1 - (2 * (y + 0.5)) / size;
        faceDirection(face, u, v, direction);
        const length = direction.length();
        direction.scaleInPlace(1 / length);

        band(direction.y, sky, horizon, ground, colour);

        const at = (y * size + x) * 4;
        pixels[at] = clampByte(colour.r);
        pixels[at + 1] = clampByte(colour.g);
        pixels[at + 2] = clampByte(colour.b);
        pixels[at + 3] = 255;

        // A texel's share of the sphere: its area on the cube face, projected
        // onto the unit sphere. Texels near a face's corners cover less sky than
        // those at its centre, and weighting them equally would tilt the whole
        // ambient towards the corners.
        const share = (2 / size) * (2 / size) / (length * length * length);
        harmonics.addLight(direction, colour, share);
        solidAngle += share;
      }
    }
    faces.push(pixels);
  }

  // Babylon's own cube-to-harmonics conversion ends exactly here: normalise to a
  // full sphere, then take the two steps from incident radiance to the radiance
  // a Lambertian surface re-emits, which is what the shader expects.
  harmonics.scaleInPlace((4 * Math.PI) / solidAngle);
  harmonics.convertIncidentRadianceToIrradiance();
  harmonics.convertIrradianceToLambertianRadiance();

  const cube = new RawCubeTexture(
    scene,
    faces,
    size,
    undefined,
    undefined,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  cube.name = "ambient";
  cube.coordinatesMode = Texture.CUBIC_MODE;
  // The colours above are linear radiance, not sRGB, so the shader must not
  // "correct" them a second time.
  cube.gammaSpace = false;
  cube.sphericalPolynomial = SphericalPolynomial.FromHarmonics(harmonics);

  scene.environmentTexture = cube;
  scene.environmentIntensity = intensity * mobileLift("ambient");
  return cube;
}

/** Sky above, warm haze at eye level, dark bounce below. */
function band(up: number, sky: Color3, horizon: Color3, ground: Color3, into: Color3): void {
  if (up >= 0) {
    // Weighted towards the horizon: the sky only takes over well above it, which
    // is what keeps the warm band wide enough to light a street.
    const t = Math.pow(up, 0.65);
    into.r = horizon.r + (sky.r - horizon.r) * t;
    into.g = horizon.g + (sky.g - horizon.g) * t;
    into.b = horizon.b + (sky.b - horizon.b) * t;
    return;
  }
  const t = Math.pow(-up, 0.5);
  into.r = horizon.r + (ground.r - horizon.r) * t;
  into.g = horizon.g + (ground.g - horizon.g) * t;
  into.b = horizon.b + (ground.b - horizon.b) * t;
}

/** The direction a texel of a cube face points in. Face order is +X −X +Y −Y +Z −Z. */
function faceDirection(face: number, u: number, v: number, into: Vector3): void {
  switch (face) {
    case 0:
      into.set(1, v, -u);
      break;
    case 1:
      into.set(-1, v, u);
      break;
    case 2:
      into.set(u, 1, -v);
      break;
    case 3:
      into.set(u, -1, v);
      break;
    case 4:
      into.set(u, v, 1);
      break;
    default:
      into.set(-u, v, -1);
      break;
  }
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}
