// Model3D surface-height bake consumed by object_fog.frag. R/G store the
// high/low bytes of a 16-bit height above the model floor; A marks coverage.
// XZ is reconstructed from the final screen pixel and the map camera, so
// rescaling/anchoring a bake cannot open cloud seams at the ground contact.
// The companion .vert is a stub: mkxp-z's Shader class compiles the fragment
// for its sprite/viewport programs at construction, while Model3D#shader=
// ignores the sibling vertex file and renders with the engine's model3d.vert,
// which supplies the real v_fragPos.
varying vec2 v_texCoord;
varying vec3 v_fragPos;

uniform float u_heightScale;
uniform float u_heightBase;

void main() {
    float height = clamp((v_fragPos.y - u_heightBase) * u_heightScale, 0.0, 1.0);
    float packedHeight = floor(height * 65535.0 + 0.5);
    float highByte = floor(packedHeight / 256.0);
    gl_FragColor = vec4(highByte / 255.0,
        (packedHeight - highByte * 256.0) / 255.0, 0.0, 1.0);
}
