/* Whole-page nebula background.

   This is a real fluid solver, not animated noise. Each frame advects a velocity field,
   makes it divergence-free with a Jacobi pressure solve (Stam, "Stable Fluids"), and
   carries a density field along for the ride. That matters for one reason: the cursor is
   a genuine no-slip obstacle inside the solve, so gas piles up in front of it, accelerates
   around the flanks, and sheds a turbulent wake behind. None of that is hand-animated.

   The solve runs at a fraction of display resolution and stays cheap; the visible detail
   comes from the display pass, which warps high-frequency noise by the solved velocity.
   Returns null when WebGL2 or float render targets are unavailable, and the hero starfield
   in script.js takes over instead. */

const VERTEX = `#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos * .5 + .5; gl_Position = vec4(a_pos, 0., 1.); }`;

/* Simplex noise (Ashima/Gustavson), plus the fbm both the source clouds and the
   display detail are built from. Shared by every fragment stage that needs structure. */
const NOISE = `
vec2 mod289(vec2 x) { return x - floor(x * (1. / 289.)) * 289.; }
vec3 mod289(vec3 x) { return x - floor(x * (1. / 289.)) * 289.; }
vec3 permute(vec3 x) { return mod289(((x * 34.) + 1.) * x); }
float snoise(vec2 v) {
  const vec4 C = vec4(.211324865405187, .366025403784439, -.577350269189626, .024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1., 0.) : vec2(0., 1.);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0., i1.y, 1.)) + i.x + vec3(0., i1.x, 1.));
  vec3 m = max(.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.);
  m = m * m; m = m * m;
  vec3 x = 2. * fract(p * C.www) - 1.;
  vec3 h = abs(x) - .5;
  vec3 a0 = x - floor(x + .5);
  m *= 1.79284291400159 - .85373472095314 * (a0 * a0 + h * h);
  vec3 g = vec3(a0.x * x0.x + h.x * x0.y, a0.yz * x12.xz + h.yz * x12.yw);
  return 130. * dot(m, g);
}
/* Each octave wanders on its own heading, so the field boils and reshapes over time
   without the whole pattern sliding in one direction of its own. Anything with a net
   heading here would fight the wind that carries the gas. */
float fbm(vec2 p, int octaves, float drift) {
  float amplitude = .5, sum = 0., norm = 0.;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    float turn = float(i) * 2.399;
    sum += amplitude * snoise(p + vec2(cos(turn), sin(turn)) * drift * .06);
    norm += amplitude;
    p *= 2.03;
    amplitude *= .5;
  }
  return sum / norm;
}`;

/* The obstacle. u_pointerActive goes to zero for touch input and when the pointer leaves
   the page, so the gas closes back over the hole rather than freezing around a ghost. */
const SOLID = `
uniform vec2 u_pointer;
uniform vec2 u_pointerVelocity;
uniform float u_pointerRadius;
uniform float u_pointerActive;
uniform float u_aspect;
float solidAt(vec2 uv) {
  if (u_pointerActive < .5) return 0.;
  return step(length((uv - u_pointer) * vec2(u_aspect, 1.)), u_pointerRadius);
}
float solidSoft(vec2 uv) {
  if (u_pointerActive < .5) return 0.;
  float d = length((uv - u_pointer) * vec2(u_aspect, 1.));
  return 1. - smoothstep(u_pointerRadius * .74, u_pointerRadius * 1.06, d);
}`;

/* Everything the eye reads as "the gas" - the source clouds, the display wisps, the
   eddy field - is sampled in a frame that travels with the wind at u_drift. Sampling in
   a fixed frame instead is what makes a pattern appear to march upstream while the
   particles ride downstream, since the particles follow the velocity field directly. */
const STREAM = `
uniform vec2 u_drift;
uniform float u_time;
vec2 streamSpace(vec2 uv, float aspect) {
  return vec2(uv.x * aspect, uv.y) - vec2(u_drift.x * aspect, u_drift.y) * u_time;
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 fragColor;`;

/* Semi-Lagrangian advection. Velocity is carried in velocity-grid texels per second, so
   the same backtrace works for the lower-resolution velocity field and the finer dye. */
const ADVECT = `${HEAD}
uniform sampler2D u_source;
uniform sampler2D u_velocity;
uniform vec2 u_velocityTexel;
uniform float u_dt;
uniform float u_dissipation;
void main() {
  vec2 back = v_uv - u_dt * texture(u_velocity, v_uv).xy * u_velocityTexel;
  fragColor = texture(u_source, back) * u_dissipation;
}`;

/* Wind plus curl noise. The relaxation is deliberately weak: it sets the long-term drift
   without flattening the vortices the solver produces on its own. */
const FORCES = `${HEAD}
${NOISE}
${STREAM}
uniform sampler2D u_velocity;
uniform vec2 u_wind;
uniform float u_stir;
uniform float u_relax;
uniform float u_dt;
uniform float u_aspect;
float potential(vec2 p) { return fbm(p, 4, u_time * .35); }
void main() {
  vec2 p = streamSpace(v_uv, u_aspect) * 1.7;
  const float e = .05;
  float dx = potential(p + vec2(e, 0.)) - potential(p - vec2(e, 0.));
  float dy = potential(p + vec2(0., e)) - potential(p - vec2(0., e));
  vec2 target = u_wind + vec2(dy, -dx) / (2. * e) * u_stir;
  vec2 velocity = texture(u_velocity, v_uv).xy;
  fragColor = vec4(mix(velocity, target, 1. - exp(-u_relax * u_dt)), 0., 1.);
}`;

/* Neighbours inside the obstacle contribute the obstacle's own velocity, which is what
   makes the solve treat the cursor as a moving solid rather than empty space. */
const DIVERGENCE = `${HEAD}
${SOLID}
uniform sampler2D u_velocity;
uniform vec2 u_texel;
vec2 sampleVelocity(vec2 uv) {
  return mix(texture(u_velocity, uv).xy, u_pointerVelocity, solidAt(uv));
}
void main() {
  float l = sampleVelocity(v_uv - vec2(u_texel.x, 0.)).x;
  float r = sampleVelocity(v_uv + vec2(u_texel.x, 0.)).x;
  float b = sampleVelocity(v_uv - vec2(0., u_texel.y)).y;
  float t = sampleVelocity(v_uv + vec2(0., u_texel.y)).y;
  fragColor = vec4(.5 * ((r - l) + (t - b)) * (1. - solidAt(v_uv)), 0., 0., 1.);
}`;

