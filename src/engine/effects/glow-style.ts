/** Match SVG and WebGL Glow in Scene coordinates, before output scaling. */
export const GLOW_STYLE = {
  sigmaScenePixels: 4,
  // Four standard deviations retain more than 99.99% of a one-dimensional Gaussian.
  cutoffStandardDeviations: 4,
} as const;
