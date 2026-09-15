/** One oversized triangle covers the destination without vertex buffers or shared edges. */
export const fullscreenVertexShader = `#version 300 es
precision highp float;
out vec2 vUv;

void main() {
  const vec2 positions[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  vec2 position = positions[gl_VertexID];
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

/** Blur premultiplied color and alpha together to avoid dark edges around translucent marks. */
export const gaussianFragmentShader = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSource;
uniform vec2 uTexelStep;
uniform float uSigma;
uniform int uRadius;
out vec4 outColor;

vec4 transparentSample(vec2 uv) {
  // CLAMP_TO_EDGE repeats border pixels. Fade its half-texel footprint to transparent
  // instead, so a paired tap that crosses the crop boundary keeps the correct weight.
  vec2 size = vec2(textureSize(uSource, 0));
  vec2 pixel = uv * size;
  vec2 coverage = clamp(pixel + 0.5, 0.0, 1.0) * clamp(size - pixel + 0.5, 0.0, 1.0);
  if (coverage.x == 0.0 || coverage.y == 0.0) return vec4(0.0);
  return texture(uSource, uv) * coverage.x * coverage.y;
}

void main() {
  vec4 color = transparentSample(vUv);
  float totalWeight = 1.0;

  // Pair adjacent taps using the texture's linear interpolation. This halves texture reads
  // while retaining the discrete Gaussian weights for the requested pixel-space sigma.
  for (int offset = 1; offset <= uRadius; offset += 2) {
    float firstDistance = float(offset);
    float secondDistance = float(offset + 1);
    float firstWeight = exp(-0.5 * firstDistance * firstDistance / (uSigma * uSigma));
    float secondWeight = offset + 1 <= uRadius
      ? exp(-0.5 * secondDistance * secondDistance / (uSigma * uSigma)) : 0.0;
    float weight = firstWeight + secondWeight;
    if (weight == 0.0) continue;
    float distance = firstDistance + secondWeight / weight;
    vec2 delta = uTexelStep * distance;
    color += (transparentSample(vUv + delta) + transparentSample(vUv - delta)) * weight;
    totalWeight += 2.0 * weight;
  }
  outColor = color / totalWeight;
}
`;

/** Keep the original sharp source above its halo using premultiplied source-over. */
export const compositeFragmentShader = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSource;
uniform sampler2D uHalo;
uniform float uHaloStrength;
out vec4 outColor;

void main() {
  vec4 source = texture(uSource, vUv);
  vec4 halo = texture(uHalo, vUv) * uHaloStrength;
  outColor = source + halo * (1.0 - source.a);
}
`;