/* Jacobi iteration. A solid neighbour reflects the centre pressure back, the Neumann
   condition that stops flow passing through the obstacle. */
const PRESSURE = `${HEAD}
${SOLID}
uniform sampler2D u_pressure;
uniform sampler2D u_divergence;
uniform vec2 u_texel;
float samplePressure(vec2 uv, float centre) {
  return mix(texture(u_pressure, uv).x, centre, solidAt(uv));
}
void main() {
  float c = texture(u_pressure, v_uv).x;
  float l = samplePressure(v_uv - vec2(u_texel.x, 0.), c);
  float r = samplePressure(v_uv + vec2(u_texel.x, 0.), c);
  float b = samplePressure(v_uv - vec2(0., u_texel.y), c);
  float t = samplePressure(v_uv + vec2(0., u_texel.y), c);
  fragColor = vec4((l + r + b + t - texture(u_divergence, v_uv).x) * .25, 0., 0., 1.);
}`;

const GRADIENT = `${HEAD}
${SOLID}
uniform sampler2D u_pressure;
uniform sampler2D u_velocity;
uniform vec2 u_texel;
float samplePressure(vec2 uv, float centre) {
  return mix(texture(u_pressure, uv).x, centre, solidAt(uv));
}
void main() {
  float c = texture(u_pressure, v_uv).x;
  float l = samplePressure(v_uv - vec2(u_texel.x, 0.), c);
  float r = samplePressure(v_uv + vec2(u_texel.x, 0.), c);
  float b = samplePressure(v_uv - vec2(0., u_texel.y), c);
  float t = samplePressure(v_uv + vec2(0., u_texel.y), c);
  vec2 velocity = texture(u_velocity, v_uv).xy - .5 * vec2(r - l, t - b);
  fragColor = vec4(mix(velocity, u_pointerVelocity, solidAt(v_uv)), 0., 1.);
}`;

/* Density advection and its source in one pass. The source keeps re-seeding structure;
   without it the field smears to an even haze within about twenty seconds. Its noise
   drifts a little slower than the wind so the gas reads as moving through the clouds.
   Green carries a hue weight (blue to violet) that travels with the gas it belongs to. */
const DYE = `${HEAD}
${NOISE}
${SOLID}
${STREAM}
uniform sampler2D u_source;
uniform sampler2D u_velocity;
uniform vec2 u_velocityTexel;
uniform float u_dt;
uniform float u_dissipation;
uniform float u_feed;
void main() {
  vec2 back = v_uv - u_dt * texture(u_velocity, v_uv).xy * u_velocityTexel;
  vec2 dye = texture(u_source, back).xy * u_dissipation;

  vec2 p = streamSpace(v_uv, u_aspect) * 1.45;
  /* Squaring the cloud mask, and creasing it with a ridged octave, is what separates
     bright arms from genuine voids. A plain fbm alone reads as even fog. */
  float clouds = smoothstep(.38, .9, fbm(p, 5, u_time) * .5 + .5);
  clouds *= clouds * (.4 + .85 * pow(1. - abs(fbm(p * 2.15 + 17.3, 4, u_time)), 2.2));
  /* A very low frequency mask on top. Nebulae are not evenly seeded: they have whole
     bright complexes and whole empty stretches, and that scale separation is a large
     part of what makes one read as deep space rather than as a sheet of smoke. */
  clouds *= .1 + 1.9 * smoothstep(.28, .88, fbm(p * .3 + 61.2, 3, u_time * .4) * .5 + .5);
  float hue = clamp(fbm(p * .55 + 31.4, 2, u_time * .5) * .5 + .5, 0., 1.);
  /* A gentle lean toward the left, where the hero mark sits, keeps the right-hand
     column (which carries most of the page's body copy) calmer. */
  clouds *= mix(1., .5, smoothstep(.12, .92, v_uv.x));

  float added = u_dt * u_feed * clouds;
  float total = dye.x + added;
  fragColor = vec4(
    min(total, 1.7) * (1. - .88 * solidSoft(v_uv)),
    total > 1e-5 ? (dye.y * dye.x + hue * added) / total : hue,
    0., 1.);
}`;

/* Display. The solve is coarse, so the fine wisps come from noise sampled at a position
   warped by the solved velocity - the detail then moves with the gas instead of sitting
   on top of it. Output is premultiplied so the page background shows through. */
const DISPLAY = `${HEAD}
${NOISE}
${STREAM}
uniform sampler2D u_dye;
uniform sampler2D u_velocity;
uniform vec2 u_velocityTexel;
uniform vec2 u_dyeTexel;
uniform float u_aspect;
uniform float u_opacity;
uniform float u_warp;
void main() {
  vec2 dye = texture(u_dye, v_uv).xy;
  float raw = dye.x;

  /* A wide four-tap ring: a cheap stand-in for a bloom pass. Bright complexes bleed a
     halo into the surrounding dark, which is how emission actually photographs. */
  float glow = 0.;
  for (int i = 0; i < 4; i++) {
    float turn = float(i) * 1.5708 + .7854;
    glow += texture(u_dye, v_uv + vec2(cos(turn), sin(turn)) * u_dyeTexel * 12.).x;
  }
  glow *= .25;

  if (raw < .004 && glow < .01) { fragColor = vec4(0.); return; }

  /* Ionisation fronts. Where the density gradient is steep the gas is being lit from
     one side, and that bright rim is the signature edge of an emission nebula. A field
     shaded only by its own density reads as soft smoke instead. */
  float dl = texture(u_dye, v_uv - vec2(u_dyeTexel.x, 0.)).x;
  float dr = texture(u_dye, v_uv + vec2(u_dyeTexel.x, 0.)).x;
  float db = texture(u_dye, v_uv - vec2(0., u_dyeTexel.y)).x;
  float dt = texture(u_dye, v_uv + vec2(0., u_dyeTexel.y)).x;
  float rim = smoothstep(.015, .13, length(vec2(dr - dl, dt - db))) * smoothstep(.04, .28, raw);

  vec2 velocity = texture(u_velocity, v_uv).xy * u_velocityTexel;
  vec2 p = streamSpace(v_uv, u_aspect) + vec2(velocity.x * u_aspect, velocity.y) * u_warp;

  float density = raw;
  density *= .3 + 1.55 * (fbm(p * 7.5, 3, u_time) * .5 + .5);
  /* A ridged octave: sharp crests, soft troughs. This is where the wisps come from.
     It shares p with the layer above so the two never shear against each other. */
  density *= .5 + .92 * pow(1. - abs(snoise(p * 19.)), 1.9);
  density += rim * .55;

  /* Dark nebulae. Cold dust sits in front of the emission and blocks it, carving the
     winding opaque lanes that cut across every real nebula. Ridged noise peaks along
     its own zero crossings, which gives lanes rather than blobs. */
  float dust = pow(1. - abs(fbm(p * 2.6 + 44.7, 3, u_time * .7)), 3.6);
  dust *= smoothstep(.03, .35, raw);
  density *= 1. - .88 * dust;

  /* Thin outskirts run cooler and denser cores run violet, then white where the gas is
     hottest - the same spread of ionisation states a real nebula shows. */
  vec3 colour = mix(vec3(.28, .5, .95), vec3(.408, .396, .98), smoothstep(0., .38, density));
  colour = mix(colour, vec3(.706, .463, .984), smoothstep(.26, .82, density) * (.35 + .65 * dye.y));
  colour = mix(colour, vec3(.925, .871, 1.), smoothstep(.8, 1.45, density));

  /* Clamping density to 1 flattened every bright complex into one opaque value and
     threw away all the filament detail inside it. An exponential rolloff saturates
     gently instead, so structure survives right through the brightest cores. */
  float alpha = (1. - exp(-pow(max(density, 0.), 1.8) * 2.8)) * u_opacity;
  /* Bloom belongs outside a cloud, not on top of it. Gated on low local density it
     reads as light bleeding into the surrounding dark; ungated it just washes the
     bright regions flat. */
  alpha += pow(clamp(glow, 0., 1.), 1.9) * .18 * u_opacity * (1. - dust)
    * smoothstep(.5, .05, raw);
  alpha *= 1. - .34 * smoothstep(.5, 1.05, length((v_uv - .5) * vec2(u_aspect * .8, 1.)));
  alpha = clamp(alpha, 0., 1.);
  fragColor = vec4(colour * alpha, alpha);
}`;

/* Stars. Fixed to the sky, never advected - the single strongest cue that this is deep
   space and not a smoke tank. They are drawn before the gas so that dense clouds veil
   the stars behind them, which is what gives the field real depth. Brightness follows a
   steep power law: mostly faint pinpricks, a handful of bright ones carrying spikes. */
const STAR_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_params;
uniform float u_pointScale;
out float v_lum;
out float v_temp;
out float v_spike;
void main() {
  gl_Position = vec4(a_position * 2. - 1., 0., 1.);
  float lum = pow(a_params.x, 3.4);
  v_lum = lum;
  v_temp = a_params.y;
  v_spike = smoothstep(.94, 1., a_params.x);
  gl_PointSize = (1.15 + lum * 11.) * u_pointScale;
}`;

const STAR_FRAGMENT = `#version 300 es
precision highp float;
in float v_lum;
in float v_temp;
in float v_spike;
out vec4 fragColor;
uniform float u_opacity;
void main() {
  vec2 offset = gl_PointCoord * 2. - 1.;
  float r = length(offset);
  if (r > 1.) discard;
  float fade = max(1. - r, 0.);
  float core = pow(fade, 7.);
  float halo = pow(fade, 1.7) * .3;
  float spikes = v_spike * fade
    * (pow(max(0., 1. - abs(offset.x) * 11.), 3.) + pow(max(0., 1. - abs(offset.y) * 11.), 3.)) * .45;
  float intensity = (core + halo + spikes) * v_lum * u_opacity;
  vec3 colour = mix(vec3(.6, .71, 1.), vec3(1., .93, .85), v_temp);
  colour = mix(colour, vec3(1.), core * .75);
  fragColor = vec4(colour * intensity, intensity);
}`;

/* Dust. Positions live in a float texture and are advected by the same velocity field the
   gas uses, so the motes genuinely ride the flow rather than drifting independently.
   Each carries a life so the population reshuffles instead of collecting in slow corners. */
const PARTICLE_STEP = `${HEAD}
${SOLID}
uniform sampler2D u_particles;
uniform sampler2D u_velocity;
uniform vec2 u_velocityTexel;
uniform float u_dt;
uniform float u_speed;
uniform float u_time;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
void main() {
  vec4 particle = texture(u_particles, v_uv);
  vec2 position = particle.xy;
  float life = particle.z - u_dt * (.028 + hash(vec2(particle.w, 3.7)) * .05);

  position += texture(u_velocity, position).xy * u_velocityTexel * u_dt * u_speed;

  /* Motes are deflected out of the obstacle rather than snapped to its edge. Snapping
     packs them into a bright ring that stays behind after the cursor moves on. */
  vec2 offset = (position - u_pointer) * vec2(u_aspect, 1.);
  float distance = length(offset);
  if (u_pointerActive > .5 && distance < u_pointerRadius) {
    vec2 away = offset / max(distance, 1e-4) / vec2(u_aspect, 1.);
    position += away * (u_pointerRadius - distance) * min(u_dt * 6., 1.);
  }

  if (life <= 0.) {
    float seed = u_time + particle.w;
    position = vec2(hash(vec2(seed, 1.3)), hash(vec2(seed, 7.9)));
    life = 1.;
  }
  fragColor = vec4(fract(position), life, particle.w);
}`;

const PARTICLE_VERTEX = `#version 300 es
precision highp float;
uniform sampler2D u_particles;
uniform float u_pointScale;
out float v_alpha;
out float v_seed;
void main() {
  int side = textureSize(u_particles, 0).x;
  vec4 particle = texelFetch(u_particles, ivec2(gl_VertexID % side, gl_VertexID / side), 0);
  gl_Position = vec4(particle.xy * 2. - 1., 0., 1.);
  gl_PointSize = (.5 + fract(particle.w * 7.31) * 1.15) * u_pointScale;
  v_alpha = smoothstep(0., .14, particle.z) * (1. - smoothstep(.86, 1., particle.z))
    * (.3 + .7 * fract(particle.w * 3.17));
  v_seed = particle.w;
}`;

const PARTICLE_FRAGMENT = `#version 300 es
precision highp float;
in float v_alpha;
in float v_seed;
out vec4 fragColor;
uniform float u_opacity;
void main() {
  vec2 offset = gl_PointCoord * 2. - 1.;
  float r = dot(offset, offset);
  if (r > 1.) discard;
  float alpha = pow(1. - r, 2.4) * v_alpha * u_opacity;
  vec3 colour = mix(vec3(.45, .53, 1.), vec3(.79, .61, 1.), fract(v_seed * 11.7));
  fragColor = vec4(colour * alpha, alpha);
}`;

/* ---------------------------------------------------------------------------
   The volumetric layer.

   The 2D solver above is a sheet: you can watch it flow but you cannot travel
   into it. Depth needs an actual 3D density field, so this bakes one into a
   tiling 3D texture once at startup and raymarches it from a camera that scroll
   drives forward. Sampling a baked texture with hardware trilinear filtering
   rather than evaluating noise analytically at every step is what brings a
   volumetric march into budget at all - it is roughly an order of magnitude
   cheaper, and the cost is one 3.5MB texture.

   A nebula emits its own light rather than being lit from outside, so this is a
   pure emission-absorption march. That skips the secondary shadow rays ordinary
   cloud rendering needs, and it happens to be the physically correct model.
--------------------------------------------------------------------------- */

/* Periodic gradient noise. The lattice hash wraps at `period`, so every octave
   tiles across the texture and the volume repeats seamlessly however far the
   camera travels through it. */
const PERIODIC_NOISE = `
vec3 hashGrad(vec3 cell, float period) {
  cell = mod(cell, vec3(period));
  float a = fract(sin(dot(cell, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
  float b = fract(sin(dot(cell, vec3(269.5, 183.3, 246.1))) * 43758.5453123);
  float theta = a * 6.2831853;
  float z = b * 2. - 1.;
  float r = sqrt(max(0., 1. - z * z));
  return vec3(r * cos(theta), r * sin(theta), z);
}
float pnoise(vec3 p, float period) {
  vec3 i = floor(p), f = p - i;
  vec3 u = f * f * f * (f * (f * 6. - 15.) + 10.);
  return mix(
    mix(mix(dot(hashGrad(i, period), f),
            dot(hashGrad(i + vec3(1, 0, 0), period), f - vec3(1, 0, 0)), u.x),
        mix(dot(hashGrad(i + vec3(0, 1, 0), period), f - vec3(0, 1, 0)),
            dot(hashGrad(i + vec3(1, 1, 0), period), f - vec3(1, 1, 0)), u.x), u.y),
    mix(mix(dot(hashGrad(i + vec3(0, 0, 1), period), f - vec3(0, 0, 1)),
            dot(hashGrad(i + vec3(1, 0, 1), period), f - vec3(1, 0, 1)), u.x),
        mix(dot(hashGrad(i + vec3(0, 1, 1), period), f - vec3(0, 1, 1)),
            dot(hashGrad(i + vec3(1, 1, 1), period), f - vec3(1, 1, 1)), u.x), u.y),
    u.z);
}
float pfbm(vec3 p, float period, int octaves) {
  float amplitude = .5, sum = 0., norm = 0.;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    float scale = exp2(float(i));
    sum += amplitude * pnoise(p * scale, period * scale);
    norm += amplitude;
    amplitude *= .5;
  }
  return sum / norm;
}`;

/* Baked one slice at a time into a 3D texture. Four channels at rising
   frequencies: broad shape, two erosion bands, and a ridged channel for dust. */
const VOLUME_BAKE = `${HEAD}
${PERIODIC_NOISE}
uniform float u_slice;
void main() {
  vec3 q = vec3(v_uv, u_slice);
  fragColor = vec4(
    pfbm(q * 3., 3., 4) * .5 + .5,
    pfbm(q * 6. + 11.3, 6., 3) * .5 + .5,
    pfbm(q * 12. + 27.7, 12., 2) * .5 + .5,
    1. - abs(pfbm(q * 5. + 41.1, 5., 3)));
}`;

const VOLUME_MARCH = `${HEAD}
precision highp sampler3D;
uniform sampler3D u_volume;
uniform vec3 u_camera;
uniform float u_aspect;
uniform float u_fov;
uniform float u_near;
uniform float u_far;
uniform float u_steps;
uniform float u_density;
uniform float u_emission;
uniform float u_threshold;
uniform float u_opacity;
uniform float u_time;

/* Broad complexes inside an even broader region mask, then eroded by the higher
   frequency bands. The mask is a hard gate rather than a multiplier: outside a
   complex there is genuinely nothing, which is what leaves the empty space a
   nebula needs. Scaling material down instead just yields uniform haze. */
float shapeAt(vec3 p) {
  float mask = smoothstep(.46, .74, texture(u_volume, p * .019 + 13.7).r);
  if (mask < .01) return 0.;
  float d = smoothstep(u_threshold, .92, texture(u_volume, p * .058).r) * mask;
  if (d <= 0.) return 0.;
  vec4 fine = texture(u_volume, p * .17 + 3.1);
  d -= (1. - fine.g) * .35 * d;
  d -= (1. - fine.b) * .2 * d;
  return max(d, 0.);
}

void main() {
  vec2 ndc = (v_uv * 2. - 1.) * vec2(u_aspect, 1.);
  vec3 rd = normalize(vec3(ndc * u_fov, 1.));
  float stepSize = (u_far - u_near) / u_steps;
  /* Per-pixel jitter on the first step. Without it the fixed sample spacing
     lays visible shells across the whole image. */
  float jitter = fract(sin(dot(v_uv, vec2(12.9898, 78.233)) + u_time * .37) * 43758.5453);
  float t = u_near + jitter * stepSize;

  vec3 accum = vec3(0.);
  float transmittance = 1.;
  for (int i = 0; i < 72; i++) {
    if (float(i) >= u_steps || transmittance < .02) break;
    vec3 p = u_camera + rd * t;
    float d = shapeAt(p);
    if (d > .003) {
      vec4 v = texture(u_volume, p * .042 + 31.1);
      float dust = smoothstep(.74, .97, v.a);
      dust *= dust;
      vec3 colour = mix(vec3(.28, .5, .95), vec3(.42, .4, .98), smoothstep(0., .3, d));
      colour = mix(colour, vec3(.71, .46, .98), smoothstep(.22, .72, d) * (.3 + .7 * v.g));
      colour = mix(colour, vec3(.93, .87, 1.), smoothstep(.7, 1.2, d));
      float sigma = d * u_density * stepSize;
      /* Dust absorbs without emitting, so it silhouettes against the glow behind
         it exactly the way a dark nebula does. */
      accum += colour * sigma * transmittance * u_emission * (1. - dust * .82);
      transmittance *= exp(-sigma * (1. + dust * 2.2));
      t += stepSize;
    } else {
      t += stepSize * 2.;
    }
  }
  float alpha = (1. - transmittance) * u_opacity;
  fragColor = vec4(accum * u_opacity, alpha);
}`;

const BLIT = `${HEAD}
uniform sampler2D u_source;
void main() { fragColor = texture(u_source, v_uv); }`;

/* Near stars, carried in perspective. Each holds a fixed screen target and a
   phase through a depth slab; as the camera advances they sweep outward and
   recycle at the far plane. This is the cue that reads as flight - far more of
   it comes from the stars than from the gas. */
const FLY_STAR_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_star;
layout(location = 1) in vec2 a_params;
uniform vec3 u_camera;
uniform float u_aspect;
uniform float u_pointScale;
uniform float u_depth;
uniform float u_near;
uniform float u_ref;
uniform float u_flow;
uniform float u_parallax;
out float v_lum;
out float v_temp;
out float v_spike;
void main() {
  float z = mod(a_star.z * u_depth - u_camera.z * u_flow, u_depth) + u_near;
  vec2 screen = (a_star.xy * u_ref - u_camera.xy * u_parallax) / z;
  gl_Position = vec4(screen / vec2(u_aspect, 1.), 0., 1.);
  float closeness = min(u_ref / z, 3.);
  float band = (z - u_near) / u_depth;
  float lum = pow(a_params.x, 3.2) * closeness
    * smoothstep(1., .8, band) * smoothstep(0., .1, band);
  v_lum = lum;
  v_temp = a_params.y;
  v_spike = smoothstep(.93, 1., a_params.x);
  gl_PointSize = (1.1 + pow(a_params.x, 3.2) * 10. * closeness) * u_pointScale;
}`;

/* Three tiers. The page starts on the one its hardware suggests and steps down on its own
   if frames are consistently slow - a background is never worth a stuttering scroll. */
const TIERS = [
  { velocityDivisor: 5, dyeDivisor: 3, iterations: 18, pixelBudget: 2.2e6, particles: 4096,
    volumeDivisor: 3, volumeSteps: 46 },
  { velocityDivisor: 7, dyeDivisor: 4, iterations: 12, pixelBudget: 1.3e6, particles: 2500,
    volumeDivisor: 4, volumeSteps: 32 },
  { velocityDivisor: 10, dyeDivisor: 6, iterations: 8, pixelBudget: 7.5e5, particles: 1300,
    volumeDivisor: 5, volumeSteps: 20 },
];

const VOLUME_SIZE = 96;

/* The flight path is generated from whatever sections carry data-vantage, read in
   document order, rather than kept as a hardcoded list. Sections can be added,
   removed, reordered or renamed and the journey re-choreographs itself; a fixed
   list keyed to CSS selectors would silently skip a section the day one of those
   selectors changed. Any stop can still be art-directed with data-vantage-x and
   friends when the generated one is not what a section wants. */
function planFlight() {
  const sections = [...document.querySelectorAll('[data-vantage]')];
  const last = Math.max(sections.length - 1, 1);
  return sections.map((element, index) => {
    const journey = index / last;
    /* A golden-angle spiral outward from the origin. Every stop is somewhere the
       camera has not been, at any section count, and the first one is always the
       centre so the page opens on a settled view. */
    const angle = index * 2.39996;
    const radius = 4.4 * Math.sqrt(journey);
    const data = element.dataset;
    return {
      element,
      x: Number(data.vantageX ?? Math.cos(angle) * radius),
      y: Number(data.vantageY ?? Math.sin(angle) * radius * .72),
      /* Later stops run thinner. The copy gets denser as the page goes on, so the
         gas has to get out of its way. */
      density: Number(data.vantageDensity ?? 1.4 - journey * .62),
      threshold: Number(data.vantageThreshold ?? .47 + journey * .13),
      opacity: Number(data.vantageOpacity ?? 1 - journey * .38),
    };
  });
}

/* How far the camera travels through the volume across the whole page. The
   field repeats every ~17 units at the shape frequency, so staying under that
   keeps the journey from visibly looping back on itself. */
const TRAVEL = 15;

export function startNebula(canvas) {
  if (!canvas) return null;
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    powerPreference: 'low-power',
  });
  if (!gl) return null;

  const fullFloat = gl.getExtension('EXT_color_buffer_float');
  if (!fullFloat && !gl.getExtension('EXT_color_buffer_half_float')) return null;

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }
  function build(vertexSource, fragmentSource) {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    const uniforms = new Map();
    return {
      program,
      location(name) {
        if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(program, name));
        return uniforms.get(name);
      },
    };
  }

  let programs;
  try {
    programs = {
      advect: build(VERTEX, ADVECT),
      forces: build(VERTEX, FORCES),
      divergence: build(VERTEX, DIVERGENCE),
      pressure: build(VERTEX, PRESSURE),
      gradient: build(VERTEX, GRADIENT),
      dye: build(VERTEX, DYE),
      display: build(VERTEX, DISPLAY),
      particleStep: build(VERTEX, PARTICLE_STEP),
      particleDraw: build(PARTICLE_VERTEX, PARTICLE_FRAGMENT),
      stars: build(STAR_VERTEX, STAR_FRAGMENT),
      flyStars: build(FLY_STAR_VERTEX, STAR_FRAGMENT),
      volumeBake: build(VERTEX, VOLUME_BAKE),
      volumeMarch: build(VERTEX, VOLUME_MARCH),
      blit: build(VERTEX, BLIT),
    };
  } catch (error) {
    console.warn('Nebula background unavailable:', error.message);
    return null;
  }

  const quad = gl.createVertexArray();
  gl.bindVertexArray(quad);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  const pointVao = gl.createVertexArray();

  /* Two star layers. Perspective stars bunch toward the vanishing point as they
     recycle, which is correct but leaves the edges thin, so a flat distant sky
     underneath guarantees even coverage. It is also the honest arrangement:
     stars far enough away really do not parallax. */
  const SKY_COUNT = 1500;
  const skyVao = gl.createVertexArray();
  gl.bindVertexArray(skyVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  const skyData = new Float32Array(SKY_COUNT * 4);
  for (let i = 0; i < SKY_COUNT; i++) {
    skyData[i * 4] = Math.random();
    skyData[i * 4 + 1] = Math.random();
    skyData[i * 4 + 2] = Math.random();
    skyData[i * 4 + 3] = Math.random();
  }
  gl.bufferData(gl.ARRAY_BUFFER, skyData, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

  const FLY_COUNT = 1100;
  const flyVao = gl.createVertexArray();
  gl.bindVertexArray(flyVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  const flyData = new Float32Array(FLY_COUNT * 5);
  for (let i = 0; i < FLY_COUNT; i++) {
    flyData[i * 5] = (Math.random() * 2 - 1) * 1.45;
    flyData[i * 5 + 1] = (Math.random() * 2 - 1) * 1.45;
    flyData[i * 5 + 2] = Math.random();
    flyData[i * 5 + 3] = Math.random();
    flyData[i * 5 + 4] = Math.random();
  }
  gl.bufferData(gl.ARRAY_BUFFER, flyData, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
  gl.bindVertexArray(null);

  /* Baked once. Rendering slice by slice on the GPU keeps a 96-cubed volume
     under a few milliseconds; generating the same field in JavaScript would
     stall the main thread for hundreds. */
  function bakeVolume() {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, VOLUME_SIZE, VOLUME_SIZE, VOLUME_SIZE,
      0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, VOLUME_SIZE, VOLUME_SIZE);
    gl.disable(gl.BLEND);
    gl.useProgram(programs.volumeBake.program);
    for (let layer = 0; layer < VOLUME_SIZE; layer++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, texture, 0, layer);
      set(programs.volumeBake, 'u_slice', (layer + .5) / VOLUME_SIZE);
      draw();
    }
    gl.deleteFramebuffer(framebuffer);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return texture;
  }

  function makeTarget(width, height, internalFormat, format, type, filter) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { texture, framebuffer, width, height, texel: [1 / width, 1 / height] };
  }
  function makePair(width, height, internalFormat, format, type, filter) {
    return {
      read: makeTarget(width, height, internalFormat, format, type, filter),
      write: makeTarget(width, height, internalFormat, format, type, filter),
      swap() { const held = this.read; this.read = this.write; this.write = held; },
    };
  }
  function dispose(target) {
    if (!target) return;
    if (target.read) { dispose(target.read); dispose(target.write); return; }
    gl.deleteTexture(target.texture);
    gl.deleteFramebuffer(target.framebuffer);
  }

  const coarse = matchMedia('(pointer: coarse)').matches;
  const stillMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let tierIndex = coarse || (navigator.hardwareConcurrency || 8) <= 4 ? 2 : 0;
  let tier = TIERS[tierIndex];

  let velocity;
  let pressure;
  let divergence;
  let dyeField;
  let particles;
  let volumeTarget;
  let volumeTexture = null;
  let particleCount = 0;
  let width = 0;
  let height = 0;
  let aspect = 1;
  let started = false;

  function allocate() {
    const cssWidth = Math.max(window.innerWidth, 1);
    const cssHeight = Math.max(window.innerHeight, 1);
    aspect = cssWidth / cssHeight;
    const ratio = Math.min(devicePixelRatio || 1, 1.75);
    const scale = Math.min(ratio, Math.sqrt(tier.pixelBudget / (cssWidth * cssHeight)));
    width = Math.max(Math.round(cssWidth * scale), 2);
    height = Math.max(Math.round(cssHeight * scale), 2);
    canvas.width = width;
    canvas.height = height;

    const vw = Math.max(Math.round(cssWidth / tier.velocityDivisor), 32);
    const vh = Math.max(Math.round(cssHeight / tier.velocityDivisor), 32);
    const dw = Math.max(Math.round(cssWidth / tier.dyeDivisor), 32);
    const dh = Math.max(Math.round(cssHeight / tier.dyeDivisor), 32);

    [velocity, pressure, divergence, dyeField, volumeTarget].forEach(dispose);
    velocity = makePair(vw, vh, gl.RG16F, gl.RG, gl.HALF_FLOAT, gl.LINEAR);
    pressure = makePair(vw, vh, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.NEAREST);
    divergence = makeTarget(vw, vh, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.NEAREST);
    dyeField = makePair(dw, dh, gl.RG16F, gl.RG, gl.HALF_FLOAT, gl.LINEAR);
    /* The march is the expensive pass, so it runs well below display resolution
       and is upsampled. Volumetric gas is soft enough that the difference does
       not show, which is the only reason the whole thing fits in frame. */
    volumeTarget = makeTarget(
      Math.max(Math.round(cssWidth / tier.volumeDivisor), 32),
      Math.max(Math.round(cssHeight / tier.volumeDivisor), 32),
      gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);

    dispose(particles);
    particles = null;
    if (fullFloat) {
      const side = Math.max(Math.round(Math.sqrt(tier.particles)), 8);
      particleCount = side * side;
      const seeds = new Float32Array(particleCount * 4);
      for (let i = 0; i < particleCount; i++) {
        seeds[i * 4] = Math.random();
        seeds[i * 4 + 1] = Math.random();
        seeds[i * 4 + 2] = Math.random();
        seeds[i * 4 + 3] = Math.random();
      }
      particles = makePair(side, side, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST);
      for (const target of [particles.read, particles.write]) {
        gl.bindTexture(gl.TEXTURE_2D, target.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, side, side, 0, gl.RGBA, gl.FLOAT, seeds);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  const pointer = { x: .5, y: .5, vx: 0, vy: 0, active: 0, radiusPx: 46, moved: 0 };

  function use(entry, target) {
    gl.useProgram(entry.program);
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
    }
  }
  function set(entry, name, ...values) {
    const location = entry.location(name);
    if (!location) return;
    if (values.length === 1) gl.uniform1f(location, values[0]);
    else if (values.length === 2) gl.uniform2f(location, values[0], values[1]);
    else gl.uniform3f(location, values[0], values[1], values[2]);
  }
  function bindVolume(entry, name, texture, unit) {
    const location = entry.location(name);
    if (!location) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.uniform1i(location, unit);
  }
  function bind(entry, name, texture, unit) {
    const location = entry.location(name);
    if (!location) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(location, unit);
  }
  function solidUniforms(entry) {
    set(entry, 'u_pointer', pointer.x, pointer.y);
    set(entry, 'u_pointerVelocity', pointer.vx, pointer.vy);
    set(entry, 'u_pointerRadius', pointer.active ? pointer.radiusPx / window.innerHeight : 0);
    set(entry, 'u_pointerActive', pointer.active);
    set(entry, 'u_aspect', aspect);
  }
  function draw() {
    gl.bindVertexArray(quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  const WIND = coarse ? [8, -1.4] : [13, -2.2];
  let elapsed = 0;

  /* The camera. Lateral position and the look of the gas ease toward whichever
     vantage owns the section crossing the viewport centre; depth is driven
     straight off scroll position so travel always matches the page. */
  const camera = { x: 0, y: 0, z: 0 };
  const view = { x: 0, y: 0, density: 1.4, threshold: .47, opacity: 1 };
  const vantage = { ...view };
  let scrollDepth = 0;

  function readScroll() {
    const range = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
    scrollDepth = Math.min(Math.max(window.scrollY / range, 0), 1) * TRAVEL;
  }

  function watchVantages() {
    const stops = planFlight();
    if (!stops.length) return;
    /* The opening view is the first stop, so the page never eases away from a
       vantage it was never at. */
    Object.assign(vantage, stops[0]);
    Object.assign(view, stops[0]);
    if (!('IntersectionObserver' in window)) return;
    const lookup = new Map(stops.map((stop) => [stop.element, stop]));
    /* A deep negative margin leaves only the band across the viewport centre
       active, so exactly one section is ever the current vantage - and during a
       travel gap the last one simply holds until the next arrives. */
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) Object.assign(vantage, lookup.get(entry.target));
      }
    }, { rootMargin: '-45% 0px -45% 0px' });
    for (const stop of stops) observer.observe(stop.element);
  }

  function moveCamera(dt) {
    const ease = 1 - Math.exp(-1.7 * dt);
    view.x += (vantage.x - view.x) * ease;
    view.y += (vantage.y - view.y) * ease;
    view.density += (vantage.density - view.density) * ease;
    view.threshold += (vantage.threshold - view.threshold) * ease;
    view.opacity += (vantage.opacity - view.opacity) * ease;
    camera.x = view.x;
    camera.y = view.y;
    /* Smoothed rather than snapped, so a flung scroll glides instead of
       jerking the whole sky. */
    camera.z += (scrollDepth - camera.z) * (1 - Math.exp(-4.5 * dt));
  }

  /* The wind is set in velocity-grid texels per second; every sampled pattern needs it in
     screen uv per second to travel at the same rate the gas does. */
  function drift(entry, fraction) {
    set(entry, 'u_drift',
      WIND[0] / velocity.read.width * fraction,
      WIND[1] / velocity.read.height * fraction);
    set(entry, 'u_time', elapsed);
  }

  function step(dt) {
    elapsed += dt;
    moveCamera(dt);
    /* The obstacle drags gas with it, but only while it is actually moving. Without this
       decay the last mouse sample keeps blasting the field long after the cursor stops. */
    const settle = Math.exp(-7 * dt);
    pointer.vx *= settle;
    pointer.vy *= settle;
    gl.disable(gl.BLEND);

    let entry = programs.forces;
    use(entry, velocity.write);
    bind(entry, 'u_velocity', velocity.read.texture, 0);
    set(entry, 'u_wind', WIND[0], WIND[1]);
    set(entry, 'u_stir', 8.5);
    set(entry, 'u_relax', .38);
    set(entry, 'u_dt', dt);
    set(entry, 'u_aspect', aspect);
    drift(entry, .85);
    draw();
    velocity.swap();

    entry = programs.advect;
    use(entry, velocity.write);
    bind(entry, 'u_source', velocity.read.texture, 0);
    bind(entry, 'u_velocity', velocity.read.texture, 1);
    set(entry, 'u_velocityTexel', velocity.read.texel[0], velocity.read.texel[1]);
    set(entry, 'u_dt', dt);
    set(entry, 'u_dissipation', Math.exp(-.12 * dt));
    draw();
    velocity.swap();

    entry = programs.divergence;
    use(entry, divergence);
    bind(entry, 'u_velocity', velocity.read.texture, 0);
    set(entry, 'u_texel', velocity.read.texel[0], velocity.read.texel[1]);
    solidUniforms(entry);
    draw();

    gl.bindFramebuffer(gl.FRAMEBUFFER, pressure.read.framebuffer);
    gl.clear(gl.COLOR_BUFFER_BIT);
    entry = programs.pressure;
    for (let i = 0; i < tier.iterations; i++) {
      use(entry, pressure.write);
      bind(entry, 'u_pressure', pressure.read.texture, 0);
      bind(entry, 'u_divergence', divergence.texture, 1);
      set(entry, 'u_texel', velocity.read.texel[0], velocity.read.texel[1]);
      solidUniforms(entry);
      draw();
      pressure.swap();
    }

    entry = programs.gradient;
    use(entry, velocity.write);
    bind(entry, 'u_pressure', pressure.read.texture, 0);
    bind(entry, 'u_velocity', velocity.read.texture, 1);
    set(entry, 'u_texel', velocity.read.texel[0], velocity.read.texel[1]);
    solidUniforms(entry);
    draw();
    velocity.swap();

    entry = programs.dye;
    use(entry, dyeField.write);
    bind(entry, 'u_source', dyeField.read.texture, 0);
    bind(entry, 'u_velocity', velocity.read.texture, 1);
    set(entry, 'u_velocityTexel', velocity.read.texel[0], velocity.read.texel[1]);
    set(entry, 'u_dt', dt);
    set(entry, 'u_dissipation', Math.exp(-.3 * dt));
    set(entry, 'u_feed', .55);
    solidUniforms(entry);
    drift(entry, .5);
    draw();
    dyeField.swap();

    if (particles) {
      entry = programs.particleStep;
      use(entry, particles.write);
      bind(entry, 'u_particles', particles.read.texture, 0);
      bind(entry, 'u_velocity', velocity.read.texture, 1);
      set(entry, 'u_velocityTexel', velocity.read.texel[0], velocity.read.texel[1]);
      set(entry, 'u_dt', dt);
      set(entry, 'u_speed', 1);
      set(entry, 'u_time', elapsed);
      solidUniforms(entry);
      draw();
      particles.swap();
    }
  }

  /* Draw order is the depth cue, and it now spans real depth:

       distant sky    flat, no parallax - stars that far away do not move
       flying stars   perspective, sweeping outward as the camera advances
       volume         the raymarched nebula the camera travels through
       fluid dust     near-field motes riding the 2D solver
       fluid sheet    the near gas, and the layer the cursor disturbs

     Each composites over the last, so a dense cloud genuinely dims everything
     behind it rather than the layers merely stacking brightest-last. */
  function present() {
    const pointScale = Math.max(width / window.innerWidth, 1);

    if (volumeTexture) {
      const march = programs.volumeMarch;
      use(march, volumeTarget);
      gl.disable(gl.BLEND);
      bindVolume(march, 'u_volume', volumeTexture, 0);
      set(march, 'u_camera', camera.x, camera.y, camera.z);
      set(march, 'u_aspect', aspect);
      set(march, 'u_fov', .72);
      set(march, 'u_near', .45);
      set(march, 'u_far', 11.5);
      set(march, 'u_steps', tier.volumeSteps);
      set(march, 'u_density', view.density * 1.5);
      set(march, 'u_emission', 2.1);
      set(march, 'u_threshold', view.threshold);
      set(march, 'u_opacity', view.opacity * (coarse ? .6 : 1));
      set(march, 'u_time', elapsed);
      draw();
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    let entry = programs.stars;
    use(entry, null);
    set(entry, 'u_pointScale', pointScale);
    set(entry, 'u_opacity', coarse ? .38 : .62);
    gl.bindVertexArray(skyVao);
    gl.drawArrays(gl.POINTS, 0, SKY_COUNT);

    entry = programs.flyStars;
    use(entry, null);
    set(entry, 'u_camera', camera.x, camera.y, camera.z);
    set(entry, 'u_aspect', aspect);
    set(entry, 'u_pointScale', pointScale);
    set(entry, 'u_depth', 13);
    set(entry, 'u_near', 1.1);
    set(entry, 'u_ref', 5.5);
    set(entry, 'u_flow', 1);
    set(entry, 'u_parallax', 1);
    set(entry, 'u_opacity', coarse ? .5 : .92);
    gl.bindVertexArray(flyVao);
    gl.drawArrays(gl.POINTS, 0, FLY_COUNT);

    if (volumeTexture) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      entry = programs.blit;
      use(entry, null);
      bind(entry, 'u_source', volumeTarget.texture, 0);
      draw();
    }

    if (particles) {
      gl.blendFunc(gl.ONE, gl.ONE);
      entry = programs.particleDraw;
      use(entry, null);
      bind(entry, 'u_particles', particles.read.texture, 0);
      set(entry, 'u_pointScale', pointScale * 1.9);
      set(entry, 'u_opacity', coarse ? .2 : .32);
      gl.bindVertexArray(pointVao);
      gl.drawArrays(gl.POINTS, 0, particleCount);
    }

    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    entry = programs.display;
    use(entry, null);
    bind(entry, 'u_dye', dyeField.read.texture, 0);
    bind(entry, 'u_velocity', velocity.read.texture, 1);
    set(entry, 'u_velocityTexel', velocity.read.texel[0], velocity.read.texel[1]);
    set(entry, 'u_dyeTexel', dyeField.read.texel[0], dyeField.read.texel[1]);
    set(entry, 'u_aspect', aspect);
    /* The volume now carries the bulk of the nebula, so the 2D sheet steps back
       to a near-field veil: thin enough not to fight the depth behind it, present
       enough to still show the cursor's wake. */
    set(entry, 'u_opacity', coarse ? .22 : .38);
    set(entry, 'u_warp', 2.4);
    drift(entry, .8);
    draw();
    gl.disable(gl.BLEND);
  }

  /* Seed the field before the first visible frame so the page never fades in on an
     empty background. */
  function warmup(steps) {
    for (let i = 0; i < steps; i++) step(1 / 30);
    present();
  }

  let frame = 0;
  let last = 0;
  let paused = stillMotion.matches;
  let visible = true;
  let samples = 0;
  let accumulated = 0;

  function tick(now) {
    const dt = last ? Math.min((now - last) / 1000, 1 / 24) : 1 / 60;
    if (last) {
      accumulated += now - last;
      samples++;
      if (samples >= 140) {
        if (accumulated / samples > 21 && tierIndex < TIERS.length - 1) {
          tierIndex++;
          tier = TIERS[tierIndex];
          allocate();
          warmup(20);
        }
        samples = 0;
        accumulated = 0;
      }
    }
    last = now;
    step(dt);
    present();
    frame = requestAnimationFrame(tick);
  }
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
  }
  function play() {
    if (frame || paused || !visible || document.hidden || !started) return;
    samples = 0;
    accumulated = 0;
    frame = requestAnimationFrame(tick);
  }

  let resizeTimer = 0;
  let lastWidth = 0;
  let lastHeight = 0;
  function onResize() {
    /* Mobile browsers resize the viewport as the URL bar hides. Reallocating every
       texture for that would throw the whole field away mid-scroll. */
    if (window.innerWidth === lastWidth && Math.abs(window.innerHeight - lastHeight) < 130) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      lastWidth = window.innerWidth;
      lastHeight = window.innerHeight;
      allocate();
      warmup(paused ? 26 : 8);
    }, 160);
  }

  window.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') { pointer.active = 0; return; }
    const x = event.clientX / window.innerWidth;
    const y = 1 - event.clientY / window.innerHeight;
    const now = performance.now();
    if (pointer.active && pointer.moved) {
      /* Screen travel per second, expressed in the velocity grid's own units, so a brisk
         flick reads as a strong gust and a slow drift barely disturbs the field. */
      const seconds = Math.max((now - pointer.moved) / 1000, 1 / 240);
      const grid = velocity ? velocity.read.width : 300;
      const limit = 85;
      pointer.vx = Math.max(Math.min((x - pointer.x) / seconds * grid, limit), -limit);
      pointer.vy = Math.max(Math.min((y - pointer.y) / seconds * grid, limit), -limit);
    }
    pointer.x = x;
    pointer.y = y;
    pointer.moved = now;
    pointer.active = 1;
  }, { passive: true });
  document.addEventListener('pointerleave', () => { pointer.active = 0; pointer.vx = 0; pointer.vy = 0; });
  window.addEventListener('blur', () => { pointer.active = 0; });
  window.addEventListener('resize', onResize, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else play(); });

  const controller = {
    lost: false,
    setPaused(value) {
      paused = value;
      if (paused) { stop(); present(); } else play();
    },
    setVisible(value) {
      visible = value;
      if (visible) play(); else stop();
    },
  };

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    stop();
    controller.lost = true;
    document.documentElement.classList.remove('nebula-active');
  });

  window.addEventListener('scroll', readScroll, { passive: true });

  lastWidth = window.innerWidth;
  lastHeight = window.innerHeight;
  allocate();
  volumeTexture = bakeVolume();
  readScroll();
  camera.z = scrollDepth;
  watchVantages();
  started = true;
  warmup(paused ? 40 : 26);
  play();
  return controller;
}
